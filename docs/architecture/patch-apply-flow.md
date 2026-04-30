---
title: Patch Apply Flow
created: 2026-04-29
---

# Patch Apply Flow

The model gateway owns patch lifecycle endpoints.

## Flow

1. The AI layer emits a tool call that becomes a patch record.
2. The web shell shows the patch as a review card.
3. The user can approve, reject, apply, or roll back the patch.
4. `services/model-gateway` updates patch state through REST endpoints.
5. Apply writes structured operations through the guarded workspace writer.
6. The UI reflects the updated status.
7. Rollback restores the pre-apply file snapshot captured by the apply step.

## Backend endpoints

- `GET /patches`
- `POST /patches/:patchId/approve`
- `POST /patches/:patchId/reject`
- `POST /patches/:patchId/apply`
- `POST /patches/:patchId/rollback`

## Safety model

- Patch records store structured operations, not unbounded raw write paths.
- The workspace writer resolves every target against the active workspace root.
- Path traversal, workspace-root targets, `.git`, and `node_modules` targets are rejected before diff or apply.
- Apply requires an approved patch and captures rollback entries before writing.
- If apply fails midway, already-written operations are rolled back immediately.

## Notes

- Patch records currently persist to `patches.json` under the gateway data dir through `FileBackedPatchStore`.
- Patch outcomes are also written into session memory, so restart no longer clears the review/apply history by default.
- Apply should eventually refresh diagnostics after file writes.
