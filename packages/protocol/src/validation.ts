import type { AIResponse, AIToolCall } from './ai';

export interface SafetyPolicy {
  redactSecrets: boolean;
  allowShellCommands: boolean;
  requireApprovalForDestructiveActions: boolean;
  blockedPatterns?: Array<{ pattern: string; flags?: string }>;
  metadata?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

export interface AIValidator {
  validateResponse(response: AIResponse): Promise<ValidationResult>;
  validateToolCall(toolCall: AIToolCall): Promise<ValidationResult>;
}
