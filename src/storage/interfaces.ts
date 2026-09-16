export type DepositoryId = 'env' | 'encrypted' | 'keychain' | 'secret-service' | '1password';

export type PromptProfile = 'none' | 'may-prompt' | 'prompts-each-read';

export interface DetectionResult {
  id: DepositoryId;
  promptProfile: PromptProfile;
  available: boolean;
  /** Why unavailable, if applicable. Never a value. */
  reason?: string;
}

/**
 * A place a secret's value lives (glossary: depository).
 *
 * `ref` convention (D1.9): `"<scopeId>/<NAME>"` where `scopeId` is the
 * literal string `global` or the 16-hex `projectId`, for every depository
 * except `env`, whose ref is the bare `NAME` — the `.env` file is already
 * located via `DepositoryContext.projectPath`, so scope would be redundant.
 */
export interface Depository {
  readonly id: DepositoryId;
  readonly promptProfile: PromptProfile;
  /**
   * Stores `value` under `ref` and returns the effective ref to record in the
   * index entry. `encrypted` and `env` return the input `ref` unchanged;
   * `1password` (when implemented) will return the item id it created, which
   * may differ from the input ref.
   */
  set(ref: string, value: string): Promise<string>;
  /**
   * @internal Resolves `ref` to its value. Called only from
   * `src/storage/manager.ts`, `src/request/**`, `src/native/**`,
   * `src/hooks/tripwire.ts`, and `cli/commands/{run,get,reveal,move,import}`
   * (style-guide secret-handling conventions; ADR-001).
   */
  resolve(ref: string): Promise<string>;
  delete(ref: string): Promise<void>;
  has(ref: string): Promise<boolean>;
}

/** Context a depository needs to locate its backing store. */
export interface DepositoryContext {
  /** Required by `env` (locates `<projectPath>/.env`); ignored by `encrypted`. */
  projectPath?: string;
}

/** Groups a depository's static capability probe with its instance factory. */
export interface DepositoryModule {
  readonly id: DepositoryId;
  readonly promptProfile: PromptProfile;
  /** Reports availability on this platform without prompting the user. */
  detect(): Promise<DetectionResult>;
  create(ctx: DepositoryContext): Depository;
}
