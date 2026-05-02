---
title: Protocol Split
created: 2026-04-29
updated: 2026-05-02
---

# Protocol Split

`packages/protocol` is split into focused modules. The barrel export `index.ts` re-exports all seven modules.

## Modules

- `packages/protocol/src/ai.ts`
  - `AIRequest`, `AIResponse`, `AIStreamEvent` — request/response lifecycle
  - `AIRequestKind` — chat, edit, refactor, explain, plan, validate, embed, rerank
  - `AICapability`, `ModelTier`, `RoutingStrategy` — model classification
  - `ModelDescriptor`, `ModelRegistry` — model registry and capabilities
  - `RoutingDecision`, `RoutingCandidate` — routing decisions
  - `ProviderHealth`, `ProviderPolicyEngine` — health and scoring
  - `AgentDefinition`, `AgentMode`, `AgentPermission` — agent system types
  - `AIToolCallSpec`, `AIToolCall` — tool call contracts
  - `AIOrchestrator`, `AIRouter` — orchestrator and router interfaces

- `packages/protocol/src/provider.ts`
  - `ProviderAdapter` — provider adapter interface (generateText, streamText, embedText, rerank, healthCheck)
  - `ProviderInitOptions` — API key, base URL, timeout
  - `ProviderGenerateTextRequest/Response` — text generation
  - `ProviderEmbedRequest/Response` — embedding
  - `ProviderRerankRequest/Response` — reranking
  - `GatewayPluginHook`, `PluginHookRegistry` — OpenCode-style plugin system

- `packages/protocol/src/validation.ts`
  - `ValidationResult` — safety policy and response validation

- `packages/protocol/src/memory.ts`
  - `ContextPacket` — full context assembled before provider call
  - `TaskState` — session state with goal, decisions, constraints, patches, memory
  - `MemoryRecord` — individual memory entries (decision, patch, constraint, observation, source, handoff)
  - `PatchMemory`, `ProviderUsageOutcome` — patch and provider usage tracking
  - `SessionMemoryStore`, `ContextBuilder` — store and builder interfaces

- `packages/protocol/src/patch.ts`
  - `PatchRecord`, `PatchOperation`, `PatchStatus` — patch lifecycle
  - `StructuredPatchDiff`, `PatchDiffHunk` — structured diff preview
  - `PatchReviewResult`, `PatchReviewFinding` — deterministic review
  - `PatchRollbackPlan` — rollback support
  - `AI_PATCH_TOOL_SPEC`, `AI_PATCH_TOOL_NAME`, `AI_PATCH_TOOL_INSTRUCTIONS` — AI tool spec for patch creation

- `packages/protocol/src/collaboration.ts`
  - `CollaborationRole` — planner, context_curator, coder, reviewer, verifier, synthesizer
  - `CollaborationRequest`, `CollaborationResponse` — multi-model collaboration lifecycle
  - `CollaborationRoleSpec`, `CollaborationRoleOutput` — per-role execution
  - `CollaborationWorkflowGraph`, `CollaborationWorkflowNode`, `CollaborationWorkflowEdge` — visual workflow graph
  - `CollaborationWorkflowDefinition`, `CollaborationWorkflowInput` — workflow definition CRUD
  - `CollaborationTeamId`, `CollaborationTeamResolution` — team resolution

- `packages/protocol/src/settings.ts`
  - `IDESettings`, `IDESettingsUpdate` — full settings with version
  - `PolicySettings`, `PrivacyMode` — routing strategy and privacy
  - `AgentPermissionSettings`, `PermissionLevel`, `ToolPermissionConfig` — OpenCode-style permissions
  - `AgentConfig` — custom agent configuration
  - `LocalProviderSettings` — Ollama/vLLM provider config
  - `ProviderRuntimeStatus`, `ProviderRuntimeModelStatus` — runtime health
  - `MemorySettings`, `DesktopShellSettings` — memory and desktop config
  - `WorkspaceSettingsOverride` — per-workspace policy

## Barrel Export

`packages/protocol/src/index.ts` re-exports all seven modules:

```ts
export * from './ai';
export * from './provider';
export * from './validation';
export * from './memory';
export * from './patch';
export * from './collaboration';
export * from './settings';
```

## Why This Split Exists

- Easier navigation
- Cleaner ownership boundaries
- Lower merge conflict risk
- Better long-term maintenance for the AI gateway and workspace services

## Usage Guidance

- Import from `@ide/protocol` when you want the full shared surface.
- Import from submodules only if a module needs a narrower dependency surface.
- Keep protocol types framework-agnostic.
