// Hook I/O shapes (docs/api-contracts.md §5, ADR-004). `tool_input`/`tool_response`
// are intentionally loose (Record<string, unknown> / unknown) because they vary by
// tool; each handler picks out only the fields it needs.

export interface HookInputBase {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
}

export interface SessionStartInput extends HookInputBase {
  source?: 'startup' | 'resume' | 'clear' | 'compact';
}

export interface PreToolUseInput extends HookInputBase {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PostToolUseInput extends HookInputBase {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
}

export interface SessionStartOutput {
  hookSpecificOutput: {
    hookEventName: 'SessionStart';
    additionalContext: string;
  };
}

export interface PreToolUseDenyOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

/**
 * Rewrites the tool call before it runs instead of blocking it outright — used
 * when a safe version of the call can be expressed (e.g. adding a glob
 * exclusion to a recursive Grep so it can't walk into a .env file), which
 * keeps the agent's work moving instead of denying a call that had nothing to
 * do with reading a secret. `updatedInput` replaces the tool's `tool_input`
 * wholesale, mirroring how the caller's own fields are spread into it.
 */
export interface PreToolUseAllowWithUpdatedInputOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow';
    permissionDecisionReason: string;
    updatedInput: Record<string, unknown>;
  };
}

/** `undefined` means "no output" — Claude Code proceeds with its normal permission flow. */
export type PreToolUseOutput = PreToolUseDenyOutput | PreToolUseAllowWithUpdatedInputOutput;

export interface PostToolUseOutput {
  systemMessage: string;
}
