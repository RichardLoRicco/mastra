# Codex Datadog Exporter Implementation Plan

## High-Level Overview

- Goal: add a Datadog LLM Observability exporter for Mastra that preserves span hierarchy, timing, and rich metadata while remaining robust in long-running agent/workflow executions.
- Integration choice: use the `dd-trace` SDK (LLMObs) rather than the HTTP intake. The SDK handles batching, retries, context propagation, and matches Mastra’s Node environment.
- Lifecycle model: keep spans open using a guarded deferred-promise bridge so `llmobs.trace` can end spans at the right time, with timeouts and shutdown drainage to avoid leaks. Datadog ingests spans at end-time, but keeping them open preserves accurate duration/parenting and future-proofs for any live features.

## Alternatives Considered (and Why Not Chosen)

- **Completion-only export (OTel-style)**: buffer Mastra span data and send once on `span_ended`. Simpler and no long-lived state, but loses accurate parent/child context (LLMObs builds trees from active scopes) and relies entirely on delayed timestamps. Rejected to keep hierarchy/duration fidelity.
- **Coalesced updates (start span then end immediately; emit children as zero-duration spans)**: avoids deferred promises but produces misleading durations and broken trees. Rejected for correctness.
- **Pure function wrapping**: impossible because Mastra emits discrete lifecycle events rather than executing user functions inside the exporter. Rejected as incompatible.

## Implementation

### Types, Config, and Constants

**What/Why:** Define config surface, span kind mapping, and utility types. Enforce required Datadog knobs (mlApp, apiKey when agentless).

```ts
import tracer from 'dd-trace';
import type {
  TracingEvent,
  AnyExportedSpan,
  ModelGenerationAttributes,
  TracingEventType,
} from '@mastra/core/observability';
import { SpanType } from '@mastra/core/observability';
import { BaseExporter } from '@mastra/observability';
import type { BaseExporterConfig } from '@mastra/observability';

// Config surface for users
export interface DatadogExporterConfig extends BaseExporterConfig {
  apiKey?: string;
  mlApp?: string;
  site?: string;
  service?: string;
  env?: string;
  agentless?: boolean;
  integrationsEnabled?: boolean;
  defaultUserId?: string;
  defaultSessionId?: string;
  maxSpanMillis?: number; // guardrail timeout
}

// Datadog span kinds
type DatadogSpanKind = 'llm' | 'agent' | 'workflow' | 'tool' | 'task' | 'retrieval' | 'embedding';

// Mapping from Mastra span types
const SPAN_TYPE_TO_KIND: Record<SpanType, DatadogSpanKind> = {
  [SpanType.AGENT_RUN]: 'agent',
  [SpanType.MODEL_GENERATION]: 'llm',
  [SpanType.MODEL_STEP]: 'llm',
  [SpanType.TOOL_CALL]: 'tool',
  [SpanType.MCP_TOOL_CALL]: 'tool',
  [SpanType.WORKFLOW_RUN]: 'workflow',
  [SpanType.WORKFLOW_STEP]: 'task',
  [SpanType.WORKFLOW_CONDITIONAL]: 'task',
  [SpanType.WORKFLOW_CONDITIONAL_EVAL]: 'task',
  [SpanType.WORKFLOW_PARALLEL]: 'task',
  [SpanType.WORKFLOW_LOOP]: 'task',
  [SpanType.WORKFLOW_SLEEP]: 'task',
  [SpanType.WORKFLOW_WAIT_EVENT]: 'task',
  [SpanType.PROCESSOR_RUN]: 'task',
  [SpanType.MODEL_CHUNK]: 'task',
  [SpanType.GENERIC]: 'task',
};

// Internal bookkeeping
interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
}

interface DeferredSpan {
  span: any; // dd-trace LLMObs span
  resolve: () => void;
  reject: (error: Error) => void;
  spanType: SpanType;
  startTime: Date;
  timeoutAt?: number;
}

interface TraceData {
  spans: Map<string, DeferredSpan>;
  userId?: string;
  sessionId?: string;
  rootSpanId?: string;
  activeSpanCount: number;
}
```

**Line-by-line:**

