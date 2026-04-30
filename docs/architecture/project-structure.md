# Project Structure

## Monorepo Layout

```txt
my-ide/
├─ apps/
│  ├─ web/
│  ├─ desktop/
│  ├─ api/
│  └─ worker/
├─ packages/
│  ├─ ai-core/
│  ├─ workspace-core/
│  ├─ runtime-core/
│  ├─ editor-core/
│  ├─ sync-core/
│  ├─ shared/
│  ├─ ui/
│  ├─ protocol/
│  └─ config/
├─ services/
│  ├─ ai-gateway/
│  └─ workspace-host/
├─ docs/
├─ turbo.json
├─ pnpm-workspace.yaml
└─ tsconfig.base.json
```

## Dependency Rules

- Presentation layer depends on shared core packages
- AI orchestration depends on workspace/runtime abstractions, not UI
- Protocol packages define contracts between apps and services
- Workspace and runtime logic remain framework-agnostic

## Initial Setup Decisions

- Use pnpm workspaces for package management
- Use Turborepo for task orchestration
- Use TypeScript path aliases for clean imports
- Keep the first MVP focused on shared core + thin clients
