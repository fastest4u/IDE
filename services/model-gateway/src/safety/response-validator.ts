import type { AIResponse, ValidationResult, AIValidator, AIToolCall } from '@ide/protocol';

export class ResponseValidator implements AIValidator {
  async validateResponse(response: AIResponse): Promise<ValidationResult> {
    const warnings: string[] = [];
    const errors: string[] = [];

    if (!response.requestId) {
      errors.push('Missing requestId');
    }

    if (!response.text?.trim()) {
      warnings.push('Response has no text payload');
    }

    return {
      valid: errors.length === 0,
      warnings,
      errors,
    };
  }

  async validateToolCall(toolCall: AIToolCall): Promise<ValidationResult> {
    const errors: string[] = [];

    if (!toolCall.id || !toolCall.name) {
      errors.push('Tool call must include id and name');
    }

    return {
      valid: errors.length === 0,
      warnings: [],
      errors,
    };
  }
}
