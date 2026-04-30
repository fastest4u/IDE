---
title: Current State Gap Analysis
created: 2026-04-29
status: draft
type: architecture
tags:
  - architecture/gap-analysis
  - ide/ai-first
  - project/my-ide
aliases:
  - Current State
  - Gap Analysis
---

# Current State Gap Analysis

เอกสารนี้แยกสิ่งที่ repo มีจริงออกจากสิ่งที่เป็น target architecture เพื่อกัน agent หรือ contributor เข้าใจผิดว่า runtime ปัจจุบันพร้อม production หรือรองรับทุก use case แล้ว.

> [!warning] Verified Constraint
> ให้เชื่อ executable config ก่อน prose docs. ตอนนี้ root lockfile มี importer คือ `.`, `packages/ai-core`, `packages/protocol`, `packages/workspace-core`, `services/ai-gateway`, และ `services/model-gateway`; หลาย directory อื่นใน `apps/*`, `packages/*`, `services/*` ยังไม่มี package manifest ของตัวเอง.

## มีอยู่จริงแล้ว

| Area | Current files | สถานะ |
| --- | --- | --- |
| Web shell | `apps/web/src/main.tsx`, `apps/web/src/app.tsx` | React shell แบบ VS Code เปิด/แก้/save ไฟล์จาก workspace จริงได้, มี explorer/editor/agent/terminal layout |
| Workspace selection | `apps/web/src/components/workspace-selector.tsx`, `services/model-gateway/src/routes/workspace.ts` | บังคับให้ผู้ใช้เลือก workspace ทุกครั้งที่เปิด/reload shell; recent workspaces เก็บใน browser local storage |
| Web tooling | `apps/web/vite.config.ts` | Vite dev server ที่ `0.0.0.0:5173` |
| AI/workspace transport client | `apps/web/src/services/model-gateway.ts` | hardcode gateway URL เป็น `http://127.0.0.1:3001`, มี AI/patch/settings/workspace/terminal API client |
| Protocol contracts | `packages/protocol/src/*.ts` | มี AI request, provider adapter, validation, patch, settings, และ memory contracts ที่ใช้ร่วมกัน |
| Model gateway package | `services/model-gateway/package.json`, `src/server.ts` | Fastify gateway รันได้ด้วย `pnpm dev:model-gateway` และ smoke test ได้ |
| Routing engine | `services/model-gateway/src/router/*` | route ผ่าน registry/policy/health/circuit/fallback และ adapter lookup แล้ว |
| Provider adapters | `services/model-gateway/src/adapters/*` | OpenAI-compatible/Ollama ใช้งานเป็น adapter path ได้, Anthropic ยังเป็น placeholder |
| Safety services | `services/model-gateway/src/safety/*`, `src/security/request-guard.ts` | มี redaction, prompt guard, response validator, origin/body-size guard แบบ baseline |
| Patch flow | `services/model-gateway/src/patches.ts`, `routes/patches.ts` | มี structured operations, path guard, AI patch tool calls, verifier review, approve/apply/rollback; patch store persist ลง `patches.json` |
| Workspace editing | `services/model-gateway/src/routes/workspace.ts`, `memory/workspace-context.ts` | index workspace, list/read relative paths, guarded save, conflict check, file-size guard |
| Terminal | `services/model-gateway/src/routes/terminal.ts`, `src/terminal/terminal-session.ts`, `apps/web/src/components/terminal.tsx` | มี PTY-backed terminal session, cwd guard, input/output, restart/kill controls |
| Collaboration | `packages/ai-core/src/collaboration.ts`, `/ai/collaborate` | มี role orchestration และ synthesizer output ผ่าน provider mesh |
| Local-first settings | `services/model-gateway/src/settings.ts`, `/settings` | มี settings persistence, privacy `localOnly`, local provider config, provider hot-reload/status/test, workspace overrides, session memory file; shell ปัจจุบันยังไม่ mount settings panel แยก |

## ยังเป็น gap สำคัญ

- ยังไม่มี test framework, lint config, formatter config, CI, pre-commit, หรือ codegen config.
- `services/model-gateway` ยังถือ active workspace root ได้ทีละค่าเดียวต่อ process; การสลับ workspace จะมีผลกับ terminal, patch writer, และทุก client ที่ใช้ gateway instance เดียวกัน.
- Shell ปัจจุบันซ่อน dedicated settings UI ออกไปแล้ว แม้ backend settings/runtime API จะยังทำงานครบ.
- Endpoint ฝั่งเขียนไฟล์/terminal มี origin และ body-size guard แล้ว แต่ยังไม่มี user auth; runtime นี้ยังตั้งอยู่บนสมมติฐานว่าใช้ใน local trusted environment.

