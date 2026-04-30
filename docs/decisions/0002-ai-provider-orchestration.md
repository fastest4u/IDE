---
id: 0002
title: Provider-agnostic AI orchestration
date: 2026-04-29
status: proposed
tags:
  - decision
  - ai
  - providers
  - routing
---

# Decision

Use a provider-agnostic AI orchestration layer with many provider adapters, model routing, and fallback.

## Context

The IDE should support many AI providers and many models so it can optimize for:

- code quality
- latency
- cost
- context length
- tool use
- reasoning depth
- local/offline availability

## Decision details

- Keep provider-specific code in a model gateway layer
- Keep orchestration and task planning in `ai-core`
- Route requests by task type and policy scores
- Use health checks, retries, and circuit breakers
- Support cloud and local providers equally

## Consequences

### Positive
- Lower vendor lock-in
- Better resilience
- Better task-specific model selection
- Easier experimentation with new providers

### Trade-offs
- More operational complexity
- More metrics and health monitoring required
- More adapter maintenance

## Follow-up actions

- Define the provider adapter interface
- Define routing policy metadata
- Add observability for provider usage
- Implement fallback tiers for degraded mode
