---
title: AI-First IDE Map
created: 2026-04-29
status: draft
type: moc
tags:
  - moc
  - ide/ai-first
  - project/my-ide
aliases:
  - AI IDE MOC
  - IDE Map
  - AI-First IDE Map
---

# AI-First IDE Map

ใช้หน้านี้เป็นจุดเริ่มต้นใน Obsidian สำหรับเข้าใจโปรเจค IDE ส่วนตัวที่เน้น AI-first, multi-provider routing, load balancing, และ memory/context orchestration.

## Start Here

- [[ai-first-ide-vision|AI-First IDE Vision]]: วิสัยทัศน์ผลิตภัณฑ์และขอบเขต MVP.
- [[current-state-gap-analysis]]: อะไรมีจริงใน repo และอะไรยังเป็น gap.
- [[ai-first-ide-roadmap]]: ลำดับการพัฒนาที่ควรทำต่อ.
- [[implementation-checklist]]: checklist สำหรับลงมือทำตาม phase.
- [[obsidian-vault-guide]]: กติกาการเขียน note, tags, callouts, embeds.

## Architecture

- [[provider-mesh-routing]]: provider mesh, model routing, fallback, load balancing.
- [[context-memory-orchestration]]: memory/context เพื่อไม่ให้ AI ลืมงานเมื่อข้าม provider/model/session.
- [[architecture-index]]: MOC ของ architecture ทั้งหมด.
- [[ai-provider-architecture]]: architecture เดิมของ provider-agnostic AI layer.
- [[ai-router-provider-interfaces]]: TypeScript contracts สำหรับ AI request, model registry, provider adapter, validation.
- [[web-ai-chat-flow]]: flow ระหว่าง web shell กับ model gateway.
- [[patch-apply-flow]]: patch review/apply lifecycle.

## Embedded Snapshot

![[ai-first-ide-vision#^north-star]]

![[current-state-gap-analysis#ยังเป็น gap สำคัญ]]

![[implementation-checklist#Phase 1: Runnable Model Gateway]]

## Bases Dashboards

- [[ai-ide-dashboard.base]]: รวมเอกสารโปรเจคทั้งหมด.
- [[architecture.base]]: architecture notes.
- [[roadmap.base]]: roadmap และ checklist notes.
- [[decisions.base]]: decision log.

![[ai-ide-dashboard.base#Core Notes]]

## Decisions

- [[0001-monorepo-architecture]]
- [[0002-ai-provider-orchestration]]
- [[0003-provider-mesh-and-context-memory]]

## Working Notes

- ถ้าเริ่ม implement feature ให้เปิด [[implementation-checklist]] คู่กับ [[current-state-gap-analysis]].
- ถ้าแก้ architecture ให้ update [[architecture-index]] และ decision ที่เกี่ยวข้อง.
- ถ้าเพิ่ม note ใหม่ ให้ตาม [[obsidian-vault-guide#Frontmatter Standard]].

## Current Implementation Anchors

- `apps/web/src/main.tsx`: React bootstrap, QueryClient, TanStack Router memory history.
- `apps/web/src/app.tsx`: current VS Code-like shell; it requires explicit workspace selection before loading the explorer, Monaco editor, agent panel, and terminal dock.
- `apps/web/src/components/workspace-selector.tsx`: workspace picker shown on every fresh launch/reload, with recent workspaces cached in browser storage.
- `apps/web/src/services/model-gateway.ts`: browser transport to model gateway for AI, patch, settings, workspace, and terminal routes.
- `packages/protocol/src/ai.ts`: AI request/routing/model contracts in `@ide/protocol`.
- `packages/protocol/src/provider.ts`: provider adapter contract in `@ide/protocol`.
- `packages/protocol/src/settings.ts`: local-first settings contract.
- `packages/ai-core/src/collaboration.ts`: role orchestration for multi-model collaboration.
- `services/model-gateway/src/server.ts`: runnable Fastify gateway.
- `services/model-gateway/src/routes/workspace.ts`: workspace index/search/read/save HTTP routes.
- `services/model-gateway/src/memory/workspace-context.ts`: workspace indexing, guarded file reads, and guarded save support.
- `services/model-gateway/src/router/ai-router.ts`: provider mesh router/executor.
- `services/model-gateway/src/settings.ts`: local-first settings and local provider defaults.

## Current Remaining Priorities And Constraints

- Phase 13: desktop packaging is the last uncompleted roadmap phase.
- `services/model-gateway` still tracks a single active workspace root per process; switching workspace is global for terminal, patch, and editor-backed operations.
- The web shell now requires explicit workspace selection on every fresh launch/reload and stores recent picks only in browser local storage.
