---
title: AI-First IDE Roadmap
created: 2026-04-29
status: draft
type: roadmap
tags:
  - roadmap
  - ide/ai-first
  - project/my-ide
aliases:
  - IDE Roadmap
---

# AI-First IDE Roadmap

Roadmap นี้เรียงตาม dependency จริงของ repo: ทำให้ service รันได้ก่อน, แล้วค่อยเพิ่ม provider routing, memory, tools, และ multi-model collaboration.

> [!tip]
> ใช้ [[implementation-checklist]] เป็น task board สำหรับติดตามงานราย phase.

## Phase 0: Repo Baseline

- สร้าง `AGENTS.md` และเอกสาร Obsidian ชุดหลัก.
- ยืนยันคำสั่ง root: `pnpm install`, `pnpm dev`, `pnpm build`, `pnpm typecheck`.
- แยก verified current state ออกจาก future docs ใน [[current-state-gap-analysis]].

Exit criteria: contributor ใหม่เปิด repo แล้วรู้ว่าอะไรใช้ได้จริง อะไรยังเป็น skeleton.

## Phase 1: Runnable Model Gateway

- เพิ่ม package manifest และ tsconfig ให้ `services/model-gateway`.
- เพิ่ม `fastify` dependency และ script สำหรับ dev/build/typecheck.
- ทำให้ `/health`, `/ai/generate`, `/ai/stream`, `/patches` รันได้จริงจาก workspace script.
- เพิ่ม minimal tests หรือ validation script สำหรับ route contract.

Status: baseline complete. `services/model-gateway` now has package scripts and smoke tests, but responses are still placeholder until Phase 2 wires real routing/adapters.

Exit criteria: web shell เรียก gateway local ได้โดยไม่ต้องเดาคำสั่งเอง.

## Phase 2: Provider Mesh MVP

- ต่อ `AIRouterEngine` เข้ากับ registry, policy engine, health check, circuit breaker, fallback planner.
- เพิ่ม provider config format สำหรับ API key/baseUrl/model list โดยไม่ใส่ key ใน UI.
- สร้าง adapter จริง 1 เจ้าและ local/custom adapter 1 ตัว.
- เพิ่ม usage log ต่อ request พร้อม selected provider/model.

Status: complete. `AIRouterEngine` now uses registry/policy/health/circuit/fallback. `OpenAICompatibleAdapter` and `OllamaAdapter` are wired. `UsageLog` records successful executions and fallback-success paths. `createModelGatewayServer()` accepts `providerConfigs` to register providers at startup.

Exit criteria: request เดียวสามารถเลือก model จาก registry และ fallback ได้จริง.

## Phase 3: Context And Memory MVP

- เพิ่ม `ContextPacket`, `MemoryRecord`, `TaskState` ใน protocol.
- สร้าง context builder provider-agnostic ใน `packages/ai-core`.
- สร้าง session memory store แบบ in-memory หรือ local JSON/SQLite.
- บันทึก task goal, decisions, patch status, และ handoff summary.

Status: complete. `packages/protocol/src/memory.ts` has all protocol types. `ContextBuilderService` in `@ide/ai-core` builds context packets and augments prompts. `InMemorySessionStore` persists sessions with decisions, constraints, patch history, provider usage, and handoff summaries. Session routes at `/sessions/:sessionId` expose state.

Exit criteria: เปลี่ยน provider/model ใน task เดิมแล้วยังส่ง context packet เดียวกันได้.

## Phase 4: Workspace Intelligence

- เติม `packages/workspace-core` ให้มี file index, search, symbols, repo summary.
- ส่ง active file, open files, git diff, diagnostics, terminal output เข้า context builder.
- เพิ่ม retrieval ของ docs/source chunks ที่เกี่ยวข้องกับ task.

Status: complete. `packages/workspace-core` has `InMemoryWorkspaceIndex` (file indexing, classification, repo summary), `WorkspaceSearch` interface, `WorkspaceContextProvider`. `WorkspaceContextService` in model-gateway scans real directories, reads files, searches by content. Context builder auto-injects repo summary and workspace files into every prompt. `/workspace/index`, `/workspace/summary`, `/workspace/files`, `/workspace/search` routes operational.

Exit criteria: AI ตอบโดยอ้างอิงโครงสร้าง repo จริง ไม่ต้อง paste context เองทุกครั้ง.

## Phase 5: Safe Patch Workflow

- เพิ่ม path guard และ workspace root guard ให้ `WorkspaceWriter`.
- เปลี่ยน patch content เป็น diff/operation format ที่ตรวจสอบได้.
- เพิ่ม apply/rollback status และ error handling.
- ผูก patch cards ใน UI กับ backend patch store จริง.

Status: complete. Patch records now use structured operations and structured diff previews from `@ide/protocol`. `WorkspaceWriter` denies absolute paths, traversal, workspace-root targets, `.git`, and `node_modules`; apply requires approval and stores rollback snapshots. `/patches` supports create, inspect, approve, reject, apply, and rollback; patch outcomes are recorded into session memory. Web patch cards load from the backend store and expose approve/reject/apply/rollback actions.

