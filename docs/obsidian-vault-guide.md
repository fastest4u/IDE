---
title: Obsidian Vault Guide
created: 2026-04-29
status: active
type: guide
tags:
  - vault/guide
  - obsidian
  - project/my-ide
aliases:
  - Vault Guide
  - Documentation Guide
---

# Obsidian Vault Guide

ใช้ note นี้เป็นกติกากลางสำหรับจัดเอกสารโปรเจค AI-first IDE ใน Obsidian.

> [!important] Rule
> ถ้าเป็น note ภายใน `docs/` ให้ใช้ `[[wikilinks]]`; ถ้าเป็นเว็บภายนอกให้ใช้ Markdown link ปกติ.

## Entry Points

- [[ai-first-ide]] คือ MOC หลักของโปรเจค.
- [[architecture-index]] คือ MOC ฝั่งสถาปัตยกรรม.
- [[ai-first-ide-roadmap]] คือ roadmap narrative.
- [[implementation-checklist]] คือ task checklist ที่ใช้ลงมือทำ.
- [[current-state-gap-analysis]] คือ guardrail สำหรับแยกสิ่งที่มีจริงกับสิ่งที่ยังเป็น target.

## Bases

- [[ai-ide-dashboard.base]]: dashboard รวม note ทั้งหมดในโปรเจค.
- [[architecture.base]]: architecture dashboard.
- [[roadmap.base]]: roadmap/checklist dashboard.
- [[decisions.base]]: decision log dashboard.

Embed ตัวอย่าง:

```markdown
![[ai-ide-dashboard.base#Core Notes]]
![[architecture.base#Architecture Notes]]
![[roadmap.base#Roadmap Docs]]
![[decisions.base#Decision Log]]
```

## Note Types

| Type | ใช้เมื่อ | ตัวอย่าง |
| --- | --- | --- |
| `moc` | รวมลิงก์และภาพรวม | [[ai-first-ide]], [[architecture-index]] |
| `vision` | วิสัยทัศน์ product | [[ai-first-ide-vision]] |
| `architecture` | system design | [[provider-mesh-routing]], [[context-memory-orchestration]] |
| `decision` | decision record | [[0003-provider-mesh-and-context-memory]] |
| `roadmap` | ลำดับ phase | [[ai-first-ide-roadmap]] |
| `checklist` | งานที่ลงมือทำได้ | [[implementation-checklist]] |
| `guide` | วิธีใช้ vault หรือ convention | [[obsidian-vault-guide]] |

## Tag Taxonomy

| Tag | Meaning |
| --- | --- |
| `project/my-ide` | เอกสารของโปรเจคนี้ |
| `ide/ai-first` | concept หรือ feature ที่เกี่ยวกับ AI-first IDE |
| `architecture/ai` | AI system architecture |
| `architecture/gap-analysis` | สถานะจริงเทียบ target |
| `ai/provider-routing` | provider mesh, routing, fallback |
| `ai/load-balancing` | balancing, health, quota, circuit breaker |
| `ai/context` | context packet, context builder |
| `ai/memory` | session/workspace/semantic memory |
| `roadmap` | roadmap หรือ phase plan |
| `decision` | ADR/decision record |
| `vault/guide` | Obsidian vault convention |

## Frontmatter Standard

```yaml
---
title: Note Title
created: 2026-04-29
status: draft
type: architecture
tags:
  - project/my-ide
aliases:
  - Alternate Name
---
```

## Link Rules

- ใส่ `Related Notes` ท้าย note ที่เป็น concept สำคัญ.
- ใช้ alias เมื่อชื่อไฟล์ไม่ตรงกับชื่ออ่านง่าย เช่น `[[ai-first-ide-vision|AI-First IDE Vision]]`.
- ใช้ embeds เฉพาะ section ที่ช่วยอ่านเร็ว เช่น `![[provider-mesh-routing#Responsibilities]]`.
- อย่า embed note ทั้งไฟล์ถ้ายาว เพราะจะทำให้ MOC อ่านยาก.

## Callout Rules

- `> [!important]` สำหรับหลักการที่ห้ามพลาด.
- `> [!warning]` สำหรับ gap, risk, หรือ constraint.
- `> [!tip]` สำหรับ implementation hint.
- `> [!todo]` สำหรับ next action ที่ต้องทำ.

## Maintenance Checklist

- [ ] ทุก note ใหม่มี frontmatter.
- [ ] ทุก architecture note link กลับไป [[architecture-index]].
- [ ] ทุก product/roadmap note link กลับไป [[ai-first-ide]].
- [ ] decision ใหม่ใช้เลข `000N-topic.md` ใน `docs/decisions/`.
- [ ] ถ้า executable config เปลี่ยน ให้ update [[current-state-gap-analysis]] และ `AGENTS.md`.
