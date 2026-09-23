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
  /** `enigma_await` and blocking `enigma_request` could not determine whether a request's declared names were stored: the single-use token was consumed (the human submitted the form) but `fulfill` never ran before the used-record grace period elapsed (Issue #69 AC #5). Message names the declared names and tells the agent to run `enigma list` to verify — never carries a value. Distinct from `E_REQUEST_EXPIRED`, which is reserved for a record that was never used in the first place. */
  | 'E_OUTCOME_UNKNOWN'
  /** `enigma run` could not spawn its child because the binary does not exist on PATH (Issue #22, AC #1). Maps to exit 127 (the shell convention for "command not found"); see docs/api-contracts.md §3. */
  | 'E_BINARY_MISSING';

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
