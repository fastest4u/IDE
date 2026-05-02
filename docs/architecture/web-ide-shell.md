---
title: Web IDE Shell
created: 2026-04-29
---

# Web IDE Shell

The web client is the primary working shell for the AI-first IDE today.

## Shell goals

- Show a workspace selector before entering the shell on every fresh launch/reload
- Left activity rail + explorer for workspace navigation
- Central Monaco editor surface with tabs and breadcrumbs
- Right rail for AI chat and context actions
- Terminal dock scoped to the editor column
- Strong separation between UI, workspace data, and AI orchestration
- TanStack Router for shell navigation state
- TanStack Query for workspace and AI-backed server state
- Chat requests flow to the model gateway service

## Layout model

```txt
┌──────────────────────────────────────────────────────────────────────┐
│ Title bar: workspace, file, actions                                   │
├──────┬───────────────┬────────────────────────┬──────────────────────┤
│ Rail │ Explorer      │ Monaco editor          │ Agent / AI chat      │
│      │ file tree     │ tabs + breadcrumbs     │ prompts + activity   │
├──────┴───────────────┴────────────────────────┴──────────────────────┤
│ Editor-only terminal dock                                             │
└──────────────────────────────────────────────────────────────────────┘
```

## Frontend stack

- React
- TanStack Router
- TanStack Query
- Monaco Editor
- Vite
- Tauri-compatible UI boundaries so the same shell can later be reused in desktop

## Current behavior

- `WorkspaceSelector` indexes the chosen root through `/workspace/index` before the user enters the editor shell.
- Show explicit loading, empty, and error states for workspace data
- Stream AI responses in the right panel
- Keep editor state local to the client and workspace data in query/cache layers
- Keep AI actions visible through diffs and confirmations
- Route AI messages through `services/model-gateway`
- Keep terminal output isolated to the editor column so it does not steal height from explorer or agent panels

## Known constraints

1. The shell requires explicit workspace selection every fresh launch/reload.
2. The gateway still serves one mutable workspace root per process, so the shell is effectively single-workspace per running gateway instance.
3. Provider/runtime settings are accessible through the agent manager modal (`ProviderSettings.tsx`), but there is no standalone dedicated settings page.
