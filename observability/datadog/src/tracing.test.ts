/**
 * Tests for Datadog LLM Observability Exporter
 *
 * Uses mock dd-trace to test the exporter without connecting to Datadog.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TracingEvent, AnyExportedSpan } from '@mastra/core/observability';
import { SpanType, TracingEventType } from '@mastra/core/observability';

// Use vi.hoisted to define mocks before they're used in vi.mock
const {
  mockAnnotate,
  mockTrace,
  mockFlush,
  mockDisable,
  mockEnable,
  mockInit,
  mockSubmitEvaluation,
  mockScopeActivate,
  mockScopeActive,
  traceParents,
} = vi.hoisted(() => {
  let currentScopeSpan: any = undefined;
  const parents: any[] = [];

  const activate = vi.fn((span: any, fn: () => void) => {
    const previous = currentScopeSpan;
    currentScopeSpan = span;
    try {
      return fn();
    } finally {
      currentScopeSpan = previous;
    }
  });

  const active = vi.fn(() => currentScopeSpan);

  return {
    traceParents: parents,
    mockAnnotate: vi.fn(),
    mockTrace: vi.fn((options: any, fn: (span: any) => void) => {
      parents.push(currentScopeSpan);
      const ddSpan = { id: `mock-dd-span-${parents.length}`, options };
      return fn(ddSpan);
    }),
    mockFlush: vi.fn().mockResolvedValue(undefined),
    mockDisable: vi.fn(),
    mockEnable: vi.fn(),
    mockInit: vi.fn(),
    mockSubmitEvaluation: vi.fn(),
    mockScopeActivate: activate,
    mockScopeActive: active,
  };
});

// Mock dd-trace before importing the exporter
vi.mock('dd-trace', () => {
  return {
    default: {
      init: mockInit,
      llmobs: {
        enable: mockEnable,
        disable: mockDisable,
        trace: mockTrace,
        annotate: mockAnnotate,
        flush: mockFlush,
        submitEvaluation: mockSubmitEvaluation,
        exportSpan: (span: any) => ({ traceId: 'dd-trace-id', spanId: span?.id || 'dd-span-id' }),
      },
      _tracer: { started: false },
      scope: () => ({
        activate: mockScopeActivate,
        active: mockScopeActive,
      }),
    },
  };
});

import { DatadogExporter } from './tracing';

/**
 * Creates a mock span with default values
 */
function createMockSpan(overrides: Partial<AnyExportedSpan> = {}): AnyExportedSpan {
  return {
    id: 'span-1',
    traceId: 'trace-1',
    name: 'test-span',
    type: SpanType.GENERIC,
    startTime: new Date('2024-01-01T00:00:00Z'),
    endTime: new Date('2024-01-01T00:00:01Z'),
    isEvent: false,
    isRootSpan: false,
    ...overrides,
  } as AnyExportedSpan;
}

/**
 * Creates a tracing event
 */
function createTracingEvent(type: TracingEventType, span: AnyExportedSpan): TracingEvent {
  return { type, exportedSpan: span } as TracingEvent;
}

