# My IDE

AI-first IDE monorepo for Web and Desktop clients.

## Architecture

- `apps/web` — browser-based IDE client
- `apps/desktop` — Tauri desktop client
- `services/gateway` — request entrypoint and auth
- `services/ai-orchestrator` — task classification and AI workflow coordination
- `services/model-gateway` — provider routing, fallback, and load balancing
- `services/workspace` — remote workspace runtime and indexing
- `services/execution` — terminal, test, and build execution
- `services/collaboration` — realtime shared editing
- `packages/ai-core` — provider-agnostic AI orchestration primitives
- `packages/workspace-core` — filesystem, project indexing, and search
- `packages/runtime-core` — process and terminal abstractions
- `packages/editor-core` — editor state and operations
- `packages/sync-core` — realtime sync primitives
- `packages/ui` — shared UI components
- `packages/protocol` — shared contracts and schemas
- `packages/shared` — utilities and core primitives
- `packages/config` — shared configuration presets

## AI Provider Model

The IDE uses a provider-agnostic AI layer with many providers and many models.
Routing is based on task type, cost, quality, capabilities, and health.
See `docs/architecture/ai-provider-architecture.md`.

## Core principles

- Keep UI separate from AI orchestration
- Keep provider integration in the model gateway layer
- Keep contracts type-safe via `packages/protocol`
- Keep shared logic in packages, not apps
- Use fallback and load balancing across multiple AI providers
