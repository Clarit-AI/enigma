export type EnigmaErrorCode =
  | 'E_NAME_INVALID'
  | 'E_NOT_FOUND'
  | 'E_EXISTS'
  | 'E_DEPOSITORY_UNAVAILABLE'
  | 'E_READ_FAILED'
  | 'E_REQUEST_EXPIRED'
  | 'E_REQUEST_USED'
  | 'E_AMBIGUOUS_SCOPE';

export interface EnigmaErrorOptions {
  code: EnigmaErrorCode;
  message: string;
  /** The canonical secret name this error concerns, if any. */
  name?: string;
  /** The depository id this error concerns, if any. */
  depository?: string;
}

// `name` is the secret's canonical name, not the JS Error class name (both are safe to log per ADR-001).
export class EnigmaError extends Error {
  readonly code: EnigmaErrorCode;
  readonly depository?: string;

  constructor(options: EnigmaErrorOptions) {
    super(options.message);
    this.name = options.name ?? 'EnigmaError';
    this.code = options.code;
    this.depository = options.depository;
    Object.setPrototypeOf(this, EnigmaError.prototype);
  }
}