Exit criteria: AI edit ทุกครั้งมี patch record, review, apply result, และ memory outcome.

## Phase 6: Multi-Model Collaboration

- เพิ่ม role-based orchestration: planner, context curator, coder, reviewer, verifier, synthesizer.
- เพิ่ม routing strategy สำหรับ committee/ensemble ถ้าจำเป็น.
- ให้แต่ละ role รับ context packet และส่ง structured output กลับ orchestrator.
- บันทึก model performance ต่อ role/task kind.

Status: complete. `packages/protocol` now defines collaboration roles, role specs, role outputs, and collaboration request/response contracts. `packages/ai-core` has `RoleOrchestrationService` for role plans, shared context packet handoff, role prompts, synthesizer output, and failure outputs. `services/model-gateway` exposes `POST /ai/collaborate`, routes every role through the provider mesh, records role/task performance metadata, and stores role outputs in session memory.

Exit criteria: งาน refactor ใหญ่สามารถแบ่งหลาย model ทำร่วมกันโดย context ไม่หลุด.

## Phase 7: Desktop And Local-First

- ทำ desktop shell หลัง web workflow เสถียร.
- รองรับ local provider เช่น Ollama/vLLM สำหรับ privacy/offline mode.
- เพิ่ม settings UI สำหรับ provider/model/policy/memory controls.

Status: backend complete. `packages/protocol` defines local-first settings contracts. `services/model-gateway` persists settings and session memory under `IDE_DATA_DIR` or `~/.my-ide`, exposes `/settings`, registers local Ollama/vLLM provider configs, and forces `localOnly` routing when privacy mode is enabled. Provider/runtime settings are accessible through the agent manager modal's Settings tab (`ProviderSettings.tsx`). `apps/desktop` still exports a web-shell reuse boundary placeholder.

Exit criteria: ใช้งานเป็น IDE ส่วนตัวแบบ local-first ได้ ไม่ผูกกับ provider เจ้าเดียว.

## Phase 8: Real Workspace Editing

- ต่อ Explorer กับ `/workspace/files` แทน mock file list.
- ต่อ Monaco editor กับ `/workspace/file` เพื่อเปิดไฟล์จริงจาก workspace index.
- เพิ่ม guarded save-file endpoint ใน model-gateway โดยใช้ workspace root/path guard เดียวกับ patch writer.
- เพิ่ม dirty state, save/reload action, file load errors, และ file-size guard ใน web shell.
- ทำให้ active file, selected text, open files, และ diagnostics ที่ส่งเข้า AI มาจาก workspace จริง.

Status: complete. `services/model-gateway` now auto-indexes the configured workspace root on server ready, returns relative workspace file paths, exposes guarded `PUT /workspace/file`, enforces file-size and conflict checks, and re-indexes after save. `apps/web` loads Explorer and Monaco content from workspace routes, tracks dirty state, supports save/reload, surfaces load/save errors, sends real active file/open files/selection context into AI requests, and requires explicit workspace selection on each fresh launch/reload before entering the shell.

Exit criteria: ใช้ web shell เป็น editor พื้นฐานกับ repo จริงได้: เปิดไฟล์, แก้, save, reload และส่ง active file context เข้า AI ได้จริง.

## Phase 9: Real Terminal

- เพิ่ม terminal session service ฝั่ง model-gateway หรือ workspace-host โดยใช้ PTY จริง.
- เพิ่ม transport สำหรับ terminal I/O เช่น WebSocket หรือ SSE + command input endpoint.
- จำกัด terminal cwd ให้อยู่ใต้ workspace root และรองรับ restart/kill session.
- ต่อ UI terminal ให้รับ input/output จริงแทน static `pnpm dev`.
- ส่ง terminal output ที่เลือกเข้า `AIRequestContext.terminalOutput`.

Status: complete. `services/model-gateway` exposes PTY-backed terminal sessions through `/terminal/exec`, `/terminal/:sessionId/stream`, `/terminal/:sessionId/write`, `/terminal/:sessionId/kill`, and `/terminal/:sessionId/restart`, all scoped to the active workspace root. `apps/web` renders a live terminal dock, polls recent output, streams session output, and feeds terminal output into AI request context when enabled.

Exit criteria: รันคำสั่ง dev/test/typecheck จาก IDE ได้ และ AI สามารถอ้างอิง terminal output ล่าสุดได้.

## Phase 10: AI Patch End-To-End

- กำหนด structured patch tool schema ที่ map ตรงกับ `PatchCreateRequest`.
- เพิ่ม prompt/tool instruction ให้ provider ส่ง patch operations ที่ตรวจสอบได้.
- ทำให้ streamed tool call สร้าง backend patch record จริงทุกครั้งที่ AI เสนอ edit.
- แสดง structured diff, precondition mismatch, apply result, และ rollback result ใน patch card.
- เพิ่ม verifier/reviewer role ที่ตรวจ patch ก่อน user approve.

