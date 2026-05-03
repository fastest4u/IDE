import type {
  CollaborationRoleOutput,
  CollaborationRoleSpec,
  CollaborationWorkflowEdge,
  CollaborationWorkflowGraph,
  CollaborationWorkflowNode,
  ConditionNodeConfig,
  RetryNodeConfig,
  ApprovalNodeConfig,
  MemoryNodeConfig,
  NodeFailurePolicy,
  WorkflowApprovalDecision,
  WorkflowRunNodeState,
  WorkflowRunNodeStatus,
  WorkflowRunState,
  WorkflowRunStatus,
  WorkflowRunEvent,
  ContextPacket,
} from '@ide/protocol';

import type { ObsidianDatabaseService } from '../obsidian-database';

// ─── Condition expression evaluator (safe, no eval) ─────────

const ALLOWED_OPERATORS = new Set([
  '===', '!==', '==', '!=', '>=', '<=', '>', '<',
  'includes', 'startsWith', 'endsWith',
]);

interface ConditionContext {
  output: CollaborationRoleOutput | undefined;
  outputs: CollaborationRoleOutput[];
  packet: ContextPacket;
}

function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function evaluateSimpleExpression(expression: string, ctx: ConditionContext): boolean {
  const trimmed = expression.trim();
  if (!trimmed) return true;

  // Support: left op right
  const match = trimmed.match(
    /^([\w.]+)\s*(===|!==|==|!=|>=|<=|>|<|includes|startsWith|endsWith)\s*(?:'([^']*)'|"([^"]*)"|(\\d+(?:\\.\\d+)?)|(\\w+))$/,
  );
  if (!match) return false;

  const [, leftPath, operator, sq, dq, numStr, wordStr] = match;
  if (!ALLOWED_OPERATORS.has(operator)) return false;
  const rightValue: unknown = sq ?? dq ?? (numStr != null ? Number(numStr) : wordStr === 'true' ? true : wordStr === 'false' ? false : wordStr);

  const left = resolvePath(ctx, leftPath);

  switch (operator) {
    case '===':
    case '==':
      return left === rightValue;
    case '!==':
    case '!=':
      return left !== rightValue;
    case '>':
      return typeof left === 'number' && typeof rightValue === 'number' && left > rightValue;
    case '>=':
      return typeof left === 'number' && typeof rightValue === 'number' && left >= rightValue;
    case '<':
      return typeof left === 'number' && typeof rightValue === 'number' && left < rightValue;
    case '<=':
      return typeof left === 'number' && typeof rightValue === 'number' && left <= rightValue;
    case 'includes':
      return typeof left === 'string' && typeof rightValue === 'string' && left.includes(rightValue);
    case 'startsWith':
      return typeof left === 'string' && typeof rightValue === 'string' && left.startsWith(rightValue);
    case 'endsWith':
      return typeof left === 'string' && typeof rightValue === 'string' && left.endsWith(rightValue);
    default:
      return false;
  }
}

// ─── WorkflowEngine ────────────────────────────────────────

const MAX_RETRY_ATTEMPTS = 5;

export interface WorkflowEngineExecuteNodeFn {
  (nodeId: string, roleSpec: CollaborationRoleSpec, previousOutputs: CollaborationRoleOutput[]): Promise<CollaborationRoleOutput>;
}

export interface WorkflowEngineListener {
  (event: WorkflowRunEvent): void;
}

export interface WorkflowEngineOptions {
  obsidianDb?: ObsidianDatabaseService;
}

export class WorkflowEngine {
  private runs = new Map<string, WorkflowRunState>();
  private listeners: WorkflowEngineListener[] = [];

  constructor(private readonly options: WorkflowEngineOptions = {}) {}

  async hydrateFromObsidian(): Promise<void> {
    if (!this.options.obsidianDb) return;
    const runs = await this.options.obsidianDb.readWorkflowRuns();
    for (const run of runs) {
      const existing = this.runs.get(run.runId);
      if (!existing || run.updatedAt.localeCompare(existing.updatedAt) > 0) {
        this.runs.set(run.runId, run);
      }
    }
  }

  // ─── Event system ─────────────────────────────────

