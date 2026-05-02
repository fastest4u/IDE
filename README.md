# My IDE

AI-first IDE monorepo for Web and Desktop clients.

## Architecture

- `apps/web` — browser-based IDE client (React + Vite + Monaco, VS Code-like shell)
- `apps/desktop` — Tauri desktop client (placeholder)
- `apps/api` — API entrypoint (placeholder, no package manifest)
- `apps/worker` — background worker (placeholder, no package manifest)
- `services/model-gateway` — Fastify gateway: provider routing, fallback, load balancing, AI orchestration, workspace editing, patch lifecycle, terminal, settings
- `services/ai-gateway` — AI gateway (placeholder, echo scripts only)
- `services/collaboration` — realtime shared editing (placeholder, source only)
- `services/workspace-host` — remote workspace runtime (placeholder, source only)
- `packages/ai-core` — provider-agnostic AI orchestration: context building, role collaboration, compaction, agent loading
- `packages/workspace-core` — filesystem indexing, project detection, search, Obsidian KB
- `packages/protocol` — shared contracts: AI request/response, provider adapters, memory, patches, collaboration, settings, validation
- `packages/runtime-core` — process and terminal abstractions (source only)
- `packages/editor-core` — editor state and operations (source only)
- `packages/sync-core` — realtime sync primitives (source only)
- `packages/ui` — shared UI components (source only)
- `packages/shared` — utilities and core primitives (source only)
- `packages/config` — shared configuration presets (source only)

> **Note:** Only `packages/ai-core`, `packages/protocol`, `packages/workspace-core`, and `services/model-gateway` have their own `package.json` and are real workspace packages. The rest are source-only directories.

## Quick Start

```bash
pnpm install
pnpm dev          # starts web (5173) + model-gateway (3001)
pnpm dev:web      # web shell only
pnpm dev:model-gateway  # gateway only
```

## AI Provider Model

The IDE uses a provider-agnostic AI layer with many providers and many models.
Routing is based on task type, cost, quality, capabilities, and health.
Supported adapters: OpenAI-compatible (OpenAI/Gemini/DeepSeek/Mistral/vLLM), Ollama (native), Anthropic (placeholder).
See `docs/architecture/ai-provider-architecture.md`.

## Core Principles

- Keep UI separate from AI orchestration
- Keep provider integration in the model gateway layer
- Keep contracts type-safe via `packages/protocol`
- Keep shared logic in packages, not apps
- Use fallback and load balancing across multiple AI providers
- IDE owns context memory — changing providers does not erase task state
- All AI edits go through reviewable patch cards with approval before apply
