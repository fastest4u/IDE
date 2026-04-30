---
title: AI Provider Implementation Blueprint
created: 2026-04-29
---

# AI Provider Implementation Blueprint

This document turns the AI provider architecture into an implementation plan.

## Recommended runtime layout

```txt
services/model-gateway/
├─ src/
│  ├─ app.ts
│  ├─ controller.ts
│  ├─ server.ts
│  ├─ index.ts
│  ├─ routes/
│  │  ├─ ai.ts
│  │  └─ health.ts
│  ├─ router/
│  │  ├─ ai-router.ts
│  │  ├─ policy-engine.ts
│  │  ├─ registry.ts
│  │  └─ fallback.ts
│  ├─ adapters/
│  │  ├─ anthropic-adapter.ts
│  │  ├─ openai-adapter.ts
│  │  ├─ gemini-adapter.ts
│  │  ├─ mistral-adapter.ts
│  │  ├─ deepseek-adapter.ts
│  │  ├─ ollama-adapter.ts
│  │  ├─ vllm-adapter.ts
│  │  └─ custom-adapter.ts
│  ├─ health/
│  │  ├─ health-check.ts
│  │  └─ circuit-breaker.ts
│  ├─ telemetry/
│  │  ├─ metrics.ts
│  │  └─ usage-log.ts
│  ├─ safety/
│  │  ├─ secret-redaction.ts
│  │  ├─ prompt-injection.ts
│  │  └─ response-validator.ts
│  └─ types/
│     └─ index.ts
```

## Service responsibilities

### `services/model-gateway`
- Own provider adapters and provider credentials
- Route requests across models and providers
- Track latency, errors, and quota pressure
- Apply fallback and circuit breaker policy
- Emit observability data
- Expose HTTP endpoints for generate, stream, embed, rerank, and health

### `packages/protocol`
- Holds the canonical type definitions for AI request routing, provider contracts, responses, and validation
- Split into `ai.ts`, `provider.ts`, and `validation.ts` for easier maintenance
- Shared by all services and applications

### `packages/ai-core`
- Build request context
- Classify task intent
- Prepare tool plans and patch plans
- Interpret AI responses
- Expose provider-agnostic orchestration primitives

### `apps/web` and `apps/desktop`
- Collect user input and workspace context
- Render streaming responses and diffs
- Submit user approvals for destructive actions
- Keep UI separate from provider logic

## Implementation sequence

1. Define shared protocol types in `packages/protocol`.
2. Implement the registry and routing policy.
3. Build one provider adapter first.
4. Add health checks and circuit breakers.
5. Add fallback chain across providers.
6. Add streaming and tool-call handling.
7. Add Fastify routes for HTTP access.
8. Add metrics and provider usage logging.
9. Add secret redaction and safety validation.
10. Add additional providers one by one.
11. Add local model support last to avoid blocking the cloud path.

## Class responsibilities

```ts
export interface ModelGatewayController {
  handleGenerate(request: AIRequest): Promise<AIResponse>;
  handleStream(request: AIRequest): Promise<AsyncIterable<AIStreamEvent>>;
  handleEmbed(request: ProviderEmbedRequest): Promise<ProviderEmbedResponse>;
  handleRerank(request: ProviderRerankRequest): Promise<ProviderRerankResponse>;
}
```

### Controller
- Validates input
- Builds execution context
- Delegates to router and adapter
- Returns the final response

### Router
- Selects candidate models
- Filters by capability and health
- Chooses a primary and fallback chain

### Adapter
- Converts a unified request into provider-specific API calls
- Normalizes provider responses into the shared format

### Validator
- Checks safety and quality before output is returned
- Rejects malformed tool calls or unsafe content

### Telemetry
- Tracks cost, latency, success rate, and model usage by request kind

### HTTP API
- `POST /ai/generate`
- `POST /ai/stream`
- `POST /ai/embed`
- `POST /ai/rerank`
- `GET /health`
- `GET /health/live`
- `GET /health/ready`
- `GET /health/providers`

## Recommended module contracts

- Use the interfaces in `packages/protocol` as the source of truth.
- Keep provider adapter code isolated behind the `ProviderAdapter` contract.
- Keep the routing policy deterministic and testable.
- Store provider metadata in a registry, not in UI code.
- Use Fastify for the gateway HTTP layer and plugin encapsulation.

## Minimal first implementation

Start with these pieces:

- `registry.ts`
- `policy-engine.ts`
- `fallback.ts`
- `health-check.ts`
- `circuit-breaker.ts`
- `anthropic-adapter.ts`
- `response-validator.ts`
- `routes/ai.ts`
- `routes/health.ts`
- `server.ts`
- `packages/protocol/src/ai.ts`
- `packages/protocol/src/provider.ts`
- `packages/protocol/src/validation.ts`

This gives a working path for one premium provider plus future expansion.
