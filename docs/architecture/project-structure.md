# Project Structure

## Monorepo Layout

```txt
my-ide/
├─ apps/
│  ├─ web/          (React + Vite web shell, VS Code-like layout)
│  ├─ desktop/      (placeholder, source only, no package.json)
│  ├─ api/          (placeholder, source only, no package.json)
│  └─ worker/       (placeholder, source only, no package.json)
├─ packages/
│  ├─ ai-core/      (workspace pkg: context builder, collaboration, compaction, agent loader)
│  ├─ protocol/     (workspace pkg: AI, provider, memory, patch, collaboration, settings, validation contracts)
│  ├─ workspace-core/ (workspace pkg: file index, project detection, search, Obsidian KB)
│  ├─ runtime-core/ (source only)
│  ├─ editor-core/  (source only)
│  ├─ sync-core/    (source only)
│  ├─ shared/       (source only)
│  ├─ ui/           (source only)
│  └─ config/       (source only)
├─ services/
│  ├─ model-gateway/ (workspace pkg: Fastify gateway — AI routing, workspace, patches, terminal, settings)
│  ├─ ai-gateway/    (workspace pkg: placeholder, echo scripts only)
│  ├─ collaboration/ (placeholder, source only)
│  └─ workspace-host/ (placeholder, source only)
├─ docs/
│  ├─ architecture/  (architecture notes, gap analysis, deep dives)
│  ├─ decisions/     (ADR records: 0001–0003)
│  ├─ roadmap/       (roadmap and implementation checklist)
│  └─ ai-first-ide.md (main MOC entry point)
├─ scripts/
├─ turbo.json
├─ pnpm-workspace.yaml  (packages/*, services/* only — apps/* not included)
└─ tsconfig.base.json    (@ide/* path aliases for all packages)
```

## Dependency Rules

- Apps and services may depend on shared core packages (`packages/*`)
- `packages/*` must not depend on `apps/*` or `services/*`
- AI orchestration depends on workspace/runtime abstractions, not UI
- Protocol packages define contracts between apps and services
- Workspace and runtime logic remain framework-agnostic
- Provider-specific adapters belong in `services/model-gateway`, not in `packages/ai-core`

## Workspace Package Status

| Package | Has `package.json` | Status |
|---------|-------------------|--------|
| `packages/ai-core` | ✅ | Active — context builder, collaboration, compaction, agent loader |
| `packages/protocol` | ✅ | Active — 7 contract modules |
| `packages/workspace-core` | ✅ | Active — file index, project detection, search, Obsidian KB |
| `services/model-gateway` | ✅ | Active — Fastify gateway with all routes |
| `services/ai-gateway` | ✅ | Placeholder — echo scripts only |
| Others | ❌ | Source only — no package manifest |
