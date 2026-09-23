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
  /**
   * Optional compare-and-delete used by Issue #70's rotate cleanup on
   * stable-address depositories: removes `ref` only when the stored value
   * still equals `expectedValue` (the displaced copy the caller captured
   * before committing). Stable locations are reusable — a concurrent rotate
   * can legitimately repopulate the same address between the index commit
   * and this delete — so the comparison, where it can run atomically inside
   * the depository's own read-modify-write, is what prevents deleting a
   * value that isn't the displaced one. Returns whether a delete happened.
   * Absent → callers fall back to `delete` (fresh-id and promptable
   * depositories, where a guarding read is unnecessary or would prompt).
   */
  deleteIfUnchanged?(ref: string, expectedValue: string): Promise<boolean>;
  has(ref: string): Promise<boolean>;
}

/** Context a depository needs to locate its backing store or that carries a one-time user confirmation. */
export interface DepositoryContext {
  /**
   * The project scope's absolute path, when the entry being written/read is
   * project-scoped. Required by `env` (locates `<projectPath>/.env`); also
   * consumed by `1password` (builds the `NAME · <project folder>` item
   * title — cosmetic only, reads go by item id); ignored by depositories
   * that don't need it.
   */
  projectPath?: string;
  /**
   * Explicit, one-time user confirmation to create a depository's backing
   * collection when it doesn't exist yet. Consumed only by `1password`
   * (creates the `Enigma` vault on first use); never a default, only ever
   * forwarded from an actual user confirmation (e.g. the request form's
   * `confirmCreateVault` checkbox).
   */
  createVault?: boolean;
}

/** Groups a depository's static capability probe with its instance factory. */
export interface DepositoryModule {
  readonly id: DepositoryId;
  readonly promptProfile: PromptProfile;
  /** Reports availability on this platform without prompting the user. */
  detect(): Promise<DetectionResult>;
  create(ctx: DepositoryContext): Depository;
}
