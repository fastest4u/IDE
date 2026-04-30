---
title: Provider Routing Diagram
created: 2026-04-29
---

# Provider Routing Diagram

```mermaid
flowchart TD
  U[User Request] --> GW[AI Gateway]
  GW --> IC[Intent Classifier]
  IC --> CB[Context Builder]
  CB --> RR[Routing Decision]
  RR --> MR[Model Registry]
  MR --> PE[Policy Engine]
  PE --> HC[Health Check / Circuit Breaker]
  HC --> A1[Anthropic Adapter]
  HC --> A2[OpenAI Adapter]
  HC --> A3[Gemini Adapter]
  HC --> A4[Mistral Adapter]
  HC --> A5[DeepSeek Adapter]
  HC --> A6[Ollama Adapter]
  HC --> A7[vLLM Adapter]

  A1 --> RX[Unified Response]
  A2 --> RX
  A3 --> RX
  A4 --> RX
  A5 --> RX
  A6 --> RX
  A7 --> RX

  RX --> V[Validator / Safety Layer]
  V --> O[IDE Output]
```

## Notes

- The router picks a candidate set from the registry.
- The policy engine scores each candidate.
- The health layer removes failing providers from selection.
- The validator checks the final output before it reaches the IDE.
