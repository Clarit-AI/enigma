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

/** `undefined` means "no output" — Claude Code proceeds with its normal permission flow. */
export type PreToolUseOutput = PreToolUseDenyOutput;

export interface PostToolUseOutput {
  systemMessage: string;
}
