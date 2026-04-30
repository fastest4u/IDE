---
title: Project Map
created: 2026-04-29
---

# Project Map

## Root

- `apps/` runtime applications
- `packages/` shared logic and UI
- `services/` deployable infrastructure
- `docs/` architecture notes and decisions

## Apps

- `apps/web` — browser IDE shell and primary client
- `apps/desktop` — native shell for local workflows
- `apps/api` — backend API and coordination layer
- `apps/worker` — async background jobs

## Packages

- `packages/ai-core` — AI orchestration and tool routing
- `packages/workspace-core` — workspace, filesystem, indexing
- `packages/runtime-core` — terminal and process execution
- `packages/editor-core` — editor state and operations
- `packages/sync-core` — collaboration and sync primitives
- `packages/ui` — shared UI components
- `packages/protocol` — cross-boundary types and schemas
- `packages/shared` — utilities and shared primitives
- `packages/config` — shared configuration presets

## Services

- `services/gateway` — request gateway and auth
- `services/ai-orchestrator` — model routing and orchestration
- `services/workspace` — remote workspace runtime and indexing
- `services/execution` — command execution and jobs
- `services/collaboration` — realtime collaborative editing
- `services/model-gateway` — provider adapters, fallback, and load balancing

## Rules

- Apps depend on packages
- Services depend on packages
- Packages must not depend on apps
- AI logic stays in `ai-core`
- Provider integration stays in `services/model-gateway`
- UI stays in `ui`
- Contracts stay in `protocol`
