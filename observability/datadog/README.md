# @mastra/datadog

Datadog LLM Observability exporter for Mastra. Exports observability data to [Datadog's LLM Observability](https://docs.datadoghq.com/llm_observability/) product.

## Installation

```bash
pnpm add @mastra/datadog
```

## Requirements

- Datadog account with LLM Observability enabled
- Either:
  - Datadog Agent running locally (agent mode)
  - Datadog API key for direct ingestion (agentless mode)

## Usage

### Basic Setup

```typescript
import { Mastra } from '@mastra/core';
import { DatadogExporter } from '@mastra/datadog';

const datadog = new DatadogExporter({
  mlApp: 'my-llm-app',
  agentless: true,
  apiKey: process.env.DD_API_KEY,
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
  env: 'production',
});
```

### Configuration Options

| Option                | Description                                          | Default                                  |
| --------------------- | ---------------------------------------------------- | ---------------------------------------- |
| `mlApp`               | ML application name for grouping traces (required)   | `DD_LLMOBS_ML_APP` env var               |
| `apiKey`              | Datadog API key (required for agentless mode)        | `DD_API_KEY` env var                     |
| `site`                | Datadog site (e.g., 'datadoghq.com', 'datadoghq.eu') | `DD_SITE` or `'datadoghq.com'`           |
| `agentless`           | Enable direct intake without Datadog Agent           | `DD_LLMOBS_AGENTLESS_ENABLED` or `false` |
| `service`             | Service name for the application                     | Uses `mlApp` value                       |
| `env`                 | Environment name (e.g., 'production', 'staging')     | `DD_ENV` env var                         |
| `integrationsEnabled` | Enable dd-trace automatic integrations               | `false`                                  |
| `defaultUserId`       | Default user ID for all spans                        | (none)                                   |
| `defaultSessionId`    | Default session ID for all spans                     | (none)                                   |

### Environment Variables

The exporter reads configuration from environment variables:

- `DD_API_KEY` - Datadog API key
- `DD_LLMOBS_ML_APP` - ML application name
- `DD_SITE` - Datadog site
- `DD_ENV` - Environment name
- `DD_LLMOBS_AGENTLESS_ENABLED` - Enable agentless mode ('true' or '1')

## Span Type Mapping

Mastra span types are mapped to Datadog LLMObs span kinds:

| Mastra SpanType      | Datadog Kind |
| -------------------- | ------------ |
| `AGENT_RUN`          | `agent`      |
| `MODEL_GENERATION`   | `llm`        |
| `MODEL_STEP`         | `llm`        |
| `MODEL_CHUNK`        | `task`       |
| `TOOL_CALL`          | `tool`       |
| `MCP_TOOL_CALL`      | `tool`       |
| `WORKFLOW_RUN`       | `workflow`   |
| `WORKFLOW_STEP`      | `task`       |
| Other workflow types | `task`       |
| `GENERIC`            | `task`       |

## Features

- **Completion-only pattern**: Spans are emitted at completion for efficient tracing
- **AI SDK v4/v5 compatibility**: Normalizes token usage from both formats
- **Message formatting**: LLM inputs/outputs formatted as message arrays
- **Metadata as tags**: Span metadata is flattened into searchable Datadog tags
- **Error tracking**: Error spans include error tags with message, ID, and category
- **Evaluation scoring**: Submit scores via `addScoreToTrace()` method
- **Parent/child hierarchy**: Spans are emitted parent-first to preserve trace trees in Datadog

## Evaluation Scoring

Submit evaluation scores for traces:

```typescript
await datadog.addScoreToTrace({
  traceId: 'trace-123',
  spanId: 'span-456',
  score: 0.95,
  reason: 'Response was accurate and helpful',
  scorerName: 'quality_scorer',
  metadata: { category: 'helpfulness' },
});
```

Notes:

- Evaluations attach to spans only after the span has been emitted (on `span_ended`).
- Annotations use dd-trace keys: `inputData`, `outputData`, `metadata`, `tags`, `metrics`.

## License

Apache-2.0
