# Repository Instructions

## Sources Of Truth
- Trust executable config over prose when they disagree; several docs describe future services that are not present yet.
- Current pnpm lockfile importers are `.`, `packages/ai-core`, `packages/protocol`, `packages/workspace-core`, `services/ai-gateway`, and `services/model-gateway`; most other `apps/*`, `packages/*`, and `services/*` directories are source-only until they get their own `package.json`.
- Dependency layout is intentionally root-only: `.npmrc` uses `node-linker=hoisted`, `hoist-workspace-packages=true`, and `dedupe-direct-deps=true`; do not add package-local `node_modules`.
- Start AI-first IDE architecture/product exploration from `docs/ai-first-ide.md`.
- Keep this file aligned with verified facts from `CLAUDE.md`, root manifests, and `docs/decisions/`.

## Commands
- Use Node `>=20` and pnpm `>=10`; the root declares `packageManager: pnpm@10.0.0`.
- Install with `pnpm install`.
- Root orchestration scripts are `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm test`, and `pnpm typecheck`; each delegates to Turbo.
- Web dev: `pnpm dev:web` or `pnpm exec vite apps/web --config apps/web/vite.config.ts --host 0.0.0.0 --port 5173`; Vite serves `0.0.0.0:5173`.
- Web build: `pnpm build:web` or `pnpm exec vite build apps/web --config apps/web/vite.config.ts`.
- Model gateway dev: `pnpm dev:model-gateway` or `pnpm --dir services/model-gateway dev`; Fastify listens on `127.0.0.1:3001` by default.
- Model gateway checks: `pnpm typecheck:model-gateway`, `pnpm build:model-gateway`, and `pnpm test:model-gateway`.
- Focused typechecks in root scripts are `pnpm typecheck:apps`, `pnpm typecheck:packages`, and `pnpm typecheck:services`.
- Be careful with package-name Turbo filters such as `@ide/desktop`, `@ide/api`, and `@ide/worker`; those dirs currently lack package manifests.
- `services/ai-gateway` has placeholder `build`, `lint`, and `test` scripts that only echo, so do not treat them as real validation.
- No repo-local CI, pre-commit, ESLint, Prettier, Vitest, or codegen config is present; do not invent extra validation workflows without adding config.

## Architecture Boundaries
- Workspace globs in `pnpm-workspace.yaml` are `packages/*` and `services/*`; `apps/*` directories are not workspace packages and depend on root-level dependencies.
- Apps and services may depend on `packages/*`; `packages/*` must not depend on `apps/*`.
- Keep `packages/ai-core` provider-agnostic and UI-free; provider-specific routing/adapters belong in `services/model-gateway`.
- Keep `packages/workspace-core` independent of UI framework details and `packages/runtime-core` independent of client platform details.
- Cross-boundary contracts belong in `packages/protocol`, split across `ai.ts`, `provider.ts`, `validation.ts`, `memory.ts`, `patch.ts`, `collaboration.ts`, and `settings.ts` with `index.ts` as the barrel export.
- Use the shared root `@ide/*` path aliases from `tsconfig.base.json`; prefer named exports.

## Current Entrypoints
- Web boot flow is `apps/web/index.html` -> `apps/web/src/main.tsx` -> `AppShell` in `apps/web/src/app.tsx`.
- The web app uses a single root `QueryClient` and TanStack Router with `createBrowserHistory` in `main.tsx`.
- On a fresh web load/reload, `AppShell` shows `WorkspaceSelector` first and only loads workspace queries after the user picks a `workspace` search param.
- The current web shell is VS Code-like: activity rail + explorer on the left, Monaco editor in the center, agent/chat panel on the right, and a terminal dock that lives inside the editor column.
- Web AI transport is isolated in `apps/web/src/services/model-gateway.ts` and currently hardcodes `http://127.0.0.1:3001`.
- `services/model-gateway/src/server.ts` is the Fastify gateway source for AI and patch routes; routes live under `services/model-gateway/src/routes/`.
- Gateway endpoints in source are `POST /ai/generate`, `POST /ai/stream`, `POST /ai/collaborate`, `POST /ai/embed`, `POST /ai/rerank`, `GET /health`, workspace routes under `/workspace`, settings routes under `/settings`, patch routes under `/patches`, session routes under `/sessions`, terminal routes under `/terminal`, agent routes under `/agents`, workflow routes under `/workflows`, trace routes under `/trace`, and memory routes under `/memory`.
- Provider configs are loaded via `ProviderConnectionConfig[]`; each config specifies `providerId`, `baseUrl`, `apiKeyEnv`, `models`, and `timeoutMs`.
- Adapters: `OpenAICompatibleAdapter` (works with OpenAI/DeepSeek/vLLM/Ollama endpoints), `OllamaAdapter` (native Ollama API), `AnthropicAdapter` (placeholder).
- `createModelGatewayServer(options)` returns `{ app, controller, router }`; pass `providerConfigs` to register providers at startup.
- `createModelGatewayServer(options)` resolves the initial workspace root from `options.workspaceRoot ?? process.env.IDE_WORKSPACE_ROOT ?? process.cwd()`.
- Session memory is managed by `InMemorySessionStore` through `AIController`; workspace context is indexed by `WorkspaceContextService` using `InMemoryWorkspaceIndex` from `packages/workspace-core`; guarded file saves use the same workspace path policy as patch writes; context are augmented per request via `ContextBuilderService` in `packages/ai-core`.
- Multi-model collaboration is handled by `RoleOrchestrationService` in `packages/ai-core` and `POST /ai/collaborate` in `services/model-gateway`; roles are planner, context curator, coder, reviewer, verifier, and synthesizer.
- AI patch generation uses `AI_PATCH_TOOL_SPEC` from `packages/protocol/src/patch.ts`; edit/refactor requests auto-attach patch tool instructions, streamed `ide_create_patch` tool calls create backend patch records, and patch approval re-runs verifier precondition checks.
- Local-first settings are managed by `LocalFirstSettingsService`; `IDE_DATA_DIR` overrides the default `~/.my-ide` data path, privacy mode forces `localOnly`, provider registry/adapters hot-reload after `/settings` updates, `/settings/provider-status` and `/settings/providers/:providerId/test` expose runtime health, workspace overrides can constrain policy/providers but do not change filesystem roots, and session memory persists to `sessions.json` when enabled.
- `services/model-gateway` is a runnable Fastify workspace package with wired router, registry, policy engine, health checks, circuit breaker, fallback planner, adapters (OpenAI-compatible, Ollama, Anthropic placeholder), session memory store, workspace indexer, context builder, provider config, and usage logging.
- `/workspace/index` can switch the active workspace root at runtime, but the gateway currently keeps one mutable workspace root per process; patching, terminal sessions, and explorer/editor reads all follow that shared root.
- `apps/desktop`, `apps/api`, `apps/worker`, `services/workspace-host`, and `services/collaboration` are placeholder entrypoints at the moment.

## Workflow Notes
- Record architecture/product decisions that affect design in `docs/decisions/` using numbered `000N-topic.md` files.
- Keep AI actions transparent with reviewable diffs/patch cards and approvals; the documented patch flow assumes review before apply.
- Route AI traffic through the service layer, not direct provider calls from UI code.
