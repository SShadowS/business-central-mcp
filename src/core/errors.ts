export abstract class BCError extends Error {
  public readonly code: string;
  public readonly timestamp: Date;
  public readonly context?: Record<string, unknown>;
  protected constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.timestamp = new Date();
    this.context = context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
  public toJSON(): Record<string, unknown> {
    return { name: this.name, code: this.code, message: this.message, timestamp: this.timestamp.toISOString(), context: this.context };
  }
}
export class ConnectionError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'CONNECTION_ERROR', context); }
}
export class AuthenticationError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'AUTHENTICATION_ERROR', context); }
}
export class TimeoutError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'TIMEOUT_ERROR', context); }
}
export class AbortedError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'ABORTED_ERROR', context); }
}
export class ProtocolError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'PROTOCOL_ERROR', context); }
}
export class SessionLostError extends BCError {
  public readonly impactedPageContextIds: string[];
  public readonly reconnectFailed: boolean;
  constructor(message: string, impactedPageContextIds: string[], options?: { reconnectFailed?: boolean; context?: Record<string, unknown> }) {
    super(message, 'SESSION_LOST', options?.context);
    this.impactedPageContextIds = impactedPageContextIds;
    this.reconnectFailed = options?.reconnectFailed ?? false;
  }
}
export class ValidationError extends BCError {
  constructor(message: string, context?: Record<string, unknown>) { super(message, 'VALIDATION_ERROR', context); }
}
export class InputValidationError extends BCError {
  public readonly fieldErrors: Array<{ path: string; message: string }>;
  constructor(fieldErrors: Array<{ path: string; message: string }>) {
    super(`Input validation failed: ${fieldErrors.map(e => `${e.path}: ${e.message}`).join(', ')}`, 'INPUT_VALIDATION_ERROR');
    this.fieldErrors = fieldErrors;
  }
}
