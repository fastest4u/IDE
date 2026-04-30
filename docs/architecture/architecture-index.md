---
title: Architecture Index
created: 2026-04-29
status: active
type: moc
tags:
  - moc
  - architecture/ai
  - project/my-ide
aliases:
  - Architecture MOC
  - System Architecture
---

# Architecture Index

แผนที่สถาปัตยกรรมสำหรับ AI-first IDE: web shell, model gateway, provider mesh, context memory, patch flow, และ protocol contracts.

> [!warning] Current State
> อ่าน [[current-state-gap-analysis]] ก่อนลงมือ implement เพื่อแยกสิ่งที่รันได้จริงใน repo ปัจจุบันออกจาก note ที่ยังเป็น target architecture หรือ next-step design.

## Core Architecture Notes

- [[provider-mesh-routing]]: multi-provider routing, load balancing, fallback, model collaboration.
- [[context-memory-orchestration]]: IDE-owned context/memory เพื่อไม่ให้ AI ลืมเมื่อข้าม provider/model.
- [[ai-provider-architecture]]: architecture เดิมของ provider-agnostic layer.
- [[ai-provider-implementation]]: implementation blueprint ของ model gateway.
- [[ai-router-provider-interfaces]]: TypeScript contracts ที่ควรเป็น source of truth.
- [[protocol-split]]: การแบ่งไฟล์ใน `packages/protocol`.

## Product And Runtime Flow

- [[web-ide-shell]]: layout และ interaction model ของ web IDE.
- [[web-ai-chat-flow]]: chat flow จาก web shell ไป model gateway.
- [[patch-apply-flow]]: patch lifecycle และ review/apply flow.
- [[provider-routing-diagram]]: provider routing diagram.
- [[ai-provider-sequence]]: sequence diagram ของ request flow.

## Embedded Snapshot

![[current-state-gap-analysis#ยังเป็น gap สำคัญ]]

![[provider-mesh-routing#Responsibilities]]

![[context-memory-orchestration#How AI Avoids Forgetting]]

## Bases

![[architecture.base#Architecture Notes]]

## Implementation Anchors

| Area | File |
| --- | --- |
| Web boot | `apps/web/src/main.tsx` |
| IDE shell | `apps/web/src/app.tsx` |
| Workspace selector | `apps/web/src/components/workspace-selector.tsx` |
| Web terminal | `apps/web/src/components/terminal.tsx` |
| Web gateway client | `apps/web/src/services/model-gateway.ts` |
| AI contracts | `packages/protocol/src/ai.ts` |
| Provider adapter contract | `packages/protocol/src/provider.ts` |
| Gateway server runtime | `services/model-gateway/src/server.ts` |
| Router engine | `services/model-gateway/src/router/ai-router.ts` |
| Policy engine | `services/model-gateway/src/router/policy-engine.ts` |
| Health service | `services/model-gateway/src/health/health-check.ts` |
| Circuit breaker | `services/model-gateway/src/health/circuit-breaker.ts` |

## Next Architecture Work

- [ ] Decide multi-workspace runtime architecture; the gateway still owns one mutable workspace root per process.
- [ ] Expand automated validation beyond the current smoke/build checks.
- [ ] Mature thinner runtime areas such as embed/rerank and richer provider health/telemetry.
- [ ] Package the desktop app around the existing web shell + service boundary.

## Related Notes

- [[ai-first-ide]]
- [[implementation-checklist]]
- [[0003-provider-mesh-and-context-memory]]