describe('DatadogExporter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    traceParents.length = 0;
    // Reset environment variables
    delete process.env.DD_API_KEY;
    delete process.env.DD_LLMOBS_ML_APP;
    delete process.env.DD_SITE;
    delete process.env.DD_LLMOBS_AGENTLESS_ENABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('configuration', () => {
    it('initializes with valid config', () => {
      const exporter = new DatadogExporter({
        mlApp: 'test-app',
        apiKey: 'test-key',
        agentless: true,
      });

      expect(mockEnable).toHaveBeenCalledWith(
        expect.objectContaining({
          mlApp: 'test-app',
          agentlessEnabled: true,
        }),
      );
      expect(exporter.name).toBe('datadog');
    });

    it('disables exporter when mlApp is missing', () => {
      const exporter = new DatadogExporter({});
      // Exporter should be disabled - verify by checking that trace is not called on export
      expect(mockEnable).not.toHaveBeenCalled();
    });

    it('disables exporter when agentless mode lacks apiKey', () => {
      const exporter = new DatadogExporter({
        mlApp: 'test-app',
        agentless: true,
        // apiKey not provided
      });
      // Exporter should be disabled
      expect(mockEnable).not.toHaveBeenCalled();
    });

    it('allows non-agentless mode without apiKey', () => {
      const exporter = new DatadogExporter({
        mlApp: 'test-app',
        agentless: false,
      });

      // Exporter should not be disabled
      expect(exporter['isDisabled']).toBe(false);
      expect(exporter.name).toBe('datadog');
    });

    it('reads configuration from environment variables', () => {
      process.env.DD_LLMOBS_ML_APP = 'env-app';
      process.env.DD_API_KEY = 'env-key';
      process.env.DD_LLMOBS_AGENTLESS_ENABLED = 'true';

      const exporter = new DatadogExporter({});

      // Exporter should not be disabled when env vars are set
      expect(exporter['isDisabled']).toBe(false);
    });

    it('prefers config values over environment variables', () => {
      process.env.DD_LLMOBS_ML_APP = 'env-app';

      const exporter = new DatadogExporter({
        mlApp: 'config-app',
        agentless: false,
      });

      // Exporter should not be disabled
      expect(exporter['isDisabled']).toBe(false);
      // Config value is stored in exporter.config
      expect(exporter['config'].mlApp).toBe('config-app');
    });
  });

  describe('span type mapping', () => {
    it('maps AGENT_RUN to agent kind', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({ type: SpanType.AGENT_RUN });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockTrace).toHaveBeenCalledWith(expect.objectContaining({ kind: 'agent' }), expect.any(Function));
    });

    it('maps MODEL_GENERATION to llm kind', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({ type: SpanType.MODEL_GENERATION });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockTrace).toHaveBeenCalledWith(expect.objectContaining({ kind: 'llm' }), expect.any(Function));
    });

    it('maps MODEL_STEP to llm kind', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({ type: SpanType.MODEL_STEP });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockTrace).toHaveBeenCalledWith(expect.objectContaining({ kind: 'llm' }), expect.any(Function));
    });

    it('maps TOOL_CALL to tool kind', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({ type: SpanType.TOOL_CALL });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockTrace).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tool' }), expect.any(Function));
    });

    it('maps WORKFLOW_RUN to workflow kind', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({ type: SpanType.WORKFLOW_RUN });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockTrace).toHaveBeenCalledWith(expect.objectContaining({ kind: 'workflow' }), expect.any(Function));
    });

    it('maps GENERIC to task kind', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({ type: SpanType.GENERIC });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockTrace).toHaveBeenCalledWith(expect.objectContaining({ kind: 'task' }), expect.any(Function));
    });
  });

  describe('token usage normalization', () => {
    it('normalizes AI SDK v4 format (promptTokens/completionTokens)', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({
        type: SpanType.MODEL_GENERATION,
        attributes: {
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
          },
        },
      });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockAnnotate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          metrics: expect.objectContaining({
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
          }),
        }),
      );
    });

    it('normalizes AI SDK v5 format (inputTokens/outputTokens)', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({
        type: SpanType.MODEL_GENERATION,
        attributes: {
          usage: {
            inputTokens: 200,
            outputTokens: 100,
            totalTokens: 300,
            reasoningTokens: 20,
          },
        },
      });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockAnnotate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          metrics: expect.objectContaining({
            inputTokens: 200,
            outputTokens: 100,
            totalTokens: 300,
            reasoningTokens: 20,
          }),
        }),
      );
    });

    it('calculates total tokens if not provided', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({
        type: SpanType.MODEL_GENERATION,
        attributes: {
          usage: {
            inputTokens: 50,
            outputTokens: 25,
          },
        },
      });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockAnnotate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          metrics: expect.objectContaining({
            inputTokens: 50,
            outputTokens: 25,
            totalTokens: 75,
          }),
        }),
      );
    });
  });

  describe('input/output formatting', () => {
    it('formats LLM span input as message array', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({
        type: SpanType.MODEL_GENERATION,
        input: 'Hello, world!',
      });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockAnnotate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          inputData: [{ role: 'user', content: 'Hello, world!' }],
        }),
      );
    });

    it('formats LLM span output as message array', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({
        type: SpanType.MODEL_GENERATION,
        output: 'Hi there!',
      });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockAnnotate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          outputData: [{ role: 'assistant', content: 'Hi there!' }],
        }),
      );
    });

    it('preserves existing message format for LLM spans', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const messages = [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' },
      ];
      const span = createMockSpan({
        type: SpanType.MODEL_GENERATION,
        input: messages,
      });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockAnnotate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          inputData: messages,
        }),
      );
    });

    it('passes through tool span input/output', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({
        type: SpanType.TOOL_CALL,
        input: { query: 'search term' },
        output: { results: ['a', 'b'] },
      });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockAnnotate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          inputData: '{"query":"search term"}',
          outputData: '{"results":["a","b"]}',
        }),
      );
    });
  });

  describe('error handling', () => {
    it('includes error tags for error spans', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({
        errorInfo: {
          message: 'Something went wrong',
          id: 'err-123',
          category: 'validation',
        },
      });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockAnnotate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tags: expect.objectContaining({
            error: 'true',
            'error.message': 'Something went wrong',
            'error.id': 'err-123',
            'error.category': 'validation',
          }),
        }),
      );
    });

    it('handles spans without errors', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({ metadata: { key: 'value' } });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockAnnotate).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          metadata: { key: 'value' },
        }),
      );
    });
  });

  describe('event lifecycle', () => {
    it('captures trace context on span_started for root spans', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({
        isRootSpan: true,
        metadata: { userId: 'user-1', sessionId: 'session-1' },
      });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_STARTED, span));

      // No trace call on span_started
      expect(mockTrace).not.toHaveBeenCalled();
    });

    it('ignores span_updated events (completion-only pattern)', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan();

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_UPDATED, span));

      expect(mockTrace).not.toHaveBeenCalled();
    });

    it('emits complete span on span_ended', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({ name: 'test-operation' });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockTrace).toHaveBeenCalledWith(expect.objectContaining({ name: 'test-operation' }), expect.any(Function));
    });

    it('uses trace context for user/session on span_ended', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const rootSpan = createMockSpan({
        isRootSpan: true,
        traceId: 'trace-123',
        metadata: { userId: 'user-1', sessionId: 'session-1' },
      });
      const childSpan = createMockSpan({
        traceId: 'trace-123',
        isRootSpan: false,
      });

      // First capture context from root
      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_STARTED, rootSpan));
      // Then emit child span
      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, childSpan));

      expect(mockTrace).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          sessionId: 'session-1',
        }),
        expect.any(Function),
      );
    });
  });

  describe('event spans', () => {
    it('handles event spans only on span_started', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const eventSpan = createMockSpan({ isEvent: true });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_STARTED, eventSpan));

      expect(mockTrace).toHaveBeenCalledTimes(1);
    });

    it('ignores event spans on span_updated', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const eventSpan = createMockSpan({ isEvent: true });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_UPDATED, eventSpan));

      expect(mockTrace).not.toHaveBeenCalled();
    });

    it('ignores event spans on span_ended', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const eventSpan = createMockSpan({ isEvent: true });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, eventSpan));

      expect(mockTrace).not.toHaveBeenCalled();
    });

    it('emits event spans with zero duration when endTime not set', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const startTime = new Date('2024-01-01T00:00:00Z');
      const eventSpan = createMockSpan({
        isEvent: true,
        startTime,
        endTime: undefined,
      });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_STARTED, eventSpan));

      expect(mockTrace).toHaveBeenCalledWith(
        expect.objectContaining({
          startTime,
          endTime: startTime,
        }),
        expect.any(Function),
      );
    });
  });

  describe('parent-child hierarchy', () => {
    it('emits child spans under the parent scope when parent ends first', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const rootSpan = createMockSpan({ id: 'root', traceId: 'trace-parent', isRootSpan: true });
      const childSpan = createMockSpan({
        id: 'child',
        traceId: 'trace-parent',
        isRootSpan: false,
        parentSpanId: 'root',
      });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, rootSpan));
      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, childSpan));

      expect(mockTrace).toHaveBeenCalledTimes(2);
      expect(traceParents[0]).toBeUndefined();
      expect(traceParents[1]).toEqual(expect.objectContaining({ id: 'mock-dd-span-1' }));
    });

    it('buffers child spans until the parent context exists', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const rootSpan = createMockSpan({ id: 'root', traceId: 'trace-buffer', isRootSpan: true });
      const childSpan = createMockSpan({
        id: 'child',
        traceId: 'trace-buffer',
        isRootSpan: false,
        parentSpanId: 'root',
      });

      // Child ends before parent
      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, childSpan));
      expect(mockTrace).toHaveBeenCalledTimes(0);

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, rootSpan));

      expect(mockTrace).toHaveBeenCalledTimes(2);
      expect(traceParents[0]).toBeUndefined();
      expect(traceParents[1]).toEqual(expect.objectContaining({ id: 'mock-dd-span-1' }));
    });
  });

  describe('scoring (addScoreToTrace)', () => {
    it('calls submitEvaluation with emitted Datadog span context', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({ id: 'span-1', traceId: 'trace-ctx', isRootSpan: true });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      await exporter.addScoreToTrace({
        traceId: 'trace-ctx',
        spanId: 'span-1',
        score: 0.95,
        reason: 'Good response',
        scorerName: 'quality_scorer',
        metadata: { category: 'helpfulness' },
      });

      expect(mockSubmitEvaluation).toHaveBeenCalledWith(
        { traceId: 'dd-trace-id', spanId: 'mock-dd-span-1' },
        {
          label: 'quality_scorer',
          metricType: 'score',
          value: 0.95,
          tags: { reason: 'Good response', category: 'helpfulness' },
        },
      );
    });

    it('allows missing spanId when a single span context exists', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({ id: 'span-1', traceId: 'trace-ctx2', isRootSpan: true });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      await exporter.addScoreToTrace({
        traceId: 'trace-ctx2',
        score: 0.8,
        scorerName: 'scorer',
      });

      expect(mockSubmitEvaluation).toHaveBeenCalledWith(
        { traceId: 'dd-trace-id', spanId: 'mock-dd-span-1' },
        expect.objectContaining({ label: 'scorer' }),
      );
    });

    it('does not call submitEvaluation when context is missing', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });

      await exporter.addScoreToTrace({
        traceId: 'unknown-trace',
        spanId: 'missing-span',
        score: 0.7,
        scorerName: 'scorer',
      });

      expect(mockSubmitEvaluation).not.toHaveBeenCalled();
    });

    it('does not call submitEvaluation when disabled', async () => {
      const exporter = new DatadogExporter({}); // Missing mlApp, will be disabled

      await exporter.addScoreToTrace({
        traceId: 'trace-123',
        score: 0.9,
        scorerName: 'scorer',
      });

      expect(mockSubmitEvaluation).not.toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('flushes and disables llmobs on shutdown', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });

      await exporter.shutdown();

      expect(mockFlush).toHaveBeenCalled();
      expect(mockDisable).toHaveBeenCalled();
    });
  });

  describe('model info for LLM spans', () => {
    it('includes modelName and modelProvider for llm spans', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({
        type: SpanType.MODEL_GENERATION,
        attributes: {
          model: 'gpt-4',
          provider: 'openai',
        },
      });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockTrace).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'llm',
          modelName: 'gpt-4',
          modelProvider: 'openai',
        }),
        expect.any(Function),
      );
    });

    it('does not include model info for non-llm spans', async () => {
      const exporter = new DatadogExporter({ mlApp: 'test' });
      const span = createMockSpan({
        type: SpanType.TOOL_CALL,
        attributes: {
          model: 'gpt-4',
          provider: 'openai',
        },
      });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      const traceCall = mockTrace.mock.calls[0][0];
      expect(traceCall.modelName).toBeUndefined();
      expect(traceCall.modelProvider).toBeUndefined();
    });
  });

  describe('default user/session IDs', () => {
    it('uses default userId when not in metadata', async () => {
      const exporter = new DatadogExporter({
        mlApp: 'test',
        defaultUserId: 'default-user',
      });
      const span = createMockSpan();

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockTrace).toHaveBeenCalledWith(expect.objectContaining({ userId: 'default-user' }), expect.any(Function));
    });

    it('uses default sessionId when not in metadata', async () => {
      const exporter = new DatadogExporter({
        mlApp: 'test',
        defaultSessionId: 'default-session',
      });
      const span = createMockSpan();

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockTrace).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'default-session' }),
        expect.any(Function),
      );
    });

    it('prefers metadata userId over default', async () => {
      const exporter = new DatadogExporter({
        mlApp: 'test',
        defaultUserId: 'default-user',
      });
      const span = createMockSpan({
        metadata: { userId: 'metadata-user' },
      });

      await exporter.exportTracingEvent(createTracingEvent(TracingEventType.SPAN_ENDED, span));

      expect(mockTrace).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'metadata-user' }),
        expect.any(Function),
      );
    });
  });
});