  onEvent(listener: WorkflowEngineListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: WorkflowRunEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* listener error should not crash engine */ }
    }
  }

  // ─── Run accessors ────────────────────────────────

  getRun(runId: string): WorkflowRunState | undefined {
    return this.runs.get(runId);
  }

  listRuns(workflowId?: string): WorkflowRunState[] {
    const all = [...this.runs.values()];
    if (workflowId) {
      return all.filter((run) => run.workflowId === workflowId);
    }
    return all;
  }

  /**
   * Execute a workflow graph node-by-node.
   * Returns the run state. If status is 'paused_approval', the caller
   * should wait for user approval and then call resumeRun().
   */
  async executeWorkflow(options: {
    runId: string;
    workflowId: string;
    collaborationId: string;
    graph: CollaborationWorkflowGraph;
    rolePlan: CollaborationRoleSpec[];
    packet: ContextPacket;
    executeNode: WorkflowEngineExecuteNodeFn;
    workflowVersion?: number;
  }): Promise<WorkflowRunState> {
    const { runId, workflowId, collaborationId, graph, rolePlan, packet, executeNode, workflowVersion } = options;
    const now = new Date().toISOString();

    const run: WorkflowRunState = {
      runId,
      workflowId,
      collaborationId,
      status: 'running',
      nodeStates: graph.nodes.map((node) => ({
        nodeId: node.id,
        status: 'pending' as WorkflowRunNodeStatus,
      })),
      outputs: [],
      graphSnapshot: structuredClone(graph),
      workflowVersion,
      createdAt: now,
      updatedAt: now,
    };

    this.runs.set(runId, run);
    await this.mirrorRun(run);
    return this.runLoop(run, graph, rolePlan, packet, executeNode);
  }

  /**
   * Resume a paused run after an approval decision.
   */
  async resumeRun(
    runId: string,
    decision: WorkflowApprovalDecision,
    graph: CollaborationWorkflowGraph,
    rolePlan: CollaborationRoleSpec[],
    packet: ContextPacket,
    executeNode: WorkflowEngineExecuteNodeFn,
  ): Promise<WorkflowRunState> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Workflow run ${runId} not found`);
    }
    if (run.status !== 'paused_approval') {
      throw new Error(`Run ${runId} is not paused at an approval node (status: ${run.status})`);
    }

    const approvalNodeId = run.pausedAtNodeId;
    if (!approvalNodeId || approvalNodeId !== decision.nodeId) {
      throw new Error(`Run ${runId} is paused at ${run.pausedAtNodeId}, not ${decision.nodeId}`);
    }

    const nodeState = run.nodeStates.find((ns) => ns.nodeId === approvalNodeId);
    if (nodeState) {
      nodeState.status = decision.decision === 'approve' ? 'approved' : 'rejected';
      nodeState.completedAt = decision.decidedAt;
    }

    if (decision.decision === 'reject') {
      // Skip all downstream nodes
      run.status = 'failed';
      run.pausedAtNodeId = undefined;
      run.updatedAt = decision.decidedAt;
      this.skipDownstream(run, approvalNodeId, graph);
      this.emit({ type: 'run_failed', runId, timestamp: decision.decidedAt });
      await this.mirrorRun(run);
      return run;
    }

    // Approved — continue execution
    run.status = 'running';
    run.pausedAtNodeId = undefined;
    run.updatedAt = decision.decidedAt;
    return this.runLoop(run, graph, rolePlan, packet, executeNode);
  }

  /**
   * Cancel a running or paused run.
   */
  cancelRun(runId: string): WorkflowRunState {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Workflow run ${runId} not found`);
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return run;
    }

    run.status = 'cancelled';
    run.pausedAtNodeId = undefined;
    run.updatedAt = new Date().toISOString();

    // Mark all pending/running nodes as skipped
    for (const ns of run.nodeStates) {
      if (ns.status === 'pending' || ns.status === 'running' || ns.status === 'waiting_approval') {
        ns.status = 'skipped';
        ns.completedAt = run.updatedAt;
      }
    }

    void this.mirrorRun(run);
    return run;
  }

  // ─── Core execution loop ────────────────────────────

  private async runLoop(
    run: WorkflowRunState,
    graph: CollaborationWorkflowGraph,
    rolePlan: CollaborationRoleSpec[],
    packet: ContextPacket,
    executeNode: WorkflowEngineExecuteNodeFn,
  ): Promise<WorkflowRunState> {
    const roleByNodeId = new Map(
      rolePlan.filter((r) => r.workflowNodeId).map((r) => [r.workflowNodeId!, r]),
    );

    let iterations = 0;
    const maxIterations = graph.nodes.length * (MAX_RETRY_ATTEMPTS + 1) + 10;

    while (iterations++ < maxIterations) {
      const readyNodes = this.findReadyNodes(run, graph);
      if (readyNodes.length === 0) break;

      // Execute ready nodes in parallel (within a wave)
      const results = await Promise.allSettled(
        readyNodes.map((node) => this.executeNodeByType(
          run, node, graph, roleByNodeId, packet, executeNode,
        )),
      );

      // Check if any node paused or stopped the run
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value === 'paused') {
          run.updatedAt = new Date().toISOString();
          await this.mirrorRun(run);
          return run;
        }
        if (result.status === 'fulfilled' && result.value === 'stopped') {
          run.status = 'failed';
          run.updatedAt = new Date().toISOString();
          this.emit({ type: 'run_failed', runId: run.runId, timestamp: run.updatedAt });
          await this.mirrorRun(run);
          return run;
        }
      }

      run.updatedAt = new Date().toISOString();
    }

    // Determine final status
    const hasFailure = run.nodeStates.some((ns) => ns.status === 'failed' || ns.status === 'rejected');
    if (run.status === 'running') {
      run.status = hasFailure ? 'failed' : 'completed';
    }
    run.updatedAt = new Date().toISOString();

    const eventType = run.status === 'completed' ? 'run_completed' : 'run_failed';
    this.emit({ type: eventType, runId: run.runId, timestamp: run.updatedAt });

    await this.mirrorRun(run);
    return run;
  }

  private async executeNodeByType(
    run: WorkflowRunState,
    node: CollaborationWorkflowNode,
    graph: CollaborationWorkflowGraph,
    roleByNodeId: Map<string, CollaborationRoleSpec>,
    packet: ContextPacket,
    executeNode: WorkflowEngineExecuteNodeFn,
  ): Promise<'completed' | 'paused' | 'failed' | 'stopped'> {
    const nodeState = run.nodeStates.find((ns) => ns.nodeId === node.id);
    if (!nodeState) return 'failed';

    const now = new Date().toISOString();
    nodeState.startedAt = now;
    nodeState.status = 'running';
    this.emit({ type: 'node_started', runId: run.runId, nodeId: node.id, timestamp: now });

    switch (node.type) {
      case 'start':
        nodeState.status = 'completed';
        nodeState.completedAt = new Date().toISOString();
        this.emit({ type: 'node_completed', runId: run.runId, nodeId: node.id, status: 'completed', timestamp: nodeState.completedAt });
        return 'completed';

      case 'end':
        nodeState.status = 'completed';
        nodeState.completedAt = new Date().toISOString();
        this.emit({ type: 'node_completed', runId: run.runId, nodeId: node.id, status: 'completed', timestamp: nodeState.completedAt });
        return 'completed';

      case 'agent':
      case 'synthesizer':
      case 'tool':
      case 'memory': {
        return this.executeExecutableNode(run, node, nodeState, roleByNodeId, packet, executeNode, graph);
      }

      case 'condition': {
        const config = node.config as ConditionNodeConfig | undefined;
        if (!config?.expression) {
          nodeState.status = 'completed';
          nodeState.completedAt = new Date().toISOString();
          this.emit({ type: 'node_completed', runId: run.runId, nodeId: node.id, status: 'completed', timestamp: nodeState.completedAt });
          return 'completed';
        }

        const lastOutput = run.outputs[run.outputs.length - 1];
        const result = evaluateSimpleExpression(config.expression, {
          output: lastOutput,
          outputs: run.outputs,
          packet,
        });

        // Mark downstream edges based on condition result
        const outEdges = graph.edges.filter((e) => e.source === node.id);
        for (const edge of outEdges) {
          const isTrueBranch = edge.branch === 'true' || edge.label === config.trueBranch;
          const isFalseBranch = edge.branch === 'false' || edge.label === config.falseBranch;

          if (result && isFalseBranch) {
            this.skipNode(run, edge.target);
          } else if (!result && isTrueBranch) {
            this.skipNode(run, edge.target);
          }
        }

        nodeState.status = 'completed';
        nodeState.completedAt = new Date().toISOString();
        this.emit({ type: 'node_completed', runId: run.runId, nodeId: node.id, status: 'completed', timestamp: nodeState.completedAt });
        return 'completed';
      }

      case 'retry': {
        const config = node.config as RetryNodeConfig | undefined;
        const maxAttempts = Math.min(config?.maxAttempts ?? 3, MAX_RETRY_ATTEMPTS);
        const retryCount = nodeState.retryCount ?? 0;

        // Find the target node to retry (first outgoing edge with branch !== 'exhaust')
        const retryEdge = graph.edges.find(
          (e) => e.source === node.id && e.branch !== 'exhaust',
        );
        const exhaustEdge = graph.edges.find(
          (e) => e.source === node.id && e.branch === 'exhaust',
        );

        if (!retryEdge) {
          nodeState.status = 'completed';
          nodeState.completedAt = new Date().toISOString();
          return 'completed';
        }

        // Check if the target node previously failed
        const targetState = run.nodeStates.find((ns) => ns.nodeId === retryEdge.target);
        if (targetState && targetState.status === 'failed' && retryCount < maxAttempts) {
          // Reset target for retry
          nodeState.retryCount = retryCount + 1;
          nodeState.status = 'retrying';
          targetState.status = 'pending';
          targetState.output = undefined;
          targetState.error = undefined;
          targetState.startedAt = undefined;
          targetState.completedAt = undefined;

          this.emit({ type: 'node_retrying', runId: run.runId, nodeId: node.id, timestamp: new Date().toISOString() });

          // Exponential backoff with jitter
          const baseDelay = config?.delayMs ?? 1000;
          const delay = baseDelay * Math.pow(2, retryCount);
          const jitter = Math.random() * delay * 0.1;
          const finalDelay = Math.min(delay + jitter, 30000);

          if (finalDelay > 0) {
            await new Promise((resolve) => setTimeout(resolve, finalDelay));
          }
          return 'completed'; // Let the loop pick up the reset target
        }

        if (retryCount >= maxAttempts && exhaustEdge) {
          // Follow exhaust branch
          nodeState.status = 'completed';
          nodeState.completedAt = new Date().toISOString();
          return 'completed';
        }

        nodeState.status = 'completed';
        nodeState.completedAt = new Date().toISOString();
        return 'completed';
      }

      case 'approval': {
        nodeState.status = 'waiting_approval';
        run.status = 'paused_approval';
        run.pausedAtNodeId = node.id;
        this.emit({ type: 'run_paused', runId: run.runId, nodeId: node.id, timestamp: new Date().toISOString() });
        return 'paused';
      }

      default:
        nodeState.status = 'skipped';
        nodeState.completedAt = new Date().toISOString();
        return 'completed';
    }
  }

  /**
   * Execute an agent/tool/memory/synthesizer node with failure policy support.
   */
  private async executeExecutableNode(
    run: WorkflowRunState,
    node: CollaborationWorkflowNode,
    nodeState: WorkflowRunNodeState,
    roleByNodeId: Map<string, CollaborationRoleSpec>,
    packet: ContextPacket,
    executeNode: WorkflowEngineExecuteNodeFn,
    graph: CollaborationWorkflowGraph,
  ): Promise<'completed' | 'failed' | 'stopped'> {
    const roleSpec = roleByNodeId.get(node.id);
    if (!roleSpec) {
      nodeState.status = 'skipped';
      nodeState.error = `No role spec mapped for node ${node.id}`;
      nodeState.completedAt = new Date().toISOString();
      this.emit({ type: 'node_completed', runId: run.runId, nodeId: node.id, status: 'skipped', timestamp: nodeState.completedAt });
      return 'completed';
    }

    try {
      const output = await executeNode(node.id, roleSpec, [...run.outputs]);
      if (output.status === 'completed') {
        nodeState.status = 'completed';
        nodeState.output = output;
        nodeState.completedAt = new Date().toISOString();
        run.outputs.push(output);
        this.emit({ type: 'node_completed', runId: run.runId, nodeId: node.id, status: 'completed', timestamp: nodeState.completedAt });
        return 'completed';
      }

      // Output status is not 'completed' — treat as failure
      return this.handleNodeFailure(run, node, nodeState, output, graph, roleByNodeId, packet, executeNode);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      nodeState.error = errorMessage;
      return this.handleNodeFailure(run, node, nodeState, undefined, graph, roleByNodeId, packet, executeNode);
    }
  }

  /**
   * Apply the node's onFailure policy.
   */
  private async handleNodeFailure(
    run: WorkflowRunState,
    node: CollaborationWorkflowNode,
    nodeState: WorkflowRunNodeState,
    failedOutput: CollaborationRoleOutput | undefined,
    graph: CollaborationWorkflowGraph,
    roleByNodeId: Map<string, CollaborationRoleSpec>,
    packet: ContextPacket,
    executeNode: WorkflowEngineExecuteNodeFn,
  ): Promise<'completed' | 'failed' | 'stopped'> {
    const policy: NodeFailurePolicy = node.onFailure ?? 'stop';
    const now = new Date().toISOString();

    this.emit({ type: 'node_failed', runId: run.runId, nodeId: node.id, error: nodeState.error, timestamp: now });

    switch (policy) {
      case 'stop':
        nodeState.status = 'failed';
        nodeState.completedAt = now;
        if (failedOutput) run.outputs.push(failedOutput);
        // Skip all downstream
        this.skipDownstream(run, node.id, graph);
        return 'stopped';

      case 'skip':
        nodeState.status = 'skipped';
        nodeState.completedAt = now;
        nodeState.error = `[skipped] ${nodeState.error ?? 'node failed'}`;
        return 'completed';

      case 'retry': {
        const maxRetries = Math.min(node.maxRetries ?? 3, MAX_RETRY_ATTEMPTS);
        const retryCount = nodeState.retryCount ?? 0;

        if (retryCount < maxRetries) {
          nodeState.retryCount = retryCount + 1;
          nodeState.status = 'pending';
          nodeState.output = undefined;
          nodeState.startedAt = undefined;
          nodeState.completedAt = undefined;
          const previousError = nodeState.error;
          nodeState.error = undefined;

          this.emit({ type: 'node_retrying', runId: run.runId, nodeId: node.id, timestamp: now });

          // Exponential backoff
          const delay = 1000 * Math.pow(2, retryCount);
          const jitter = Math.random() * delay * 0.1;
          await new Promise((resolve) => setTimeout(resolve, Math.min(delay + jitter, 30000)));

          return 'completed'; // Loop will re-pick this node
        }

        // Exhausted retries — fail
        nodeState.status = 'failed';
        nodeState.completedAt = now;
        if (failedOutput) run.outputs.push(failedOutput);
        this.skipDownstream(run, node.id, graph);
        return 'stopped';
      }

      case 'fallback': {
        const fallbackId = node.fallbackNodeId;
        if (!fallbackId) {
          // No fallback configured — treat as stop
          nodeState.status = 'failed';
          nodeState.completedAt = now;
          if (failedOutput) run.outputs.push(failedOutput);
          this.skipDownstream(run, node.id, graph);
          return 'stopped';
        }

        // Mark current node as failed
        nodeState.status = 'failed';
        nodeState.completedAt = now;

        // Activate the fallback node (set to pending if it was skipped)
        const fallbackState = run.nodeStates.find((ns) => ns.nodeId === fallbackId);
        if (fallbackState && (fallbackState.status === 'pending' || fallbackState.status === 'skipped')) {
          fallbackState.status = 'pending';
          fallbackState.startedAt = undefined;
          fallbackState.completedAt = undefined;
          fallbackState.error = undefined;
        }

        return 'completed'; // Let the loop pick up the fallback node
      }
    }
  }

  // ─── Graph traversal helpers ────────────────────────

  private findReadyNodes(
    run: WorkflowRunState,
    graph: CollaborationWorkflowGraph,
  ): CollaborationWorkflowNode[] {
    const stateMap = new Map(run.nodeStates.map((ns) => [ns.nodeId, ns]));

    return graph.nodes.filter((node) => {
      const ns = stateMap.get(node.id);
      if (!ns || ns.status !== 'pending') return false;

      // All incoming edges' source nodes must be completed/approved/skipped
      const inEdges = graph.edges.filter((e) => e.target === node.id);
      if (inEdges.length === 0) return true; // Root nodes are always ready

      return inEdges.every((edge) => {
        const sourceState = stateMap.get(edge.source);
        if (!sourceState) return true;
        return (
          sourceState.status === 'completed' ||
          sourceState.status === 'approved' ||
          sourceState.status === 'skipped'
        );
      });
    });
  }

  private skipNode(run: WorkflowRunState, nodeId: string): void {
    const ns = run.nodeStates.find((s) => s.nodeId === nodeId);
    if (ns && ns.status === 'pending') {
      ns.status = 'skipped';
      ns.completedAt = new Date().toISOString();
    }
  }

  private skipDownstream(
    run: WorkflowRunState,
    fromNodeId: string,
    graph: CollaborationWorkflowGraph,
  ): void {
    const visited = new Set<string>();
    const queue = [fromNodeId];
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const outEdges = graph.edges.filter((e) => e.source === current);
      for (const edge of outEdges) {
        this.skipNode(run, edge.target);
        queue.push(edge.target);
      }
    }
  }

  private async mirrorRun(run: WorkflowRunState): Promise<void> {
    if (!this.options.obsidianDb) return;
    try {
      await this.options.obsidianDb.writeWorkflowRun(run);
    } catch {}
  }
}
