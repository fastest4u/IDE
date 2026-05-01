import type { AIRequest, AIResponse, ContextPacket, TaskState } from '@ide/protocol';

/**
 * CompactionService implements OpenCode-style context compaction
 * When context becomes too long, it automatically summarizes prior conversation
 * to stay within token limits while preserving essential information
 */

export interface CompactionOptions {
  /** Character threshold to trigger compaction */
  triggerThreshold?: number;
  /** Target length after compaction */
  targetLength?: number;
  /** Preserve most recent N entries fully */
  preserveRecent?: number;
}

export interface CompactionResult {
  originalLength: number;
  compactedLength: number;
  wasCompacted: boolean;
  summary: string;
  preservedEntries: string[];
}

/**
 * Default compaction thresholds (similar to OpenCode)
 */
const DEFAULT_OPTIONS: Required<CompactionOptions> = {
  triggerThreshold: 15000, // ~15k characters
  targetLength: 8000,      // ~8k characters after compaction
  preserveRecent: 5,       // Keep last 5 exchanges intact
};

/**
 * CompactionService automatically compresses long conversation context
 * to maintain efficient token usage while preserving semantic meaning
 */
export class CompactionService {
  private options: Required<CompactionOptions>;

  constructor(options: CompactionOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Check if compaction is needed based on context length
   */
  shouldCompact(contextLength: number): boolean {
    return contextLength > this.options.triggerThreshold;
  }

  /**
   * Compact a ContextPacket when it exceeds thresholds
   * Returns original if no compaction needed
   */
  compactPacket(packet: ContextPacket): { packet: ContextPacket; result?: CompactionResult } {
    const promptLength = packet.currentPrompt?.length ?? 0;
    const memoryLength = this.calculateMemoryLength(packet);
    const totalLength = promptLength + memoryLength;

    if (!this.shouldCompact(totalLength)) {
      return { packet };
    }

    const result = this.performCompaction(packet, totalLength);
    const compactedPacket = this.createCompactedPacket(packet, result);

    return { packet: compactedPacket, result };
  }

  /**
   * Build a compaction prompt for an AI to summarize context
   * This is the prompt used by OpenCode's hidden 'compaction' agent
   */
  buildCompactionPrompt(packet: ContextPacket): string {
    const parts: string[] = [
      'You are a context compaction agent. Your task is to summarize the following conversation context',
      'into a concise summary that preserves all important decisions, constraints, and context.',
      '',
      'Focus on:',
      '- Key decisions made',
      '- Constraints established',
      '- File changes (patches)',
      '- Current task goal and progress',
      '- Any errors or warnings',
      '',
      'Ignore:',
      '- Verbose explanations',
      '- Code examples (unless critical)',
      '- Repetitive information',
      '',
      'Format your response as a concise summary with bullet points.',
      '',
      '---',
      'TASK GOAL:',
      packet.taskGoal ?? 'No goal specified',
      '',
      'PRIOR DECISIONS:',
      packet.decisions?.length ? packet.decisions.join('\n') : 'None',
      '',
      'CONSTRAINTS:',
      packet.constraints?.length ? packet.constraints.join('\n') : 'None',
      '',
      'PATCH HISTORY:',
      packet.patchHistory?.length
        ? packet.patchHistory.map((p) => `- ${p.title} (${p.status})`).join('\n')
        : 'None',
      '',
      'MEMORY:',
      packet.retrievedMemory?.length
        ? packet.retrievedMemory
            .slice(-10)
            .map((m) => `[${m.kind}] ${m.summary}`)
            .join('\n')
        : 'None',
    ];

    return parts.join('\n');
  }

  /**
   * Extract a compact summary from an AI response (after sending compaction prompt)
   */
  extractSummaryFromResponse(response: AIResponse): string {
    const text = response.text?.trim() ?? '';
    if (!text) {
      return '[Context compaction failed - no response]';
    }
    return `--- Prior Context Summary ---\n${text}\n--- End Summary ---`;
  }

  /**
   * Create a compacted TaskState by summarizing old memory entries
   */
  compactTaskState(taskState: TaskState): { state: TaskState; summary: string } {
    const totalLength = this.calculateTaskStateLength(taskState);

    if (!this.shouldCompact(totalLength)) {
      return { state: taskState, summary: '' };
    }

    const { preserveRecent } = this.options;

    // Keep recent entries, summarize older ones
    const memory = [...taskState.memory];
    const decisions = [...taskState.decisions];
    const patches = [...taskState.patches];

    const preservedMemory = memory.slice(-preserveRecent);
    const preservedDecisions = decisions.slice(-preserveRecent);

    const memoryToSummarize = memory.slice(0, -preserveRecent);
    const decisionsToSummarize = decisions.slice(0, -preserveRecent);

    // Build summary
    const summaryLines: string[] = [
      '--- Prior Session Summary ---',
      '',
      'Decisions made:',
      ...decisionsToSummarize.map((d) => `- ${d}`),
      '',
      'Key observations:',
      ...memoryToSummarize.slice(-20).map((m) => `[${m.kind}] ${m.summary}`),
      '',
      `Patches: ${patches.length} total (${patches.filter((p) => p.status === 'applied').length} applied)`,
      '---',
    ];

    const summary = summaryLines.join('\n');

    const compactedState: TaskState = {
      ...taskState,
      memory: [
        {
          id: `compaction-${Date.now()}`,
          sessionId: taskState.sessionId,
          kind: 'handoff',
          summary: `Session context compacted (${memoryToSummarize.length} entries summarized)`,
          detail: summary,
          source: 'compaction-service',
          timestamp: new Date().toISOString(),
        },
        ...preservedMemory,
      ],
      decisions: preservedDecisions,
    };

    return { state: compactedState, summary };
  }

  /**
   * Update options at runtime
   */
  updateOptions(options: Partial<CompactionOptions>): void {
    this.options = { ...this.options, ...options };
  }

  private calculateMemoryLength(packet: ContextPacket): number {
    let length = 0;

    // Count memory entries
    if (packet.retrievedMemory) {
      length += packet.retrievedMemory.reduce((sum, m) => sum + (m.summary?.length ?? 0), 0);
    }

    // Count decisions and constraints
    if (packet.decisions) {
      length += packet.decisions.reduce((sum, d) => sum + d.length, 0);
    }
    if (packet.constraints) {
      length += packet.constraints.reduce((sum, c) => sum + c.length, 0);
    }

    // Count patch history
    if (packet.patchHistory) {
      length += packet.patchHistory.reduce((sum, p) => sum + (p.summary?.length ?? 0), 0);
    }

    // Count other context
    length += packet.handoffSummary?.length ?? 0;
    length += packet.repoSummary?.length ?? 0;
    length += packet.workspaceFiles?.reduce((sum, f) => sum + f.length, 0) ?? 0;
    length += packet.terminalOutput?.length ?? 0;

    return length;
  }

  private calculateTaskStateLength(taskState: TaskState): number {
    let length = taskState.goal?.length ?? 0;
    length += taskState.decisions?.reduce((sum, d) => sum + d.length, 0) ?? 0;
    length += taskState.constraints?.reduce((sum, c) => sum + c.length, 0) ?? 0;
    length += taskState.memory?.reduce((sum, m) => sum + (m.summary?.length ?? 0) + (m.detail?.length ?? 0), 0) ?? 0;
    length += taskState.patches?.reduce((sum, p) => sum + (p.summary?.length ?? 0), 0) ?? 0;
    length += taskState.lastHandoffSummary?.length ?? 0;
    return length;
  }

  private performCompaction(packet: ContextPacket, totalLength: number): CompactionResult {
    const { preserveRecent } = this.options;

    const preservedEntries: string[] = [];

    // Identify what we'll preserve
    if (packet.retrievedMemory?.length) {
      const recentMemory = packet.retrievedMemory.slice(-preserveRecent);
      preservedEntries.push(...recentMemory.map((m) => m.id));
    }

    // Build a summary of what's being compacted
    const summaryLines: string[] = [
      `Context compacted from ${totalLength} characters`,
      '',
      'Original content included:',
      `- ${packet.decisions?.length ?? 0} decisions`,
      `- ${packet.constraints?.length ?? 0} constraints`,
      `- ${packet.retrievedMemory?.length ?? 0} memory entries`,
      `- ${packet.patchHistory?.length ?? 0} patches`,
      '',
      'Use compact() API or enable auto-compaction to regenerate full context.',
    ];

    const summary = summaryLines.join('\n');

    return {
      originalLength: totalLength,
      compactedLength: summary.length,
      wasCompacted: true,
      summary,
      preservedEntries,
    };
  }

  private createCompactedPacket(original: ContextPacket, result: CompactionResult): ContextPacket {
    const { preserveRecent } = this.options;

    return {
      ...original,
      // Keep only recent memory
      retrievedMemory: original.retrievedMemory?.slice(-preserveRecent) ?? [],
      // Summarize decisions
      decisions: original.decisions?.slice(-preserveRecent) ?? [],
      constraints: original.constraints?.slice(-preserveRecent) ?? [],
      patchHistory: original.patchHistory?.slice(-5) ?? [], // Keep last 5 patches
      // Add compaction notice to handoff
      handoffSummary: `${original.handoffSummary ?? ''}\n\n[${result.summary}]`.trim(),
      // Clear large fields
      terminalOutput: original.terminalOutput
        ? `[Terminal output truncated - ${original.terminalOutput.length} chars]`
        : undefined,
      // Keep repo structure but note it's compacted
      repoSummary: original.repoSummary
        ? `${original.repoSummary}\n[Repository context compacted]`
        : undefined,
    };
  }
}
