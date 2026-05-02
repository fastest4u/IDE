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
| Provider settings UI | `apps/web/src/components/ProviderSettings.tsx` |
| Web terminal | `apps/web/src/components/terminal.tsx` |
| Web gateway client | `apps/web/src/services/model-gateway.ts` |
| AI contracts | `packages/protocol/src/ai.ts` |
| Provider adapter contract | `packages/protocol/src/provider.ts` |
| Memory contracts | `packages/protocol/src/memory.ts` |
| Patch contracts | `packages/protocol/src/patch.ts` |
| Collaboration contracts | `packages/protocol/src/collaboration.ts` |
| Settings contracts | `packages/protocol/src/settings.ts` |
| Context builder | `packages/ai-core/src/context-builder.ts` |
| Role orchestration | `packages/ai-core/src/collaboration.ts` |
| Agent loader | `packages/ai-core/src/agent-loader.ts` |
| Compaction service | `packages/ai-core/src/compaction.ts` |
| Workspace index | `packages/workspace-core/src/workspace-index.ts` |
| Project detector | `packages/workspace-core/src/project-detector.ts` |
| Obsidian KB | `packages/workspace-core/src/obsidian-kb.ts` |
| Gateway server runtime | `services/model-gateway/src/server.ts` |
| AI controller | `services/model-gateway/src/controller.ts` |
| Router engine | `services/model-gateway/src/router/ai-router.ts` |
| Policy engine | `services/model-gateway/src/router/policy-engine.ts` |
| Health service | `services/model-gateway/src/health/health-check.ts` |
| Circuit breaker | `services/model-gateway/src/health/circuit-breaker.ts` |
| OpenAI-compatible adapter | `services/model-gateway/src/adapters/openai-compatible-adapter.ts` |
| Ollama adapter | `services/model-gateway/src/adapters/ollama-adapter.ts` |
| Patch service | `services/model-gateway/src/patches.ts` |
| Workspace writer | `services/model-gateway/src/workspace-writer.ts` |
| Workspace context | `services/model-gateway/src/memory/workspace-context.ts` |
| Session store | `services/model-gateway/src/memory/session-store.ts` |
| Settings service | `services/model-gateway/src/settings.ts` |
| Terminal service | `services/model-gateway/src/terminal/terminal-session.ts` |
| Workspace picker | `services/model-gateway/src/workspace-picker.ts` |
| Audit log | `services/model-gateway/src/telemetry/audit-log.ts` |
| Trace service | `services/model-gateway/src/telemetry/trace-service.ts` |
| Plugin hooks | `services/model-gateway/src/plugin-hooks.ts` |
| Origin guard | `services/model-gateway/src/security/request-guard.ts` |
| Prompt injection guard | `services/model-gateway/src/safety/prompt-injection.ts` |
| Secret redactor | `services/model-gateway/src/safety/secret-redaction.ts` |

## Next Architecture Work

- [ ] Decide multi-workspace runtime architecture; the gateway still owns one mutable workspace root per process.
- [ ] Expand automated validation beyond the current smoke/build checks.
- [ ] Mature thinner runtime areas such as embed/rerank and richer provider health/telemetry.
- [ ] Package the desktop app around the existing web shell + service boundary.

## Related Notes

- [[ai-first-ide]]
- [[implementation-checklist]]
- [[0003-provider-mesh-and-context-memory]]
