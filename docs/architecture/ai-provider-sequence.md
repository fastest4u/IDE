---
title: AI Provider Sequence Diagram
created: 2026-04-29
---

# AI Provider Sequence Diagram

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant IDE as Frontend IDE
  participant GW as AI Gateway
  participant IC as Intent Classifier
  participant CB as Context Builder
  participant RT as Request Router
  participant MR as Model Registry
  participant PE as Policy Engine
  participant HC as Health / Circuit Breaker
  participant AD as Provider Adapter
  participant VA as Validator / Safety Layer

  User->>IDE: Enter prompt or request edit
  IDE->>GW: Submit AIRequest
  GW->>IC: Classify task intent
  IC-->>GW: chat / edit / refactor / explain / plan
  GW->>CB: Build workspace context
  CB-->>GW: active file, diffs, terminal output, diagnostics
  GW->>RT: Route request by intent and capabilities
  RT->>MR: List models and capabilities
  MR-->>RT: Candidate model catalog
  RT->>PE: Score candidates with policy
  PE-->>RT: Candidate rankings and routing hints
  RT->>HC: Check provider health and quotas
  HC-->>RT: Healthy provider/model set
  RT->>AD: Send request to chosen adapter
  AD-->>RT: Text / tool calls / usage / warnings
  RT->>VA: Validate response and patch quality
  VA-->>RT: Validation result
  alt Validation passed
    RT-->>GW: Final AIResponse
    GW-->>IDE: Stream or return result
    IDE-->>User: Show answer or apply patch preview
  else Validation failed
    RT-->>GW: Degraded or rejected response
    GW-->>IDE: Show warning or fallback result
    IDE-->>User: Request clarification or retry
  end
```

## Detailed flow notes

- The router first narrows candidates by task type.
- The policy engine prefers models by score, not by fixed provider.
- The health layer removes failing or quota-limited providers.
- The adapter returns either full text or streamed deltas and tool calls.
- The validator can reject unsafe or low-quality results before the IDE shows them.
- Fallback can re-enter the routing step with a smaller or local model.