## เพิ่งทำเสร็จ

### Phase 4 Workspace Intelligence

- `@ide/workspace-core` เป็น workspace package: `InMemoryWorkspaceIndex` (scan directory, classify files, generate repo summary), `WorkspaceSearch`, `WorkspaceContextProvider`.
- `WorkspaceContextService` ใน model-gateway: index real workspace, search files by content, read files with path guard.
- `/workspace/index`, `/workspace/summary`, `/workspace/files`, `/workspace/search`, `/workspace/file` routes.
- Context builder injects `repoSummary`, `workspaceFiles`, `workspaceContext` into every prompt.
- Controller auto-enriches requests with workspace data before provider call.

### Phase 5-7 AI Workflow And Local-First

- Safe patch workflow: structured patch operations, diff preview, guarded apply, rollback plan, session memory outcome.
- Multi-model collaboration: planner/context curator/coder/reviewer/verifier/synthesizer roles through `/ai/collaborate`.
- Local-first settings: `/settings`, local Ollama/vLLM config, privacy `localOnly`, session persistence under `IDE_DATA_DIR` or `~/.my-ide`.

### Phase 8 Real Workspace Editing

- `WorkspaceContextService` now returns workspace-relative file paths, uses the same `WorkspaceWriter` path guard as patch writes, and supports strict read plus guarded save.
- `PUT /workspace/file` saves content with file-size checks and `expectedContent` conflict detection; stale saves return `409`, path traversal returns `400`.
- `createModelGatewayServer()` auto-indexes the configured workspace root on Fastify ready, while `/workspace/index` can still switch roots.
- `apps/web` Explorer and Monaco editor now load real workspace files, track dirty state, save/reload through the gateway, and send real active file/open files/selection context into AI requests.
- `AppShell` only enters the editor after explicit workspace selection; the active workspace root is carried in router search state and rendered in the explorer.

### Phase 9-10 Terminal And AI Patch End-To-End

- Terminal service supports PTY-backed sessions, guarded cwd, command input, output polling, restart, and kill controls in the web shell.
- `AI_PATCH_TOOL_SPEC` and prompt instructions let providers emit structured patch operations instead of pasted code.
- `OpenAICompatibleAdapter` sends/parses tool calls; streamed `ide_create_patch` calls create backend patch records and return patch ids to the UI.
- Patch cards show AI-created structured diffs, verifier findings, precondition mismatch notes, apply results, and rollback results.
- Patch approval re-runs deterministic reviewer/verifier checks and blocks stale `beforeContent` before apply.

### Phase 11 Settings And Provider Runtime

- `/settings` updates reload provider registry/adapters without restarting the gateway, while static provider configs remain registered.
- `/settings/provider-status`, `/health/providers`, and `POST /settings/providers/:providerId/test` expose provider/model health and test results.
- `localOnly` policy updates are rejected when no reachable local model exists; AI requests also fail fast instead of falling back to cloud.
- `workspaceOverrides` support per-workspace policy and local-provider constraints.
- `apps/web` still has transport/query support for provider runtime status, but the current shell does not mount a dedicated settings panel.

## ความเสี่ยงที่ควรแก้ก่อนต่อยอด

- Multi-workspace isolation ยังไม่มี; root เดียวถูกแชร์ข้าม explorer, terminal, patch writer, และ AI context ใน gateway instance เดียว.
- ถ้าจะเปิดใช้ gateway นอก local trusted environment ต้องเพิ่ม auth จริงเหนือ origin/body guard ที่มีอยู่.

## Recommended Next Work

- Phase 13: desktop packaging และ native open-folder/recent-workspace actions.
- ออกแบบ multi-workspace runtime ให้เก็บ root/state แยกกันแทน single mutable workspace root.

## Related Notes

- [[ai-first-ide]]
- [[architecture-index]]
- [[ai-first-ide-vision|AI-First IDE Vision]]
- [[provider-mesh-routing]]
- [[context-memory-orchestration]]
- [[ai-first-ide-roadmap]]
- [[implementation-checklist]]
