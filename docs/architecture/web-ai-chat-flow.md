---
title: Web AI Chat Flow
created: 2026-04-29
---

# Web AI Chat Flow

The web shell talks to the model gateway through a small request helper.

## Flow

1. User submits a prompt in the AI chat panel.
2. The shell creates an `AIRequest`.
3. `apps/web/src/services/model-gateway.ts` sends the request to `POST /ai/generate` or `POST /ai/stream`.
4. `services/model-gateway` routes the request through the model registry and policy engine.
5. The gateway returns an `AIResponse` or SSE events.
6. The chat thread appends the assistant reply incrementally.
7. Workspace context such as active file, selected text, git diff, and diagnostics is bundled into the request.
8. Selected text is captured live from Monaco editor selection changes.
9. Context fields are exposed as multi-select chips and can be injected into the outgoing prompt directly.
10. The chat composer keeps a live preview of the active context fields.
11. Tool calls are converted into reviewable patch cards in the shell.
12. Patch cards can be approved, rejected, applied, or rolled back through gateway endpoints.

## Client responsibilities

- Keep prompt input local to the shell
- Pass workspace context when available
- Render pending and streaming states clearly
- Keep the transport layer isolated in a service module
- Surface tool calls and warnings in the chat UI
- Render patch previews as reviewable cards
- Forward patch review/apply/rollback actions to the backend
- Sync editor selection into AI request context
- Allow context chips to compose the outgoing prompt directly
- Present the current context set as a preview

## Future upgrade path

- Add more granular tool-call rendering in the chat thread
- Persist patch decisions in workspace history
- Surface richer rollback/apply diagnostics and verifier details in the chat thread itself
