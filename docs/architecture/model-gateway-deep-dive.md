---
title: Model Gateway Deep Dive
created: 2026-04-30
status: draft
type: architecture
tags:
  - architecture/ai
  - ai/provider-routing
  - ai/context
  - ai/memory
  - project/my-ide
aliases:
  - Model Gateway Notes
  - Model Gateway Deep Dive
---

# Model Gateway Deep Dive

> [!important] Scope
> บันทึกนี้สรุปสิ่งที่อ่านจาก `services/model-gateway` แบบเชิงลึก โดยเน้น router, settings, workspace, patches, terminal, และ route layer ที่เชื่อมกับ web shell.

## บทสรุปสั้น

`model-gateway` คือ runtime แกนกลางของ AI-first IDE ที่ทำหน้าที่:

- route request ไป provider/model ที่เหมาะสม
- enforce local-first / localOnly policy
- build context จาก workspace และ session memory
- ดูแล patch lifecycle ตั้งแต่ create → review → approve → apply → rollback
- เปิด terminal session แบบ stream ได้

## โครงสร้างที่อ่านแล้ว

### 1) Bootstrap

- `services/model-gateway/src/server.ts`
- สร้าง Fastify server และ wire services ทั้งหมดเข้าด้วยกัน
- register routes สำหรับ AI, settings, workspace, patches, sessions, terminal
- resolve default workspace root จาก `options.workspaceRoot ?? IDE_WORKSPACE_ROOT ?? process.cwd()`
- hydrate persisted patch/settings/session state ใต้ data dir และผูก origin/body-size guard ระดับ request

### 2) AI Controller

- `services/model-gateway/src/controller.ts`
- เป็น orchestration layer ที่เชื่อม context builder, router, session store, workspace, patch service, และ settings
- แยก flow สำหรับ generate, stream, collaborate, embed, rerank

### 3) Routing

- `services/model-gateway/src/router/ai-router.ts`
- เลือก model จาก registry + health + breaker + fallback
- รองรับ `localOnly`, preferred capabilities, collaboration roles, และ strategy-based scoring

### 4) Policy

- `services/model-gateway/src/router/policy-engine.ts`
- scoring model ตาม latency, error rate, tier, capabilities, collaboration role, และ routing strategy

### 5) Settings

- `services/model-gateway/src/settings.ts`
- เก็บ policy, local providers, workspace overrides, memory settings, desktop settings
- normalize provider config เฉพาะ `ollama` และ `vllm`
- `routes/settings.ts` มี safety gate สำหรับ localOnly readiness

### 6) Workspace

- `services/model-gateway/src/memory/workspace-context.ts`
- index workspace, read/write/search files, generate repo summary
- `services/model-gateway/src/workspace-writer.ts` กัน path traversal, symlink escape, และ protected paths
- ตอนนี้ service ถือ `rootDir` ได้ทีละค่าเดียว; `/workspace/index` คือการสลับ root กลางของ gateway instance

### 7) Patches

- `services/model-gateway/src/patches.ts`
- ดูแล patch lifecycle ทั้งหมด
- มี deterministic review ก่อน apply
- apply ได้เฉพาะ patch ที่ approved แล้ว
- มี rollback entries สำหรับ undo
- patch store persist ลง `patches.json` ผ่าน `FileBackedPatchStore`

### 8) Terminal

- `services/model-gateway/src/terminal/terminal-session.ts`
- `routes/terminal.ts` expose exec, stream, write, kill, restart
- เหมาะกับ IDE shell ที่ต้องเห็น output แบบสด

## Key Data Flow

### AI request flow

1. web shell ส่ง `AIRequest` เข้า gateway
2. controller enrich context จาก workspace/session/policy
3. router เลือก provider/model
4. adapter generate response
5. validator + telemetry + memory ถูกอัปเดต

### Patch flow

1. model สร้าง patch tool call หรือ user สร้าง patch โดยตรง
2. patch service normalize operations
3. review preconditions และ build diff
4. approve ก่อน apply
5. apply ลง filesystem จริง
6. rollback ได้ถ้ามี rollback plan

### Workspace flow

1. web เรียก workspace routes
2. controller ใช้ `WorkspaceContextService`
3. writer บังคับ path safety
4. return summary, files, file content, หรือ write result

## Observations

- architecture ดีมากในเชิง separation of concerns
- มี safety ชั้นสำคัญหลายชั้น เช่น redaction, injection guard, path guard, precondition check
- บางส่วนยังเป็น placeholder เช่น embed/rerank และ health check บาง path
- `sessions.ts` และบาง route ยังดูเป็น scaffold มากกว่าของจริง
- patch flow มี transactional thinking ที่ดี และตอนนี้ persist patch state/review history ข้าม restart ได้แล้ว
- จุดจำกัดสำคัญตอนนี้คือ multi-workspace isolation ยังไม่มี เพราะ terminal/patch/workspace services แชร์ root เดียวกันใน process

## What this enables

- local-first AI routing
- provider mesh / fallback / breaker
- IDE-aware context injection
- collaborative multi-role AI workflow
- safe code edits ผ่าน patch lifecycle
- terminal integration สำหรับ validation และ debugging

## Related Notes

- [[architecture-index]]
- [[provider-mesh-routing]]
- [[context-memory-orchestration]]
- [[patch-apply-flow]]
- [[web-ai-chat-flow]]
- [[0003-provider-mesh-and-context-memory]]
