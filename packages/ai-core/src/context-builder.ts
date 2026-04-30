import type {
  AIRequest,
  AIResponse,
  ContextBuilder,
  ContextPacket,
  TaskState,
} from '@ide/protocol';

export class ContextBuilderService implements ContextBuilder {
  async buildPacket(
    request: AIRequest,
    taskState: TaskState | null,
  ): Promise<ContextPacket> {
    const activeFiles = request.context.activeFilePath
      ? [{ path: request.context.activeFilePath, reason: 'active file' }]
      : [];

    return {
      requestId: request.id,
      workspaceId: request.context.workspaceId,
      sessionId: request.context.sessionId,
      taskGoal: taskState?.goal ?? request.prompt,
      currentPrompt: request.prompt,
      activeFiles,
      selectedText: request.context.selectedText,
      gitDiff: request.context.gitDiff,
      diagnostics: request.context.diagnostics,
      retrievedMemory: taskState?.memory ?? [],
      decisions: taskState?.decisions ?? [],
      constraints: taskState?.constraints ?? [],
      patchHistory: taskState?.patches ?? [],
      handoffSummary: taskState?.lastHandoffSummary ?? '',
      repoSummary: request.context.repoSummary,
      workspaceFiles: request.context.openFiles,
      workspaceContext: request.context.repoSummary,
      terminalOutput: request.context.terminalOutput,
    };
  }

  buildPromptWithContext(
    originalPrompt: string,
    packet: ContextPacket,
  ): string {
    const parts: string[] = [originalPrompt];

    if (packet.taskGoal && packet.taskGoal !== originalPrompt) {
      parts.push(`\nTask goal: ${packet.taskGoal}`);
    }

    if (packet.decisions.length > 0) {
      parts.push(`\nPrior decisions:\n${packet.decisions.map((d) => `- ${d}`).join('\n')}`);
    }

    if (packet.constraints.length > 0) {
      parts.push(`\nConstraints:\n${packet.constraints.map((c) => `- ${c}`).join('\n')}`);
    }

    if (packet.handoffSummary) {
      parts.push(`\nHandoff summary: ${packet.handoffSummary}`);
    }

    if (packet.retrievedMemory.length > 0) {
      const memoryLines = packet.retrievedMemory.map(
        (m) => `- [${m.kind}] ${m.summary}`,
      );
      parts.push(`\nRelevant context:\n${memoryLines.join('\n')}`);
    }

    if (packet.patchHistory.length > 0) {
      const patchLines = packet.patchHistory.map(
        (p) => `- ${p.title} (${p.status}): ${p.summary}`,
      );
      parts.push(`\nPatch history:\n${patchLines.join('\n')}`);
    }

    if (packet.activeFiles.length > 0) {
      parts.push(
        `\nActive files: ${packet.activeFiles.map((f) => `${f.path} (${f.reason})`).join(', ')}`,
      );
    }

    if (packet.selectedText) {
      parts.push(`\nSelected text:\n\`\`\`\n${packet.selectedText}\n\`\`\``);
    }

    if (packet.gitDiff) {
      parts.push(`\nGit diff:\n\`\`\`diff\n${packet.gitDiff}\n\`\`\``);
    }

    if (packet.terminalOutput) {
      parts.push(`\nTerminal output:\n\`\`\`\n${packet.terminalOutput}\n\`\`\``);
    }

    if (packet.repoSummary) {
      parts.push(`\nRepository structure:\n${packet.repoSummary}`);
    }

    if (packet.workspaceFiles?.length) {
      parts.push(`\nWorkspace files:\n${packet.workspaceFiles.join('\n')}`);
    }

    if (packet.workspaceContext) {
      parts.push(`\nWorkspace context: ${packet.workspaceContext}`);
    }

    return parts.join('\n');
  }

  buildHandoffSummary(taskState: TaskState): string {
    const lines: string[] = [];

    lines.push(`Goal: ${taskState.goal}`);
    lines.push(`Decisions (${taskState.decisions.length}): ${taskState.decisions.join('; ')}`);
    lines.push(`Patches (${taskState.patches.length}): ${taskState.patches.map((p) => `${p.title}:${p.status}`).join(', ')}`);

    const providers = [...new Set(taskState.providerUsage.map((u) => u.providerId))];
    lines.push(`Providers used: ${providers.join(', ')}`);

    return lines.join('\n');
  }

  extractOutcome(response: AIResponse, request: AIRequest): string {
    const warnings = response.warnings?.length
      ? `Warnings: ${response.warnings.join('; ')}`
      : '';
    const model = `${response.providerId}/${response.modelId}`;
    const tokens = response.usage?.totalTokens
      ? `${response.usage.totalTokens} tokens`
      : '';
    return [model, tokens, warnings].filter(Boolean).join(' | ');
  }
}
