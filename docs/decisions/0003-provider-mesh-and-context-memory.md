---
id: 0003
title: Provider mesh and IDE-owned context memory
date: 2026-04-29
status: proposed
type: decision
tags:
  - decision
  - ai
  - provider-routing
  - memory
  - project/my-ide
aliases:
  - Provider Mesh Decision
---

# Decision

Use a central provider mesh plus IDE-owned context memory so the IDE can route work across many providers/models while preserving task context across provider changes, model changes, and future multi-model collaboration.

## Context

The product goal is an AI-first IDE similar in spirit to OpenCode/Cursor, but with first-class support for multiple AI providers, load balancing, fallback, local models, and memory that belongs to the IDE rather than any single provider session.

The repo already has:

- `packages/protocol` with AI request, provider adapter, routing, validation, patch, settings, and memory contracts.
- `services/model-gateway` as a runnable Fastify package with real provider execution, settings persistence, workspace indexing/editing, file-backed patch storage, and PTY-backed terminal routes.
- `apps/web` with explicit workspace selection, real explorer/editor/save flows, AI chat transport, terminal output context, and reviewable patch cards.

Current constraints that still matter:

- the gateway keeps one mutable workspace root per process, so multi-workspace state is not isolated yet;
- embed/rerank paths are thinner than the main generate/stream/collaborate flows;
- the repo still lacks a full lint/test/CI toolchain.

## Decision Details

- `services/model-gateway` owns provider credentials, adapter execution, provider health, circuit breaking, fallback, load balancing, and usage telemetry.
- `packages/protocol` remains the shared contract source for request, context, provider, routing, validation, and future memory types.
- `packages/ai-core` should own provider-agnostic orchestration contracts: task planning, context building, memory selection, and response interpretation.
- Memory/context must be assembled before provider selection and passed as a normalized context packet to every provider/model.
- Provider/model conversation history is not the source of truth; IDE task memory is the source of truth.
- The UI must not call provider SDKs directly and must not store provider secrets.
- Multi-model collaboration should be modeled as roles over the same context packet: planner, context curator, coder, reviewer, verifier, synthesizer.

## Consequences

- Provider changes do not erase task context.
- Load balancing can use provider performance memory instead of static preferences.
- Local-only/privacy routing can be enforced centrally.
- More protocol and persistence work is still useful if memory is expanded beyond the current local session/workspace model.
- The model gateway now carries enough runtime responsibility that multi-workspace isolation and deeper validation become the next scaling constraints.

## Follow-Up Actions

- Expand automated validation around routing, settings, patches, terminal, and workspace save flows.
- Design a multi-workspace runtime model beyond the current single-root-per-process controller.
- Harden patch/terminal access further if the gateway is ever exposed beyond a trusted local environment.
- Evolve retrieval and memory beyond the current local session/workspace context path when semantic memory becomes necessary.

## Related Notes

- [[ai-first-ide]]
- [[architecture-index]]
- [[ai-first-ide-vision|AI-First IDE Vision]]
- [[provider-mesh-routing]]
- [[context-memory-orchestration]]
- [[current-state-gap-analysis]]
- [[ai-first-ide-roadmap]]
- [[implementation-checklist]]
