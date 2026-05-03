export type ToolApprovalTool = 'terminal';
export type ToolApprovalAction = 'terminal.exec' | 'terminal.restart' | 'terminal.write';
export type ToolApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ToolApprovalResult {
  sessionId?: string;
  output?: string;
  exitCode?: number | null;
}

export interface ToolApprovalRecord {
  id: string;
  tool: ToolApprovalTool;
  action: ToolApprovalAction;
  status: ToolApprovalStatus;
  summary: string;
  command?: string;
  cwd?: string;
  targetSessionId?: string;
  createdAt: string;
  updatedAt: string;
  decidedAt?: string;
  reason?: string;
  result?: ToolApprovalResult;
  metadata?: Record<string, unknown>;
}

export interface ToolApprovalDecisionRequest {
  reason?: string;
}

export interface ToolApprovalListResponse {
  approvals: ToolApprovalRecord[];
}

export interface ToolApprovalResponse {
  approval: ToolApprovalRecord;
}
