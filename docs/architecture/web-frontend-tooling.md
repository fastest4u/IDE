---
title: Web Frontend Tooling
created: 2026-04-29
---

# Web Frontend Tooling

The web IDE currently uses a Vite-based React stack that is kept decoupled from desktop runtime APIs so the shell can later be reused in Desktop.

## Current core packages

- React
- React DOM
- Vite
- TypeScript
- TanStack Router
- TanStack Query
- Monaco Editor

## Entry points

- `apps/web/index.html` — HTML bootstrap
- `apps/web/src/main.tsx` — React bootstrap
- `apps/web/src/app.tsx` — shell layout
- `apps/web/src/shell.ts` — shell metadata and cards
- `apps/web/src/styles.css` — app styles
- `apps/web/vite.config.ts` — Vite config

## Boot flow

1. Browser loads `index.html`.
2. Vite serves `main.tsx`.
3. React mounts the shell into `#root`.
4. The shell first renders `WorkspaceSelector`; after selection it renders the explorer, editor, AI panel, and terminal.
5. `QueryClientProvider` supplies server-state caching and request coordination.
6. `RouterProvider` supplies route state and page composition.
7. Monaco mounts inside the editor region.

## Provider setup

- Create a single `QueryClient` at the app root.
- Create a root route and index route for the shell.
- Keep routing minimal at first so the shell remains easy to extend.
- Prefer memory history during early shell development if no browser routes are needed yet.

## Build notes

- Keep the frontend toolchain independent from desktop runtime APIs.
- Avoid directly coupling the shell to provider logic.
- Route all AI traffic through the service layer.
