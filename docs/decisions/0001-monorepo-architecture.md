---
id: 0001
title: Monorepo architecture for Web + Desktop IDE
date: 2026-04-29
status: proposed
tags:
  - decision
  - architecture
  - monorepo
---

# Decision

Use a Turbo-powered pnpm monorepo with shared core packages and thin clients for Web and Desktop.

## Context

The IDE needs to support:

- a Web client
- a Desktop client
- AI-assisted coding workflows
- shared business logic between clients
- a future collaboration and remote workspace layer

## Decision details

- Keep UI in `apps/web` and `apps/desktop`
- Put shared logic in `packages/*`
- Put deployable infrastructure in `services/*`
- Use `packages/protocol` for all cross-boundary contracts
- Keep `ai-core`, `workspace-core`, and `runtime-core` independent from UI frameworks

## Consequences

### Positive
- Less duplication between Web and Desktop
- Easier to test shared logic
- Clear separation of responsibilities
- Safer AI and runtime boundaries

### Trade-offs
- More initial setup work
- Requires discipline around package boundaries
- Needs strict dependency rules and path aliases

## Notes

This decision may evolve after the MVP desktop shell is selected.
