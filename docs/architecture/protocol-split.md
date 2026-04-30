---
title: Protocol Split
created: 2026-04-29
---

# Protocol Split

`packages/protocol` is now split into focused modules.

## Modules

- `packages/protocol/src/ai.ts`
  - request kinds
  - routing decisions
  - model registry types
  - AI request/response structures

- `packages/protocol/src/provider.ts`
  - provider init options
  - provider adapter interface
  - generate/embed/rerank request and response types

- `packages/protocol/src/validation.ts`
  - safety policy
  - validation result
  - validator interface

- `packages/protocol/src/index.ts`
  - barrel export for the whole protocol package

## Why this split exists

- Easier navigation
- Cleaner ownership boundaries
- Lower merge conflict risk
- Better long-term maintenance for the AI gateway and workspace services

## Usage guidance

- Import from `@ide/protocol` when you want the full shared surface.
- Import from submodules only if a module needs a narrower dependency surface.
- Keep protocol types framework-agnostic.
