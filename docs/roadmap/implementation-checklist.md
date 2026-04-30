---
title: Implementation Checklist
created: 2026-04-29
status: active
type: checklist
tags:
  - roadmap
  - project/my-ide
  - ide/ai-first
aliases:
  - Build Checklist
  - IDE Implementation Tasks
---

# Implementation Checklist

ใช้ checklist นี้เป็น task board แบบง่ายใน Obsidian. รายละเอียด phase อยู่ใน [[ai-first-ide-roadmap]].

> [!important] Order
> ทำให้ model gateway รันได้ก่อน แล้วค่อยเพิ่ม provider จริง, routing, memory, workspace intelligence, และ multi-model collaboration.

## Phase 0: Repo Baseline

- [x] Create `AGENTS.md`.
- [x] Create [[ai-first-ide]] MOC.
- [x] Create [[ai-first-ide-vision|AI-First IDE Vision]].
- [x] Create [[current-state-gap-analysis]].
- [x] Create [[provider-mesh-routing]].
- [x] Create [[context-memory-orchestration]].
- [x] Create [[0003-provider-mesh-and-context-memory]].
- [x] Create [[obsidian-vault-guide]].
- [x] Create [[architecture-index]].

## Phase 1: Runnable Model Gateway

- [x] Add `services/model-gateway/package.json`.
- [x] Add `services/model-gateway/tsconfig.json`.
- [x] Add `fastify` dependency to the workspace lockfile.
- [x] Add `dev`, `build`, `typecheck`, and route validation scripts.
- [x] Make `GET /health` runnable locally.
- [x] Make `POST /ai/generate` return a typed placeholder response through the package script.
- [x] Make `POST /ai/stream` stream SSE through the package script.
- [x] Make patch routes runnable from the same server.
- [x] Document exact gateway commands in `AGENTS.md`.

## Phase 2: Provider Mesh MVP

- [x] Wire `AIRouterEngine.route()` to `InMemoryModelRegistry`.
- [x] Wire `AIRouterEngine.route()` to `BasicPolicyEngine`.
- [x] Wire health snapshot into routing decisions.
- [x] Wire `CircuitBreaker` into provider selection.
- [x] Replace placeholder execution with adapter lookup by `providerId`.
- [x] Add provider config format for `apiKey`, `baseUrl`, model list, timeout.
- [x] Add one real cloud adapter (`OpenAICompatibleAdapter`).
- [x] Add one local/custom adapter path (`OllamaAdapter`).
- [x] Record `UsageRecord` for success, fallback, and failure.

## Phase 3: Context And Memory MVP

- [x] Add `ContextPacket` protocol type.
- [x] Add `MemoryRecord` protocol type.
- [x] Add `TaskState` protocol type.
- [x] Add `ProviderUsageOutcome` protocol type.
- [x] Add context builder contract in `packages/ai-core`.
- [x] Add in-memory session memory store.
- [x] Persist task goal, decisions, patch status, warnings, and handoff summary.
- [x] Send real `sessionId` from web chat flow.
- [x] Add memory summary to gateway request metadata.

## Phase 4: Workspace Intelligence

- [x] Add workspace file index contract in `packages/workspace-core`.
- [x] Add workspace search abstraction.
- [x] Add repo summary generation path.
- [x] Add diagnostics ingestion path.
- [x] Add terminal output context path.
- [x] Add retrieval of relevant docs/source chunks.
- [x] Add token budget and compression rules.

## Phase 5: Safe Patch Workflow

- [x] Add workspace root guard to `WorkspaceWriter`.
- [x] Prevent absolute path and path traversal writes.
- [x] Store patch as diff or structured operation instead of raw full-file write.
- [x] Add apply failure state with error notes.
- [x] Add rollback plan for applied patches.
- [x] Connect web patch cards to backend patch store.
- [x] Store accepted/rejected/applied patch outcome as episodic memory.

## Phase 6: Multi-Model Collaboration

- [x] Define role outputs for planner, context curator, coder, reviewer, verifier, synthesizer.
- [x] Add orchestration contract in `packages/ai-core`.
- [x] Add routing support for role-based model selection.
- [x] Add shared context packet handoff per role.
- [x] Add synthesizer step for final answer or patch plan.
- [x] Record provider performance by role and task kind.

## Phase 7: Desktop And Local-First

- [x] Reuse web shell boundaries for desktop.
- [x] Add local provider settings for Ollama/vLLM.
- [x] Add privacy mode that forces `localOnly` routing.
- [x] Add settings UI for provider/model/policy/memory.
- [x] Store memory local-first by workspace or app data path.

## Phase 8: Real Workspace Editing

- [x] Load Explorer file list from `/workspace/files`.
- [x] Load Monaco editor content from `/workspace/file`.
- [x] Add guarded workspace save endpoint.
- [x] Add dirty state and save/reload UI.
- [x] Surface file load/save errors in the shell.
- [x] Send real active file/open files/selection context into AI requests.

## Phase 9: Real Terminal

- [x] Add PTY-backed terminal session service.
- [x] Add terminal transport for output streaming and user input.
- [x] Restrict terminal cwd to workspace root.
- [x] Add kill/restart terminal controls.
- [x] Replace static terminal UI with real terminal output.
- [x] Feed selected/recent terminal output into AI context.

## Phase 10: AI Patch End-To-End

- [x] Define structured patch tool schema for providers.
- [x] Add provider prompt/tool instructions for `PatchCreateRequest`.
- [x] Persist streamed patch tool calls as backend patch records.
- [x] Render AI-created patch diffs in patch cards.
- [x] Add precondition mismatch feedback in UI.
- [x] Add reviewer/verifier checks before user approval.

## Phase 11: Settings And Provider Runtime

- [x] Hot-reload provider registry/adapters after `/settings` updates.
- [x] Show provider/model health in settings UI.
- [x] Add provider test-connection endpoint.
- [x] Warn/block when `localOnly` has no reachable local model.
- [x] Add per-workspace provider/policy overrides.

## Phase 12: Persistence And Safety Hardening

- [x] Persist patch store to local file or SQLite.
  - Implemented as a file-backed patch store persisted under the IDE data dir.
- [x] Persist workspace-specific settings.
  - Added workspace override persistence and a dedicated route to add/remove per-workspace overrides.
- [x] Add audit log for approve/apply/rollback.
  - Added a local audit log service wired during gateway bootstrap.
- [x] Add allowlist/denylist path policy.
  - Added workspace-relative path guards for workspace file access and protected-path checks in the writer.
- [x] Add file operation limits for save/patch/terminal.
  - Added route-level validation for workspace writes, patch operations, command input size, and terminal write payloads.
- [x] Add repeatable validation workflow for CI/local checks.
  - Confirmed with lints after each hardening step; should be extended with a dedicated script in a later phase.
- [x] Add basic auth/origin guard for write/terminal endpoints.
  - Added an origin/body-size request guard in the gateway bootstrap.

## Phase 13: Desktop App Packaging

- [ ] Choose Tauri or Electron.
- [ ] Reuse `apps/web` shell in the desktop app.
- [ ] Launch/connect local model-gateway from desktop.
- [ ] Wire desktop app data path to `IDE_DATA_DIR`.
- [ ] Add open folder/recent workspace/settings desktop actions.
- [ ] Package macOS build first.

## Related Notes

- [[ai-first-ide-roadmap]]
- [[architecture-index]]
- [[current-state-gap-analysis]]