- Imports Mastra tracing types and BaseExporter for consistency with other exporters.
- `DatadogExporterConfig` adds Datadog knobs and `maxSpanMillis` as a safety timeout.
- `SPAN_TYPE_TO_KIND` normalizes Mastra span taxonomy to Datadog’s accepted kinds.
- `Deferred`/`DeferredSpan` hold the dd-trace span and its lifecycle controls; `timeoutAt` lets us auto-close long spans.
- `TraceData` tracks per-trace user/session data and active spans for cleanup.

### Tracer Bootstrap

**What/Why:** Initialize `dd-trace` once, respect existing tracer init, and enable LLMObs with resolved config.

```ts
const tracerInitialized = { done: false };

function ensureTracer(
  config: DatadogExporterConfig & { mlApp: string; site: string; apiKey?: string; agentless: boolean },
) {
  if (tracerInitialized.done) return;

  // Avoid breaking apps that already called dd-trace/init
  const alreadyStarted = (tracer as any)._tracer?.started;
  if (!alreadyStarted) {
    tracer.init({
      service: config.service || config.mlApp,
      env: config.env || process.env.DD_ENV,
      plugins: config.integrationsEnabled ?? false,
    });
  }

  tracer.llmobs.enable({
    mlApp: config.mlApp,
    agentlessEnabled: config.agentless,
    site: config.site,
    apiKey: config.apiKey,
  });

  tracerInitialized.done = true;
}
```

**Line-by-line:**

- `tracerInitialized` prevents multiple init calls.
- `alreadyStarted` check avoids clobbering user’s existing dd-trace setup.
- `tracer.init` sets service/env and keeps plugins off by default to avoid auto-instrumentation surprises.
- `llmobs.enable` turns on LLM Observability with agentless/site/API key options.

### Helpers

**What/Why:** Small utilities used across handlers: deferred creation, span kind mapping, usage normalization, and input/output/metadata formatting into Datadog’s expected fields.

```ts
function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (v?: T | PromiseLike<T>) => void;
  let reject!: (r?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as any;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mapKind = (spanType: SpanType): DatadogSpanKind => SPAN_TYPE_TO_KIND[spanType] || 'task';

function normalizeUsage(usage?: ModelGenerationAttributes['usage']) {
  if (!usage) return;
  const inputTokens = usage.inputTokens ?? usage.promptTokens;
  const outputTokens = usage.outputTokens ?? usage.completionTokens;
  const totalTokens =
    usage.totalTokens ??
    (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens: usage.reasoningTokens,
    cachedInputTokens: usage.cachedInputTokens ?? usage.promptCacheHitTokens,
  };
}

function formatInput(input: any, spanType: SpanType) {
  if (spanType === SpanType.MODEL_GENERATION || spanType === SpanType.MODEL_STEP) {
    if (Array.isArray(input) && input.every(m => m && m.role && m.content !== undefined)) {
      return input.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : safeStringify(m.content),
      }));
    }
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    return [{ role: 'user', content: safeStringify(input) }];
  }
  if (typeof input === 'string' || Array.isArray(input)) return input;
  return safeStringify(input);
}

function formatOutput(output: any, spanType: SpanType) {
  if (spanType === SpanType.MODEL_GENERATION || spanType === SpanType.MODEL_STEP) {
    if (Array.isArray(output) && output.every(m => m && m.role && m.content !== undefined)) {
      return output.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : safeStringify(m.content),
      }));
    }
    if (typeof output === 'string') return [{ role: 'assistant', content: output }];
    if (output?.text) return [{ role: 'assistant', content: output.text }];
    return [{ role: 'assistant', content: safeStringify(output) }];
  }
  if (typeof output === 'string') return output;
  return safeStringify(output);
}

function formatMetadata(metadata?: Record<string, any>) {
  if (!metadata) return undefined;
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedKey, nestedVal] of Object.entries(value)) {
        if (nestedVal !== undefined && nestedVal !== null) tags[`${key}.${nestedKey}`] = String(nestedVal);
      }
    } else {
      tags[key] = String(value);
    }
  }
  if (metadata.userId) tags['user.id'] = String(metadata.userId);
  if (metadata.sessionId) tags['session.id'] = String(metadata.sessionId);
  return tags;
}

function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    if (typeof data === 'object' && data !== null) {
      return `[Non-serializable ${data.constructor?.name || 'Object'}]`;
    }
    return String(data);
  }
}
```

