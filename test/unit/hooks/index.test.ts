import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dispatch } from '../../../src/hooks/index.js';

describe('hooks dispatch', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'enigma-home-'));
    originalHome = process.env.ENIGMA_HOME;
    process.env.ENIGMA_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.ENIGMA_HOME;
    else process.env.ENIGMA_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('dispatches SessionStart to the session-start handler', async () => {
    const output = (await dispatch('SessionStart', { cwd: tmpdir() })) as {
      hookSpecificOutput: { hookEventName: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
  });

  it('dispatches PreToolUse to the read-guard and returns undefined for an allowed call', async () => {
    const output = await dispatch('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo hi' }, cwd: tmpdir() });
    expect(output).toBeUndefined();
  });

  it('dispatches PreToolUse to the read-guard and returns a deny decision for a blocked call', async () => {
    const output = (await dispatch('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cat .env' }, cwd: tmpdir() })) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('dispatches PostToolUse to the tripwire and returns undefined with no candidates', async () => {
    const output = await dispatch('PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_response: 'nothing', cwd: tmpdir() });
    expect(output).toBeUndefined();
  });

  it('returns undefined for an unknown event name', async () => {
    expect(await dispatch('SomethingElse', {})).toBeUndefined();
  });

  it('returns undefined for an undefined event name', async () => {
    expect(await dispatch(undefined, {})).toBeUndefined();
  });

  it('fails open: never throws even when the input is malformed for the event', async () => {
    await expect(dispatch('PreToolUse', null)).resolves.toBeUndefined();
    await expect(dispatch('SessionStart', null)).resolves.toBeUndefined();
    await expect(dispatch('PostToolUse', null)).resolves.toBeUndefined();
  });
});
