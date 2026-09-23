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
  | 'E_CLAUDE_SETTINGS_INVALID'
  | 'E_CLAUDE_SETTINGS_UNWRITABLE'
  | 'E_VAULT_CORRUPT'
  | 'E_CONFIG_CORRUPT'
  /** `enigma run` could not spawn its child because the binary does not exist on PATH (Issue #22, AC #1). Maps to exit 127 (the shell convention for "command not found"); see docs/api-contracts.md §3. */
  | 'E_BINARY_MISSING'
  /** `mutateIndex` could not acquire `<ENIGMA_HOME>/index.lock` within the bounded retry window (Issue #66, AC #2). The message names the lock file path so a reader knows what to investigate, never a value. */
  | 'E_LOCK_TIMEOUT';

export interface EnigmaErrorOptions {
  code: EnigmaErrorCode;
  message: string;
  /** The canonical secret name this error concerns, if any. */
  secretName?: string;
  /** The depository id this error concerns, if any. */
  depository?: string;
  /** Override the default exit code (1). CLI maps an error with this set to it; useful for shell-convention codes like 127 ("command not found"). */
  exitCode?: number;
}

export class EnigmaError extends Error {
  readonly code: EnigmaErrorCode;
  readonly secretName?: string;
  readonly depository?: string;
  readonly exitCode?: number;

  constructor(options: EnigmaErrorOptions) {
    super(options.message);
    this.name = 'EnigmaError';
    this.code = options.code;
    this.secretName = options.secretName;
    this.depository = options.depository;
    this.exitCode = options.exitCode;
    Object.setPrototypeOf(this, EnigmaError.prototype);
  }
}