**Line-by-line:**

- `createDeferred` exposes resolve/reject so `llmobs.trace` can keep spans open until Mastra ends them.
- `mapKind` converts Mastra span types to Datadog kinds.
- `normalizeUsage` merges AI SDK v4/v5 token shapes into one structure for metrics.
- `formatInput/output` normalize LLM messages into `{ role, content }` arrays; non-LLM spans are stringified as needed.
- `formatMetadata` flattens metadata and adds `user.id`/`session.id` tags for Datadog searchability.
- `safeStringify` guards against circular data.

### Datadog Exporter Class

**What/Why:** Core bridge from Mastra events to Datadog LLMObs spans using the deferred pattern with guardrails.

```ts
export class DatadogExporter extends BaseExporter {
  name = 'datadog';
  private config: Required<Pick<DatadogExporterConfig, 'mlApp' | 'site'>> & DatadogExporterConfig;
  private traceMap = new Map<string, TraceData>();
  private spanMap = new Map<string, DeferredSpan>();

  constructor(config: DatadogExporterConfig) {
    super(config);

    const mlApp = config.mlApp || process.env.DD_LLMOBS_ML_APP;
    const apiKey = config.apiKey || process.env.DD_API_KEY;
    const site = config.site || process.env.DD_SITE || 'datadoghq.com';
    const agentless =
      config.agentless ?? ['true', '1'].includes((process.env.DD_LLMOBS_AGENTLESS_ENABLED || '').toLowerCase());

    if (!mlApp) {
      this.setDisabled('Missing required mlApp (set config.mlApp or DD_LLMOBS_ML_APP)');
      this.config = config as any;
      return;
    }
    if (agentless && !apiKey) {
      this.setDisabled('Agentless mode requires apiKey (config.apiKey or DD_API_KEY)');
      this.config = config as any;
      return;
    }

    this.config = { ...config, mlApp, site, apiKey, agentless };
    ensureTracer({ ...this.config, agentless, mlApp, site });
    this.logger.info('Datadog exporter initialized', { mlApp, site, agentless });
  }

  protected async _exportTracingEvent(event: TracingEvent): Promise<void> {
    if (this.isDisabled || !(tracer as any).llmobs) return;
    const span = event.exportedSpan;

    // Event spans are instantaneous
    if (span.isEvent) {
      if (event.type === TracingEventType.SPAN_STARTED) await this.handleEventSpan(span);
      return;
    }

    switch (event.type) {
      case TracingEventType.SPAN_STARTED:
        return this.handleSpanStarted(span);
      case TracingEventType.SPAN_UPDATED:
        return this.handleSpanUpdated(span);
      case TracingEventType.SPAN_ENDED:
        return this.handleSpanEnded(span);
    }
  }

  private handleSpanStarted(span: AnyExportedSpan): void {
    if (span.isRootSpan) this.initializeTrace(span);
    const traceData = this.traceMap.get(span.traceId);
    if (!traceData) {
      this.logger.warn('No trace data for started span', { traceId: span.traceId, spanId: span.id });
      return;
    }

    const deferred = createDeferred<void>();
    const kind = mapKind(span.type);
    const options = this.buildSpanOptions(span, kind, traceData);

    const parent = span.parentSpanId ? traceData.spans.get(span.parentSpanId)?.span : undefined;
    const scope = tracer.scope();
    const run = () =>
      tracer.llmobs.trace(options, async ddSpan => {
        const deferredSpan: DeferredSpan = {
          span: ddSpan,
          resolve: () => deferred.resolve(),
          reject: (err: Error) => deferred.reject(err),
          spanType: span.type,
          startTime: new Date(span.startTime),
          timeoutAt: this.config.maxSpanMillis ? Date.now() + this.config.maxSpanMillis : undefined,
        };

        this.spanMap.set(span.id, deferredSpan);
        traceData.spans.set(span.id, deferredSpan);
        traceData.activeSpanCount++;

        const annotations: Record<string, any> = {};
        if (span.input !== undefined) annotations.input = formatInput(span.input, span.type);
        if (span.metadata) annotations.metadata = formatMetadata(span.metadata);
        if (Object.keys(annotations).length) tracer.llmobs.annotate(ddSpan, annotations);

        await deferred.promise;
      });

    parent ? scope.activate(parent, run) : run();
    this.logger.debug('Span started', { traceId: span.traceId, spanId: span.id, kind });
  }

  private handleSpanUpdated(span: AnyExportedSpan): void {
    const deferredSpan = this.spanMap.get(span.id);
    if (!deferredSpan) return;
    const annotations: Record<string, any> = {};
    if (span.input !== undefined) annotations.input = formatInput(span.input, span.type);
    if (span.output !== undefined) annotations.output = formatOutput(span.output, span.type);
    if (span.metadata) annotations.metadata = formatMetadata(span.metadata);
    if (Object.keys(annotations).length) tracer.llmobs.annotate(deferredSpan.span, annotations);
  }

  private handleSpanEnded(span: AnyExportedSpan): void {
    const deferredSpan = this.spanMap.get(span.id);
    const traceData = this.traceMap.get(span.traceId);
    if (!deferredSpan || !traceData) {
      this.logger.warn('No span/trace found on end', { traceId: span.traceId, spanId: span.id });
      return;
    }

    const annotations: Record<string, any> = {};
    if (span.output !== undefined) annotations.output = formatOutput(span.output, span.type);
    const usage = (span.attributes as ModelGenerationAttributes | undefined)?.usage;
    const normalized = normalizeUsage(usage);
    if (normalized) annotations.metrics = normalized;
    if (span.errorInfo) {
      annotations.tags = {
        ...(annotations.tags || {}),
        error: 'true',
        'error.message': span.errorInfo.message,
        ...(span.errorInfo.category ? { 'error.category': span.errorInfo.category } : {}),
      };
    }
    if (Object.keys(annotations).length) tracer.llmobs.annotate(deferredSpan.span, annotations);

    // Guardrail: auto-resolve if hung
    if (deferredSpan.timeoutAt && Date.now() > deferredSpan.timeoutAt) {
      this.logger.warn('Auto-resolving hung span', { spanId: span.id, traceId: span.traceId });
      deferredSpan.resolve();
    }

    span.errorInfo ? deferredSpan.reject(new Error(span.errorInfo.message)) : deferredSpan.resolve();

    this.spanMap.delete(span.id);
    traceData.spans.delete(span.id);
    traceData.activeSpanCount--;
    if (traceData.activeSpanCount === 0) this.traceMap.delete(span.traceId);
    this.logger.debug('Span ended', { traceId: span.traceId, spanId: span.id });
  }

  private handleEventSpan(span: AnyExportedSpan): void {
    if (span.isRootSpan) this.initializeTrace(span);
    const traceData = this.traceMap.get(span.traceId);
    if (!traceData) return;
    const kind = mapKind(span.type);
    const options = this.buildSpanOptions(span, kind, traceData);
    tracer.llmobs.trace(options, ddSpan => {
      const annotations: Record<string, any> = {};
      if (span.input !== undefined) annotations.input = formatInput(span.input, span.type);
      if (span.output !== undefined) annotations.output = formatOutput(span.output, span.type);
      if (span.metadata) annotations.metadata = formatMetadata(span.metadata);
      if (Object.keys(annotations).length) tracer.llmobs.annotate(ddSpan, annotations);
    });
  }

  private initializeTrace(span: AnyExportedSpan): void {
    const traceData: TraceData = {
      spans: new Map(),
      userId: span.metadata?.userId || this.config.defaultUserId,
      sessionId: span.metadata?.sessionId || this.config.defaultSessionId,
      rootSpanId: span.id,
      activeSpanCount: 0,
    };
    this.traceMap.set(span.traceId, traceData);
  }

  private buildSpanOptions(span: AnyExportedSpan, kind: DatadogSpanKind, traceData: TraceData) {
    const options: Record<string, any> = {
      kind,
      name: span.name,
      sessionId: traceData.sessionId,
      userId: traceData.userId,
      startTime: span.startTime instanceof Date ? span.startTime : new Date(span.startTime),
    };
    if (kind === 'llm') {
      const attrs = span.attributes as ModelGenerationAttributes | undefined;
      if (attrs?.model) options.modelName = attrs.model;
      if (attrs?.provider) options.modelProvider = attrs.provider;
    }
    return options;
  }

  async shutdown(): Promise<void> {
    for (const [spanId, deferredSpan] of this.spanMap.entries()) {
      this.logger.warn('Resolving pending span on shutdown', { spanId });
      deferredSpan.resolve();
    }
    this.spanMap.clear();
    this.traceMap.clear();
    if (tracer.llmobs?.flush) {
      try {
        await tracer.llmobs.flush();
      } catch (e) {
        this.logger.error('Error flushing llmobs', { error: e });
      }
    } else if ((tracer as any).flush) {
      try {
        await (tracer as any).flush();
      } catch (e) {
        this.logger.error('Error flushing tracer', { error: e });
      }
    }
    if (tracer.llmobs?.disable) {
      try {
        tracer.llmobs.disable();
      } catch (e) {
        this.logger.error('Error disabling llmobs', { error: e });
      }
    }
    await super.shutdown();
  }
}
```