Status: complete. `packages/protocol/src/patch.ts` exports `AI_PATCH_TOOL_SPEC` and patch tool instructions that map directly to `PatchCreateRequest`. Edit/refactor requests now auto-attach patch tool instructions, OpenAI-compatible adapters send/parse tool calls, streamed patch tool calls are persisted as backend patch records, and patch cards render AI-created diffs plus verifier findings. Patch approval re-runs deterministic precondition checks and blocks stale patches before apply.

Exit criteria: คุยกับ AI แล้วได้ patch card ที่ review/apply/rollback ได้ครบ end-to-end โดยไม่ต้อง copy code เอง.

## Phase 11: Settings And Provider Runtime

- ทำ provider registry/adapters hot-reload เมื่อ `/settings` เปลี่ยน local providers หรือ privacy policy.
- เพิ่ม provider/model status ใน settings UI เช่น reachable, healthy, selected models, latency.
- เพิ่ม test-connection endpoint สำหรับ Ollama/vLLM/OpenAI-compatible providers.
- ถ้าเปิด `localOnly` แต่ไม่มี local model ที่ใช้ได้ ต้อง warning และ block cloud fallback.
- เพิ่ม per-workspace provider/policy overrides โดยไม่ปน global settings.

Status: runtime complete. `/settings` updates now reload the model registry and provider adapter map without gateway restart while preserving static provider configs. `/settings/provider-status`, `/health/providers`, and `POST /settings/providers/:providerId/test` expose runtime health/model status. `localOnly` settings are rejected when no reachable local model exists, and workspace overrides can constrain policy/provider routing per workspace. Provider settings are accessible through the agent manager modal's Settings tab.

Exit criteria: เปลี่ยน provider, model, privacy mode, และ memory policy จาก UI หรือ API แล้วมีผลโดยไม่ restart gateway.

## Phase 12: Persistence And Safety Hardening

- persist patch store ลง local file หรือ SQLite แทน in-memory.
- persist workspace-specific settings และ audit log ต่อ repo.
- เพิ่ม audit log สำหรับ approve/apply/rollback พร้อม user/session/time.
- เพิ่ม allowlist/denylist path policy และ file operation limits สำหรับ save/patch/terminal.
- เพิ่ม validation config จริง: CI script, test runner, web build, model-gateway smoke, path guard tests.
- เพิ่ม basic auth/origin guard สำหรับ endpoint ที่เขียนไฟล์หรือรัน terminal.

Status: baseline complete. `services/model-gateway` now persists patch records through a file-backed store under `IDE_DATA_DIR`, normalizes and persists global/workspace settings, stores workspace overrides through settings update flows, and writes an audit log bootstrap trail. `WorkspaceWriter` continues to enforce workspace-relative path safety, while `/workspace/file`, `/patches`, and `/terminal/*` routes add request/path/command limits and origin/body guards for write operations. The gateway boot sequence hydrates persisted patch state and loads settings from disk before the workspace root is attached, so restarts preserve patch and settings state safely. Repo-wide CI/lint/test infrastructure is still missing, so this phase is not “fully hardened” yet.

Exit criteria: restart แล้ว state สำคัญไม่หาย, file-write/terminal endpoints มี guard ชัดเจน, และมี validation workflow ที่รันซ้ำได้.

## Phase 13: Desktop App Packaging

- เลือก Tauri หรือ Electron หลัง web workflow เสถียร.
- Reuse `apps/web` shell และ service-layer boundaries เดิม.
- Launch หรือ connect local model-gateway จาก desktop app.
- ผูก app data path เข้ากับ `IDE_DATA_DIR` และ settings service.
- เพิ่ม desktop actions: open folder, recent workspace, settings, terminal, quit/reload.
- package macOS ก่อน แล้วค่อยขยาย platform อื่น.

Exit criteria: เปิดเป็น desktop app ได้โดยไม่ต้องรัน web/gateway ด้วยมือ และยังใช้ local-first settings/memory path เดียวกัน.

## Immediate Priority

1. ทำ Phase 13 ต่อ เพื่อ package desktop app รอบ web shell + local gateway boundary ที่มีอยู่แล้ว.
2. ออกแบบ multi-workspace runtime ให้เก็บ root/state แยกกัน แทน single mutable workspace root ใน gateway เดียว.
3. เพิ่มทางเข้า settings/runtime controls ใน shell ใหม่ถ้ายังต้องการควบคุม provider จาก UI.
4. ขยาย validation workflow ให้เกินระดับ smoke/build checks ไปสู่ CI หรือ repeatable local verification.

## Related Notes

- [[ai-first-ide]]
- [[implementation-checklist]]
- [[ai-first-ide-vision|AI-First IDE Vision]]
- [[provider-mesh-routing]]
- [[context-memory-orchestration]]
- [[0003-provider-mesh-and-context-memory]]
