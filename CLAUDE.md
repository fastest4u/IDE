# Project: My IDE

## Goal
Build a custom AI-first IDE with Web and Desktop clients, plus AI-assisted coding workflows with multi-provider routing and IDE-owned context memory.

## Tech Stack
- TypeScript 5.8
- React 19 for UI
- Monaco Editor for code editing
- TanStack Router + TanStack Query for navigation and server state
- xterm.js for integrated terminal
- Vite 6 for web bundling
- Fastify 5 for model gateway backend
- Tauri for desktop shell (planned, not yet implemented)
- Turborepo + pnpm 10 monorepo

## Commands
- Install: `pnpm install`
- Dev (all): `pnpm dev` (starts web + model-gateway concurrently)
- Dev web only: `pnpm dev:web` (Vite at 0.0.0.0:5173)
- Dev gateway only: `pnpm dev:model-gateway` (Fastify at 127.0.0.1:3001)
- Build: `pnpm build`
- Build web: `pnpm build:web`
- Build gateway: `pnpm build:model-gateway`
- Test: `pnpm test`
- Test gateway: `pnpm test:model-gateway`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Typecheck gateway: `pnpm typecheck:model-gateway`

## Architecture Rules
- `apps/*` and `services/*` may depend on `packages/*`
- `packages/*` must not depend on `apps/*`
- Keep `ai-core` provider-agnostic and UI-free
- Keep `workspace-core` independent from UI framework details
- Keep `runtime-core` independent from client platform details
- Shared contracts belong in `packages/protocol` (7 modules: ai, provider, validation, memory, patch, collaboration, settings)
- Provider-specific routing/adapters belong in `services/model-gateway`

## Workspace Layout
- `pnpm-workspace.yaml` includes `packages/*` and `services/*` only
- `apps/*` are not workspace packages; they use root-level dependencies
- Only `packages/ai-core`, `packages/protocol`, `packages/workspace-core`, `services/ai-gateway`, and `services/model-gateway` have their own `package.json`
- Other dirs (`packages/shared`, `packages/ui`, etc.) are source-only

## Key Entrypoints
- Web: `apps/web/index.html` → `src/main.tsx` → `app.tsx` (AppShell)
- Gateway: `services/model-gateway/src/server.ts` → `createModelGatewayServer()`
- Protocol: `packages/protocol/src/index.ts` barrel export
- AI orchestration: `packages/ai-core/src/index.ts`
- Workspace indexing: `packages/workspace-core/src/index.ts`

## Conventions
- Prefer named exports
- Keep packages small and focused
- Define interfaces at package boundaries
- Use the shared `@ide/*` path aliases from `tsconfig.base.json`

## Notes
- Record architecture decisions in `docs/decisions/`
- Keep AI actions transparent with reviewable patch cards and approvals
- Route AI traffic through the service layer, not direct provider calls from UI code
- No CI, ESLint, Prettier, or Vitest config exists yet