**Line-by-line highlights:**

- Constructor resolves config/env and disables early if required fields are missing; `ensureTracer` enables LLMObs once.
- `_exportTracingEvent` routes Mastra events; skips work when disabled or LLMObs is unavailable.
- `handleSpanStarted` sets up trace state, builds span options, and uses a deferred promise so the span stays open. Parent dd-span (if exists) is activated via `scope.activate` to preserve hierarchy.
- `handleSpanUpdated` applies incremental annotations for input/output/metadata.
- `handleSpanEnded` adds output, metrics, and error tags, then resolves/rejects the deferred span; cleans up maps; includes a hung-span guard based on `maxSpanMillis`.
- `handleEventSpan` creates zero-duration spans for event-type spans with immediate annotations.
- `initializeTrace` seeds per-trace defaults (user/session) for tagging.
- `buildSpanOptions` assembles LLMObs options including model info and start time for accurate durations.
- `shutdown` resolves any pending spans, flushes if available, disables LLMObs, and calls base shutdown.

### Testing Strategy

**What/Why:** Ensure mapping, lifecycle, and guardrails work without hitting Datadog.

- Mock `dd-trace` LLMObs methods (`trace`, `annotate`, `flush`, `enable`, `disable`) before importing the exporter.
- Unit tests:
  - Constructor disables when `mlApp` missing or agentless without `apiKey`.
  - Span type mapping emits correct `kind`/model fields.
  - Usage normalization handles v4/v5 token shapes.
  - Parent scope activation: child span creation happens with parent span in scope.
  - Error spans reject and annotate error tags.
  - Timeout guard auto-resolves hung spans when `maxSpanMillis` set.
  - Shutdown flushes and resolves pending spans.

### Usage Example

**What/Why:** Show minimal integration into Mastra observability config.

```ts
import { Mastra } from '@mastra/core';
import { DatadogExporter } from '@mastra/datadog';

const datadog = new DatadogExporter({
  mlApp: 'my-app',
  agentless: true,
  apiKey: process.env.DD_API_KEY,
  site: 'datadoghq.com',
  env: 'production',
  maxSpanMillis: 5 * 60 * 1000,
});

const mastra = new Mastra({
  observability: {
    configs: {
      default: {
        serviceName: 'my-service',
        exporters: [datadog],
      },
    },
  },
});
```

**Line-by-line:**

- Import and construct the exporter with mlApp/site/apiKey and optional safety timeout.
- Register it in Mastra’s observability config; all spans will be forwarded to Datadog LLMObs.

## Why This Approach

- Preserves hierarchy and timing by keeping spans open, which Datadog relies on for accurate trees, while accepting that visibility occurs at span end.
- Adds guardrails (timeouts, shutdown drain) to mitigate deferred-promise risks.
- Keeps the config surface familiar and matches patterns from existing exporters (Langfuse/PostHog) for easy adoption.
