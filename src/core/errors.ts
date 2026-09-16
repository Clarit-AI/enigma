export type EnigmaErrorCode =
  | 'E_NAME_INVALID'
  | 'E_NOT_FOUND'
  | 'E_EXISTS'
  | 'E_DEPOSITORY_UNAVAILABLE'
  | 'E_READ_FAILED'
  | 'E_WRITE_FAILED'
  | 'E_VALUE_TOO_LARGE'
  | 'E_REF_INVALID'
  | 'E_REQUEST_EXPIRED'
  | 'E_REQUEST_USED'
  | 'E_AMBIGUOUS_SCOPE'
  | 'E_SCOPE_INVALID'
  | 'E_INDEX_CORRUPT'
  | 'E_NO_TTY_CONTROL'
  | 'E_UI_UNAVAILABLE'
  | 'E_REQUEST_CANCELLED'
  | 'E_VAULT_MISSING'
  | 'E_REMOTE_UNAVAILABLE'
  | 'E_VALUE_AMBIGUOUS'
  | 'E_CLAUDE_SETTINGS_INVALID';

export interface EnigmaErrorOptions {
  code: EnigmaErrorCode;
  message: string;
  /** The canonical secret name this error concerns, if any. */
  secretName?: string;
  /** The depository id this error concerns, if any. */
  depository?: string;
}

export class EnigmaError extends Error {
  readonly code: EnigmaErrorCode;
  readonly secretName?: string;
  readonly depository?: string;

  constructor(options: EnigmaErrorOptions) {
    super(options.message);
    this.name = 'EnigmaError';
    this.code = options.code;
    this.secretName = options.secretName;
    this.depository = options.depository;
    Object.setPrototypeOf(this, EnigmaError.prototype);
  }
}
