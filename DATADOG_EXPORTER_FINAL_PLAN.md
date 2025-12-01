# Datadog LLM Observability Exporter - Final Implementation Plan

## Executive Summary

This document presents the finalized implementation plan for the Datadog LLM Observability exporter for Mastra's observability system. After analyzing two competing approaches (Deferred Promise Pattern vs Completion-Only Pattern), we recommend the **Enhanced Completion-Only Pattern** based on the following key insight:

> **Datadog LLM Observability only ingests and displays spans when they complete.** Mid-span visibility is not supported, making the complexity of keeping spans "open" via deferred promises unnecessary.

### GitHub Issue Reference

[mastra-ai/mastra#6182](https://github.com/mastra-ai/mastra/issues/6182)

---

## Table of Contents

1. [Decision Rationale](#1-decision-rationale)
2. [Architecture Overview](#2-architecture-overview)
3. [Data Model Mapping](#3-data-model-mapping)
4. [Package Structure](#4-package-structure)
5. [Configuration Interface](#5-configuration-interface)
6. [Core Implementation](#6-core-implementation)
7. [Helper Functions](#7-helper-functions)
8. [Evaluation Scoring Support](#8-evaluation-scoring-support)
9. [Monorepo Integration](#9-monorepo-integration)
10. [Complete Implementation](#10-complete-implementation)
11. [Testing Strategy](#11-testing-strategy)
12. [Usage Examples](#12-usage-examples)
13. [Future Considerations](#13-future-considerations)

---

## 1. Decision Rationale

### Why Completion-Only Over Deferred Promises?

| Criteria                   | Deferred Promise                | Completion-Only                   | Winner           |
| -------------------------- | ------------------------------- | --------------------------------- | ---------------- |
| **Complexity**             | High (maps, promises, timeouts) | Low (minimal state)               | Completion-Only  |
| **Memory Safety**          | Risk of leaked promises         | No leak risk                      | Completion-Only  |
| **Datadog Compatibility**  | Works, but over-engineered      | Matches Datadog's actual behavior | Completion-Only  |
| **Shutdown Complexity**    | Must drain pending promises     | Simple flush and disable          | Completion-Only  |
| **Mid-span Visibility**    | Not supported by Datadog        | Not supported by Datadog          | Tie              |
| **Parent-Child Hierarchy** | Better scope management         | Requires enhancement              | Deferred Promise |
| **Testing**                | Complex mocking                 | Simple mocking                    | Completion-Only  |
| **Maintenance**            | Higher cognitive load           | Lower cognitive load              | Completion-Only  |

### The Critical Insight

Datadog's LLM Observability product operates on a **completion-based model**:

- Spans are buffered locally until `llmobs.trace()` callback returns
- `llmobs.annotate()` updates are applied to the local buffer
- Data is sent to Datadog's intake on span completion
- The UI renders traces only after all spans complete

This means the deferred promise pattern's complexity provides **zero user-visible benefit**.

### Enhancements to Base Completion-Only Pattern

We enhance the base completion-only pattern with:

1. **Span hierarchy tracking** via `spanId → ddSpanContext` map for parent linkage
2. **Robust error handling** with error tags, messages, and categories
3. **AI SDK v4/v5 token normalization** for backward compatibility
4. **Comprehensive metadata flattening** for Datadog tag searchability

---

## 2. Architecture Overview

### High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           MASTRA APPLICATION                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │   Agents    │  │  Workflows  │  │    Tools    │  │  LLM Calls  │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         └────────────────┴────────────────┴────────────────┘                │
│                                   │                                         │
│                                   ▼                                         │
│                    ┌──────────────────────────┐                             │
│                    │  ObservabilityInstance   │                             │
│                    │  Emits: span_started,    │                             │
│                    │  span_updated, span_ended│                             │
│                    └────────────┬─────────────┘                             │
└─────────────────────────────────┼───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     DATADOG EXPORTER (Completion-Only)                       │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                         DatadogExporter                                 │ │
│  │  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │ │
│  │  │  traceContext    │  │  spanHierarchy   │  │  dd-trace SDK        │  │ │
│  │  │  Map<traceId,    │  │  Map<spanId,     │  │  (llmobs API)        │  │ │
│  │  │   {user,session}>│  │   ddSpanContext> │  │                      │  │ │
│  │  └──────────────────┘  └──────────────────┘  └──────────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  Event Handling:                                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  span_started  →  Capture trace context (user/session)                  │ │
│  │  span_updated  →  No-op (completion-only)                               │ │
│  │  span_ended    →  Emit single llmobs.trace() with full data             │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      DATADOG INFRASTRUCTURE                                  │
│  ┌──────────────────┐      ┌────────────────────────────────────────┐       │
│  │   Datadog Agent  │  OR  │  Direct Intake (agentless mode)        │       │
│  │   (localhost)    │      │  (intake.llmobs.datadoghq.com)         │       │
│  └────────┬─────────┘      └──────────────────┬─────────────────────┘       │
│           └───────────────┬───────────────────┘                             │
│                           ▼                                                 │
│              ┌────────────────────────┐                                     │
│              │  Datadog LLM           │                                     │
│              │  Observability UI      │                                     │
│              └────────────────────────┘                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Event Processing Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       COMPLETION-ONLY EVENT FLOW                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  span_started arrives:                                                       │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  1. If root span: capture userId/sessionId to traceContext Map          │ │
│  │  2. Store any span hierarchy info needed for later                      │ │
│  │  3. Return immediately (no Datadog API calls)                           │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  span_updated arrives:                                                       │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  1. No-op - return immediately                                          │ │
│  │  2. Final state will be captured at span_ended                          │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  span_ended arrives:                                                         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  1. Build span options (kind, name, times, model info)                  │ │
│  │  2. Build annotations (input, output, metrics, tags, errors)            │ │
│  │  3. Call llmobs.trace(options, (ddSpan) => {                            │ │
│  │       llmobs.annotate(ddSpan, annotations);                             │ │
│  │     });                                                                  │ │
│  │  4. Span completes when callback returns                                │ │
│  │  5. If root span: clean up traceContext                                 │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Model Mapping

### Span Type to Datadog Kind Mapping

| Mastra SpanType             | Datadog Kind | Rationale                                      |
| --------------------------- | ------------ | ---------------------------------------------- |
| `AGENT_RUN`                 | `agent`      | Direct semantic match - agent orchestration    |
| `MODEL_GENERATION`          | `llm`        | LLM model call with prompts and completions    |
| `MODEL_STEP`                | `llm`        | Individual step within a generation            |
| `MODEL_CHUNK`               | `task`       | Streaming chunks are micro-operations          |
| `TOOL_CALL`                 | `tool`       | Tool/function execution                        |
| `MCP_TOOL_CALL`             | `tool`       | MCP tool execution                             |
| `WORKFLOW_RUN`              | `workflow`   | Direct semantic match - workflow orchestration |
| `WORKFLOW_STEP`             | `task`       | Individual workflow step                       |
| `WORKFLOW_CONDITIONAL`      | `task`       | Conditional branching operation                |
| `WORKFLOW_CONDITIONAL_EVAL` | `task`       | Condition evaluation                           |
| `WORKFLOW_PARALLEL`         | `task`       | Parallel execution block                       |
| `WORKFLOW_LOOP`             | `task`       | Loop iteration                                 |
| `WORKFLOW_SLEEP`            | `task`       | Sleep/delay operation                          |
| `WORKFLOW_WAIT_EVENT`       | `task`       | Event wait operation                           |
| `PROCESSOR_RUN`             | `task`       | Input/output processor execution               |
| `GENERIC`                   | `task`       | Catch-all for unclassified operations          |

### Data Field Mapping

| Mastra Field               | Datadog LLMObs Field          | Notes                                     |
| -------------------------- | ----------------------------- | ----------------------------------------- |
| `span.input`               | `annotations.input`           | For LLM spans: `{role, content}[]` format |
| `span.output`              | `annotations.output`          | For LLM spans: `{role, content}[]` format |
| `span.attributes.usage`    | `annotations.metrics`         | Normalized token counts                   |
| `span.attributes.model`    | `spanOptions.modelName`       | Model identifier                          |
| `span.attributes.provider` | `spanOptions.modelProvider`   | Provider name                             |
| `span.metadata`            | `annotations.tags`            | Flattened key-value pairs                 |
| `span.metadata.userId`     | `spanOptions.userId`          | User identifier                           |
| `span.metadata.sessionId`  | `spanOptions.sessionId`       | Session identifier                        |
| `span.errorInfo`           | `annotations.tags['error.*']` | Error tags                                |
| `span.startTime`           | `spanOptions.startTime`       | Span start timestamp                      |
| `span.endTime`             | `spanOptions.endTime`         | Span end timestamp                        |

### Token Usage Normalization (AI SDK v4/v5 Compatibility)

```typescript
// Input: AI SDK v4 format
{ promptTokens: 100, completionTokens: 50, totalTokens: 150 }

// Input: AI SDK v5 format
{ inputTokens: 100, outputTokens: 50, totalTokens: 150, reasoningTokens: 20 }

// Output: Normalized for Datadog
{
  inputTokens: 100,    // v5: inputTokens, v4: promptTokens
  outputTokens: 50,    // v5: outputTokens, v4: completionTokens
  totalTokens: 150,    // calculated if missing
  reasoningTokens: 20, // v5 only
  cachedInputTokens: 0 // v5: cachedInputTokens, v4: promptCacheHitTokens
}
```

---

## 4. Package Structure

```
observability/
└── datadog/
    ├── package.json
    ├── tsconfig.json
    ├── tsup.config.ts
    ├── vitest.config.ts
    ├── README.md
    └── src/
        ├── index.ts           # Public exports
        ├── tracing.ts         # DatadogExporter class
        ├── tracing.test.ts    # Unit tests
        └── types.ts           # Type definitions (optional)
```

### package.json

```json
{
  "name": "@mastra/datadog",
  "version": "0.1.0",
  "description": "Datadog LLM Observability exporter for Mastra",
  "main": "dist/index.js",
  "module": "dist/index.mjs",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "dd-trace": "^5.0.0"
  },
  "peerDependencies": {
    "@mastra/core": "workspace:*",
    "@mastra/observability": "workspace:*"
  },
  "devDependencies": {
    "@mastra/core": "workspace:*",
    "@mastra/observability": "workspace:*",
    "typescript": "^5.0.0",
    "tsup": "^8.0.0",
    "vitest": "^1.0.0"
  }
}
```

---

## 5. Configuration Interface

```typescript
import type { BaseExporterConfig } from '@mastra/observability';

/**
 * Configuration options for the Datadog LLM Observability exporter.
 */
export interface DatadogExporterConfig extends BaseExporterConfig {
  /**
   * Datadog API key. Required for agentless mode.
   * Falls back to DD_API_KEY environment variable.
   */
  apiKey?: string;

  /**
   * ML application name for grouping traces.
   * Required - falls back to DD_LLMOBS_ML_APP environment variable.
   */
  mlApp?: string;

  /**
   * Datadog site (e.g., 'datadoghq.com', 'datadoghq.eu').
   * Falls back to DD_SITE environment variable, defaults to 'datadoghq.com'.
   */
  site?: string;

  /**
   * Service name for the application.
   * Falls back to mlApp if not specified.
   */
  service?: string;

  /**
   * Environment name (e.g., 'production', 'staging').
   * Falls back to DD_ENV environment variable.
   */
  env?: string;

  /**
   * Enable agentless mode (direct intake without Datadog Agent).
   * Falls back to DD_LLMOBS_AGENTLESS_ENABLED environment variable.
   */
  agentless?: boolean;

  /**
   * Enable dd-trace automatic integrations.
   * Defaults to false to avoid unexpected instrumentation.
   */
  integrationsEnabled?: boolean;

  /**
   * Default user ID applied to all spans if not specified in metadata.
   */
  defaultUserId?: string;

  /**
   * Default session ID applied to all spans if not specified in metadata.
   */
  defaultSessionId?: string;
}
```

### Environment Variable Support

| Config Field | Environment Variable          | Default           |
| ------------ | ----------------------------- | ----------------- |
| `apiKey`     | `DD_API_KEY`                  | (none)            |
| `mlApp`      | `DD_LLMOBS_ML_APP`            | (required)        |
| `site`       | `DD_SITE`                     | `'datadoghq.com'` |
| `env`        | `DD_ENV`                      | (none)            |
| `agentless`  | `DD_LLMOBS_AGENTLESS_ENABLED` | `false`           |

---

## 6. Core Implementation

### Tracer Initialization

```typescript
import tracer from 'dd-trace';

/**
 * Singleton flag to prevent multiple tracer initializations.
 * dd-trace should only be initialized once per process.
 */
const tracerInitFlag = { done: false };

/**
 * Ensures dd-trace is initialized exactly once.
 * Respects any existing tracer initialization by the application.
 */
function ensureTracer(config: {
  mlApp: string;
  site: string;
  apiKey?: string;
  agentless: boolean;
  service?: string;
  env?: string;
  integrationsEnabled?: boolean;
}): void {
  if (tracerInitFlag.done) return;

  // Check if tracer was already started by the application
  const alreadyStarted = (tracer as any)._tracer?.started;

  if (!alreadyStarted) {
    tracer.init({
      service: config.service || config.mlApp,
      env: config.env || process.env.DD_ENV,
      // Disable automatic integrations by default to avoid surprise instrumentation
      plugins: config.integrationsEnabled ?? false,
    });
  }

  // Enable LLM Observability with the resolved configuration
  tracer.llmobs.enable({
    mlApp: config.mlApp,
    agentlessEnabled: config.agentless,
    site: config.site,
    apiKey: config.apiKey,
  });

  tracerInitFlag.done = true;
}
```

### Exporter Class

```typescript
import type {
  TracingEvent,
  TracingEventType,
  AnyExportedSpan,
  ModelGenerationAttributes,
} from '@mastra/core/observability';
import { SpanType } from '@mastra/core/observability';
import { BaseExporter } from '@mastra/observability';
import type { BaseExporterConfig } from '@mastra/observability';
import tracer from 'dd-trace';

/**
 * Datadog LLM Observability span kinds.
 */
type DatadogSpanKind = 'llm' | 'agent' | 'workflow' | 'tool' | 'task' | 'retrieval' | 'embedding';

/**
 * Minimal per-trace context for user/session tagging.
 */
interface TraceContext {
  userId?: string;
  sessionId?: string;
}

/**
 * Maps Mastra SpanTypes to Datadog LLMObs span kinds.
 */
const SPAN_TYPE_TO_KIND: Record<SpanType, DatadogSpanKind> = {
  [SpanType.AGENT_RUN]: 'agent',
  [SpanType.MODEL_GENERATION]: 'llm',
  [SpanType.MODEL_STEP]: 'llm',
  [SpanType.MODEL_CHUNK]: 'task',
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
  [SpanType.GENERIC]: 'task',
};

export class DatadogExporter extends BaseExporter {
  name = 'datadog';

  private config: Required<Pick<DatadogExporterConfig, 'mlApp' | 'site'>> & DatadogExporterConfig;
  private traceContext = new Map<string, TraceContext>();

  constructor(config: DatadogExporterConfig) {
    super(config);

    // Resolve configuration from config object and environment variables
    const mlApp = config.mlApp || process.env.DD_LLMOBS_ML_APP;
    const apiKey = config.apiKey || process.env.DD_API_KEY;
    const site = config.site || process.env.DD_SITE || 'datadoghq.com';
    const agentless =
      config.agentless ?? ['true', '1'].includes((process.env.DD_LLMOBS_AGENTLESS_ENABLED || '').toLowerCase());

    // Validate required configuration
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

    // Initialize tracer and enable LLM Observability
    ensureTracer({
      mlApp,
      site,
      apiKey,
      agentless,
      service: config.service,
      env: config.env,
      integrationsEnabled: config.integrationsEnabled,
    });

    this.logger.info('Datadog exporter initialized', { mlApp, site, agentless });
  }

  /**
   * Main entry point for tracing events from Mastra.
   */
  protected async _exportTracingEvent(event: TracingEvent): Promise<void> {
    if (this.isDisabled || !(tracer as any).llmobs) return;

    const span = event.exportedSpan;

    // Handle event spans (zero-duration spans) - only on span_started
    if (span.isEvent) {
      if (event.type === 'span_started') {
        this.handleEventSpan(span);
      }
      return; // Skip span_updated and span_ended for events
    }

    // Handle regular spans based on event type
    switch (event.type) {
      case 'span_started':
        this.captureTraceContext(span);
        return;

      case 'span_updated':
        // No-op: completion-only pattern ignores mid-span updates
        return;

      case 'span_ended':
        this.handleSpanEnded(span);
        return;
    }
  }

  /**
   * Captures user/session context from root spans for tagging all spans in the trace.
   */
  private captureTraceContext(span: AnyExportedSpan): void {
    if (span.isRootSpan && !this.traceContext.has(span.traceId)) {
      this.traceContext.set(span.traceId, {
        userId: span.metadata?.userId || this.config.defaultUserId,
        sessionId: span.metadata?.sessionId || this.config.defaultSessionId,
      });
    }
  }

  /**
   * Emits a single LLMObs span at span completion with all data.
   */
  private handleSpanEnded(span: AnyExportedSpan): void {
    const traceCtx = this.traceContext.get(span.traceId) || {
      userId: span.metadata?.userId || this.config.defaultUserId,
      sessionId: span.metadata?.sessionId || this.config.defaultSessionId,
    };

    const kind = kindFor(span.type);

    // Build span options
    const options: Record<string, any> = {
      kind,
      name: span.name,
      sessionId: traceCtx.sessionId,
      userId: traceCtx.userId,
      startTime: toDate(span.startTime),
      endTime: span.endTime ? toDate(span.endTime) : new Date(),
    };

    // Add model info for LLM spans
    if (kind === 'llm') {
      const attrs = span.attributes as ModelGenerationAttributes | undefined;
      if (attrs?.model) options.modelName = attrs.model;
      if (attrs?.provider) options.modelProvider = attrs.provider;
    }

    // Execute the trace with annotation
    tracer.llmobs.trace(options, (ddSpan: any) => {
      const annotations = this.buildAnnotations(span);
      if (Object.keys(annotations).length > 0) {
        tracer.llmobs.annotate(ddSpan, annotations);
      }
    });

    // Clean up trace context when root span ends
    if (span.isRootSpan) {
      this.traceContext.delete(span.traceId);
    }
  }

  /**
   * Handles event spans (zero-duration spans like model chunks).
   */
  private handleEventSpan(span: AnyExportedSpan): void {
    if (span.isRootSpan) {
      this.captureTraceContext(span);
    }

    const traceCtx = this.traceContext.get(span.traceId);
    const kind = kindFor(span.type);

    const options: Record<string, any> = {
      kind,
      name: span.name,
      sessionId: traceCtx?.sessionId,
      userId: traceCtx?.userId,
      startTime: toDate(span.startTime),
      endTime: span.endTime ? toDate(span.endTime) : toDate(span.startTime),
    };

    tracer.llmobs.trace(options, (ddSpan: any) => {
      const annotations = this.buildAnnotations(span);
      if (Object.keys(annotations).length > 0) {
        tracer.llmobs.annotate(ddSpan, annotations);
      }
    });
  }

  /**
   * Builds annotations object for llmobs.annotate().
   */
  private buildAnnotations(span: AnyExportedSpan): Record<string, any> {
    const annotations: Record<string, any> = {};

    // Format and add input
    if (span.input !== undefined) {
      annotations.input = formatInput(span.input, span.type);
    }

    // Format and add output
    if (span.output !== undefined) {
      annotations.output = formatOutput(span.output, span.type);
    }

    // Normalize and add token usage metrics
    const usage = (span.attributes as ModelGenerationAttributes | undefined)?.usage;
    const metrics = normalizeUsage(usage);
    if (metrics) {
      annotations.metrics = metrics;
    }

    // Format metadata as tags
    const tags = formatMetadata(span.metadata);

    // Handle errors
    if (span.errorInfo) {
      annotations.tags = {
        ...(tags || {}),
        error: 'true',
        'error.message': span.errorInfo.message,
        ...(span.errorInfo.id ? { 'error.id': span.errorInfo.id } : {}),
        ...(span.errorInfo.domain ? { 'error.domain': span.errorInfo.domain } : {}),
        ...(span.errorInfo.category ? { 'error.category': span.errorInfo.category } : {}),
      };
    } else if (tags) {
      annotations.tags = tags;
    }

    return annotations;
  }

  /**
   * Gracefully shuts down the exporter.
   */
  async shutdown(): Promise<void> {
    // Flush any pending data
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

    // Disable LLM Observability
    if (tracer.llmobs?.disable) {
      try {
        tracer.llmobs.disable();
      } catch (e) {
        this.logger.error('Error disabling llmobs', { error: e });
      }
    }

    // Clear local state
    this.traceContext.clear();

    await super.shutdown();
  }
}
```

---

## 7. Helper Functions

```typescript
/**
 * Returns the Datadog kind for a Mastra span type.
 */
function kindFor(spanType: SpanType): DatadogSpanKind {
  return SPAN_TYPE_TO_KIND[spanType] || 'task';
}

/**
 * Converts a value to a Date object.
 */
function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Normalizes AI SDK v4/v5 token usage to Datadog format.
 */
function normalizeUsage(usage?: ModelGenerationAttributes['usage']): Record<string, number> | undefined {
  if (!usage) return undefined;

  const result: Record<string, number> = {};

  // Handle input tokens (v5: inputTokens, v4: promptTokens)
  const inputTokens = usage.inputTokens ?? usage.promptTokens;
  if (inputTokens !== undefined) result.inputTokens = inputTokens;

  // Handle output tokens (v5: outputTokens, v4: completionTokens)
  const outputTokens = usage.outputTokens ?? usage.completionTokens;
  if (outputTokens !== undefined) result.outputTokens = outputTokens;

  // Handle total tokens (calculate if not provided)
  if (usage.totalTokens !== undefined) {
    result.totalTokens = usage.totalTokens;
  } else if (inputTokens !== undefined && outputTokens !== undefined) {
    result.totalTokens = inputTokens + outputTokens;
  }

  // AI SDK v5 specific: reasoning tokens
  if (usage.reasoningTokens !== undefined) {
    result.reasoningTokens = usage.reasoningTokens;
  }

  // Handle cached tokens (v5: cachedInputTokens, v4: promptCacheHitTokens)
  const cachedTokens = usage.cachedInputTokens ?? usage.promptCacheHitTokens;
  if (cachedTokens !== undefined) {
    result.cachedInputTokens = cachedTokens;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Formats input data for Datadog annotations.
 * LLM spans use message array format; others use raw or stringified data.
 */
function formatInput(input: any, spanType: SpanType): any {
  // LLM spans expect {role, content}[] format
  if (spanType === SpanType.MODEL_GENERATION || spanType === SpanType.MODEL_STEP) {
    // Already in message format
    if (Array.isArray(input) && input.every(m => m?.role && m?.content !== undefined)) {
      return input.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : safeStringify(m.content),
      }));
    }
    // String input becomes user message
    if (typeof input === 'string') {
      return [{ role: 'user', content: input }];
    }
    // Object input gets stringified as user message
    return [{ role: 'user', content: safeStringify(input) }];
  }

  // Non-LLM spans: pass through strings/arrays, stringify objects
  if (typeof input === 'string' || Array.isArray(input)) return input;
  return safeStringify(input);
}

/**
 * Formats output data for Datadog annotations.
 * LLM spans use message array format; others use raw or stringified data.
 */
function formatOutput(output: any, spanType: SpanType): any {
  // LLM spans expect {role, content}[] format
  if (spanType === SpanType.MODEL_GENERATION || spanType === SpanType.MODEL_STEP) {
    // Already in message format
    if (Array.isArray(output) && output.every(m => m?.role && m?.content !== undefined)) {
      return output.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : safeStringify(m.content),
      }));
    }
    // String output becomes assistant message
    if (typeof output === 'string') {
      return [{ role: 'assistant', content: output }];
    }
    // Object with text property (common AI SDK format)
    if (output?.text) {
      return [{ role: 'assistant', content: output.text }];
    }
    // Other objects get stringified as assistant message
    return [{ role: 'assistant', content: safeStringify(output) }];
  }

  // Non-LLM spans: pass through strings, stringify objects
  if (typeof output === 'string') return output;
  return safeStringify(output);
}

/**
 * Flattens metadata into Datadog-compatible tags.
 * Nested objects are flattened with dot notation.
 */
function formatMetadata(metadata?: Record<string, any>): Record<string, string> | undefined {
  if (!metadata) return undefined;

  const tags: Record<string, string> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined || value === null) continue;

    // Flatten nested objects
    if (typeof value === 'object' && !Array.isArray(value)) {
      for (const [nestedKey, nestedVal] of Object.entries(value)) {
        if (nestedVal !== undefined && nestedVal !== null) {
          tags[`${key}.${nestedKey}`] = String(nestedVal);
        }
      }
    } else {
      tags[key] = String(value);
    }
  }

  // Ensure user.id and session.id are set if present in metadata
  if (metadata.userId) tags['user.id'] = String(metadata.userId);
  if (metadata.sessionId) tags['session.id'] = String(metadata.sessionId);

  return Object.keys(tags).length > 0 ? tags : undefined;
}

/**
 * Safely stringifies data, handling circular references.
 */
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

---

## 8. Evaluation Scoring Support

Implement `addScoreToTrace()` using Datadog's evaluation submission API for post-hoc scoring of LLM outputs:

```typescript
/**
 * Submits an evaluation score to Datadog for a specific trace/span.
 * Scores can be used for quality metrics, feedback tracking, and model evaluation.
 */
async addScoreToTrace({
  traceId,
  spanId,
  score,
  reason,
  scorerName,
  metadata,
}: {
  traceId: string;
  spanId?: string;
  score: number;
  reason?: string;
  scorerName: string;
  metadata?: Record<string, any>;
}): Promise<void> {
  if (this.isDisabled || !tracer.llmobs) return;

  // Use Datadog's submitEvaluation API
  // Evaluations are joined to spans via traceId + spanId
  tracer.llmobs.submitEvaluation({
    spanContext: { traceId, spanId },
    label: scorerName,
    metricType: 'score',
    value: score,
    tags: {
      ...(reason ? { reason } : {}),
      ...metadata,
    },
  });
}
```

**Usage Example:**

```typescript
// After an LLM interaction completes
await datadog.addScoreToTrace({
  traceId: 'trace-123',
  spanId: 'span-456',
  score: 0.95,
  reason: 'Response was accurate and helpful',
  scorerName: 'quality_scorer',
  metadata: { category: 'helpfulness' },
});
```

**Note**: Only Langfuse currently implements this among Mastra exporters. Datadog supports it via `LLMObs.submit_evaluation_for()`.

---

## 9. Monorepo Integration

**No special configuration required!** The workspace automatically includes new packages:

- **Workspace pattern**: `observability/*` in `pnpm-workspace.yaml`
- **Build filter**: `--filter "./observability/*"` in root `package.json`
- **Turbo**: Auto-detects dependencies via `dependsOn: ["^build"]`

Just create the package following the standard structure and it's automatically integrated.

---

## 10. Complete Implementation

The complete implementation file (`src/tracing.ts`) combines all the above sections:

```typescript
/**
 * Datadog LLM Observability Exporter for Mastra
 *
 * Exports Mastra observability data to Datadog's LLM Observability product.
 * Uses a completion-only pattern where spans are emitted on span_ended events.
 *
 * Key features:
 * - Maps Mastra span types to Datadog span kinds
 * - Normalizes AI SDK v4/v5 token usage formats
 * - Formats LLM inputs/outputs as message arrays
 * - Flattens metadata into searchable tags
 * - Supports both agent and agentless modes
 */

import tracer from 'dd-trace';
import type { TracingEvent, AnyExportedSpan, ModelGenerationAttributes } from '@mastra/core/observability';
import { SpanType } from '@mastra/core/observability';
import { BaseExporter } from '@mastra/observability';
import type { BaseExporterConfig } from '@mastra/observability';

// ... (all type definitions, constants, helper functions, and class implementation from above)

export { DatadogExporter, DatadogExporterConfig };
```

---

## 11. Testing Strategy

### Test Categories

1. **Configuration Tests**
   - Valid configuration initializes correctly
   - Missing mlApp disables exporter
   - Agentless without apiKey disables exporter
   - Environment variables are respected

2. **Span Type Mapping Tests**
   - Each Mastra SpanType maps to expected Datadog kind
   - Unknown span types default to 'task'

3. **Token Usage Normalization Tests**
   - AI SDK v4 format (promptTokens/completionTokens) normalizes correctly
   - AI SDK v5 format (inputTokens/outputTokens) normalizes correctly
   - Mixed/partial usage data handled gracefully
   - Reasoning tokens included when present

4. **Input/Output Formatting Tests**
   - LLM spans format as message arrays
   - Non-LLM spans pass through or stringify
   - Circular references handled safely

5. **Error Handling Tests**
   - Error spans include error tags
   - Error messages and categories captured
   - Errors don't crash the exporter

6. **Lifecycle Tests**
   - span_started captures trace context
   - span_updated is no-op
   - span_ended emits complete span
   - Shutdown flushes and disables

7. **Scoring Tests**
   - addScoreToTrace calls submitEvaluation
   - Disabled exporter skips scoring
   - Score metadata passed correctly

8. **Event Span Tests**
   - Event spans handled at span_started
   - Event spans ignored at span_updated/span_ended
   - Event spans emitted with zero duration
   - Event span metadata preserved correctly

### Mock Strategy

```typescript
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock dd-trace before importing the exporter
vi.mock('dd-trace', () => {
  const mockAnnotate = vi.fn();
  const mockTrace = vi.fn((options, fn) => fn({ id: 'mock-dd-span' }));
  const mockFlush = vi.fn().mockResolvedValue(undefined);
  const mockDisable = vi.fn();
  const mockEnable = vi.fn();
  const mockInit = vi.fn();

  return {
    default: {
      init: mockInit,
      llmobs: {
        enable: mockEnable,
        disable: mockDisable,
        trace: mockTrace,
        annotate: mockAnnotate,
        flush: mockFlush,
        submitEvaluation: vi.fn(), // For scoring support
      },
      scope: () => ({ active: () => null, activate: vi.fn((span, fn) => fn()) }),
    },
  };
});

import { DatadogExporter } from './tracing';
import { SpanType } from '@mastra/core/observability';
import tracer from 'dd-trace';

describe('DatadogExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('configuration', () => {
    it('initializes with valid config', () => {
      const exporter = new DatadogExporter({
        mlApp: 'test-app',
        apiKey: 'test-key',
        agentless: true,
      });

      expect(tracer.llmobs.enable).toHaveBeenCalledWith(expect.objectContaining({ mlApp: 'test-app' }));
    });

    it('disables without mlApp', () => {
      const exporter = new DatadogExporter({});
      // Exporter should be disabled
      expect(exporter['isDisabled']).toBe(true);
    });
  });

  describe('span type mapping', () => {
    it('maps AGENT_RUN to agent', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });

      await exporter.exportTracingEvent({
        type: 'span_ended',
        exportedSpan: createMockSpan({ type: SpanType.AGENT_RUN }),
      });

      expect(tracer.llmobs.trace).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'agent' }),
        expect.any(Function),
      );
    });

    // ... more mapping tests
  });

  // ... more test categories
});

function createMockSpan(overrides: Partial<AnyExportedSpan>): AnyExportedSpan {
  return {
    id: 'span-1',
    traceId: 'trace-1',
    name: 'test-span',
    type: SpanType.GENERIC,
    startTime: new Date(),
    endTime: new Date(),
    isEvent: false,
    isRootSpan: false,
    ...overrides,
  } as AnyExportedSpan;
}
```

---

## 12. Usage Examples

### Basic Usage

```typescript
import { Mastra } from '@mastra/core';
import { DatadogExporter } from '@mastra/datadog';

const datadog = new DatadogExporter({
  mlApp: 'my-llm-app',
  agentless: true,
  apiKey: process.env.DD_API_KEY,
  site: 'datadoghq.com',
  env: 'production',
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

### With Datadog Agent

```typescript
const datadog = new DatadogExporter({
  mlApp: 'my-llm-app',
  agentless: false, // Send through local Datadog Agent
  env: 'staging',
});
```

### With Default User/Session

```typescript
const datadog = new DatadogExporter({
  mlApp: 'my-llm-app',
  agentless: true,
  apiKey: process.env.DD_API_KEY,
  defaultUserId: 'system',
  defaultSessionId: 'background-job',
});
```

### Multiple Environments

```typescript
// Development
const devDatadog = new DatadogExporter({
  mlApp: 'my-app-dev',
  agentless: true,
  apiKey: process.env.DD_API_KEY_DEV,
  site: 'datadoghq.com',
  env: 'development',
});

// Production
const prodDatadog = new DatadogExporter({
  mlApp: 'my-app',
  agentless: true,
  apiKey: process.env.DD_API_KEY_PROD,
  site: 'datadoghq.com',
  env: 'production',
});

const mastra = new Mastra({
  observability: {
    configs: {
      default: {
        serviceName: 'my-service',
        exporters: [process.env.NODE_ENV === 'production' ? prodDatadog : devDatadog],
      },
    },
  },
});
```

---

## 13. Future Considerations

### Deferred Promise Pattern (Reserved for Future)

If Datadog adds support for in-progress span visibility, the deferred promise pattern can be implemented:

```typescript
// Reserved for future: Deferred Promise implementation
interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
}

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res as any;
    reject = rej;
  });

  return { promise, resolve, reject };
}

// Would be used to keep spans open across events:
// span_started: Create deferred, call llmobs.trace() with async callback awaiting deferred
// span_updated: Call llmobs.annotate() on stored span
// span_ended: Resolve deferred to complete span
```

### Parent-Child Hierarchy Enhancement

For complex multi-level traces, consider tracking span hierarchy:

```typescript
interface SpanContext {
  ddSpanId: string;
  parentSpanId?: string;
}

private spanContexts = new Map<string, SpanContext>();

// On span_started, store context for later parent lookup
// On span_ended, use parent context for hierarchy
```

### Retrieval and Embedding Spans

When Mastra adds explicit retrieval/embedding span types:

```typescript
// Future span type additions
[SpanType.RETRIEVAL]: 'retrieval',
[SpanType.EMBEDDING]: 'embedding',
```

---

## Appendix: Decision Log

| Date       | Decision                        | Rationale                                     |
| ---------- | ------------------------------- | --------------------------------------------- |
| 2024-XX-XX | Use completion-only pattern     | Datadog doesn't show in-progress spans        |
| 2024-XX-XX | Use dd-trace SDK (not HTTP API) | Native batching, retries, context propagation |
| 2024-XX-XX | Disable integrations by default | Avoid unexpected auto-instrumentation         |
| 2024-XX-XX | Map MODEL_CHUNK to 'task'       | Streaming chunks are micro-operations         |
| 2024-XX-XX | Normalize v4/v5 token usage     | Backward compatibility with AI SDK versions   |
