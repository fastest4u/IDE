# Project: My IDE

## Goal
Build a custom IDE with Web and Desktop clients, plus AI-assisted coding workflows.

## Tech Stack
- TypeScript
- React for UI
- Monaco Editor for code editing
- Tauri or Electron for desktop shell
- Node.js backend services
- Turbo monorepo with pnpm

## Commands
- Install: `pnpm install`
- Dev: `pnpm dev`
- Build: `pnpm build`
- Test: `pnpm test`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`

## Architecture Rules
- `apps/*` depend on `packages/*`
- `services/*` depend on `packages/*`
- `packages/*` must not depend on `apps/*`
- Keep `ai-core` independent from UI
- Keep `workspace-core` independent from UI framework details
- Keep `runtime-core` independent from client platform details
- Shared contracts belong in `packages/protocol`

## Conventions
- Prefer named exports
- Keep packages small and focused
- Define interfaces at package boundaries
- Use the shared `@ide/*` path aliases

## Notes
- Record architecture decisions in `docs/decisions/`
- Keep AI actions transparent with diffs and confirmations
