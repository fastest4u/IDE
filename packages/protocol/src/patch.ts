import type { AIToolCallSpec } from './ai';

export type PatchStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'failed'
  | 'rolled_back';

export type PatchOperationKind = 'write_file' | 'delete_file';

export interface PatchOperation {
  id: string;
  kind: PatchOperationKind;
  filePath: string;
  beforeContent?: string;
  afterContent?: string;
}

export interface PatchDiffLine {
  type: 'context' | 'add' | 'remove';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface PatchDiffHunk {
  header: string;
  lines: PatchDiffLine[];
}

export interface StructuredPatchDiff {
  filePath: string;
  operation: PatchOperationKind;
  additions: number;
  deletions: number;
  hunks: PatchDiffHunk[];
}

export type PatchReviewSeverity = 'info' | 'warning' | 'error';
export type PatchReviewStatus = 'passed' | 'warning' | 'blocked';

export interface PatchReviewFinding {
  severity: PatchReviewSeverity;
  code: string;
  message: string;
  filePath?: string;
  operationId?: string;
}

export interface PatchReviewResult {
  status: PatchReviewStatus;
  reviewer: 'deterministic';
  verifier: 'precondition-check';
  findings: PatchReviewFinding[];
  checkedAt: string;
}

export interface PatchRollbackEntry {
  filePath: string;
  previousContent: string | null;
  appliedContent: string | null;
  appliedAt: string;
}

export interface PatchRollbackPlan {
  available: boolean;
  entries: PatchRollbackEntry[];
  rolledBackAt?: string;
}

export interface PatchRecord {
  id: string;
  title: string;
  summary: string;
  status: PatchStatus;
  sessionId?: string;
  operations: PatchOperation[];
  diff: StructuredPatchDiff[];
  review?: PatchReviewResult;
  rollback?: PatchRollbackPlan;
  notes?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PatchCreateRequest {
  id?: string;
  title: string;
  summary?: string;
  sessionId?: string;
  operations: PatchOperation[];
}

export const AI_PATCH_TOOL_NAME = 'ide_create_patch';

export const AI_PATCH_TOOL_SPEC: AIToolCallSpec = {
  name: AI_PATCH_TOOL_NAME,
  description: 'Create a reviewable IDE patch record from structured file operations. The IDE will show a diff card and require user approval before apply.',
  strict: true,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'operations'],
    properties: {
      id: {
        type: 'string',
        description: 'Optional stable patch id. Omit unless the caller provided one.',
      },
      title: {
        type: 'string',
        description: 'Short human-readable patch title.',
      },
      summary: {
        type: 'string',
        description: 'Brief explanation of the intended code change and why it is safe.',
      },
      sessionId: {
        type: 'string',
        description: 'Optional session id. Omit when unknown; the gateway injects the active session.',
      },
      operations: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'kind', 'filePath'],
          properties: {
            id: {
              type: 'string',
              description: 'Stable operation id unique within the patch, such as op-1.',
            },
            kind: {
              type: 'string',
              enum: ['write_file', 'delete_file'],
            },
            filePath: {
              type: 'string',
              description: 'Workspace-relative path only. Never absolute, never ../ traversal.',
            },
            beforeContent: {
              type: 'string',
              description: 'Exact current file content when editing or deleting an existing file. Use empty string only for a new empty file.',
            },
            afterContent: {
              type: 'string',
              description: 'Full replacement content for write_file. Omit for delete_file.',
            },
          },
        },
      },
    },
  },
};

export const AI_PATCH_TOOL_INSTRUCTIONS = [
  'When proposing code edits, do not paste replacement files into chat.',
  `Use the ${AI_PATCH_TOOL_NAME} tool with a payload that maps directly to PatchCreateRequest.`,
  'Every operation must use a workspace-relative filePath and full afterContent for write_file.',
  'Include beforeContent whenever the target file already exists so the IDE can detect stale or conflicting edits before approval.',
  'The IDE will create a patch card, show the structured diff, run verifier checks, and require user approval before applying.',
].join('\n');
