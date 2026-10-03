/* Issue #108, end to end: every lifecycle operation run SEQUENTIALLY through the real CLI / `setSecret` paths
 * (fake prompting store only), across two worktrees of one project (A, B) and a second project (C), asserting the
 * exact bytes of every target file and the exact ledger after EVERY step. Review B2 showed the basic flows were not
 * covered end to end: `move` env -> encrypted used to leave the origin worktree with no definition at all.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdImport } from '../../../src/cli/commands/import.js';
import { cmdMove } from '../../../src/cli/commands/move.js';
import { cmdRemove } from '../../../src/cli/commands/remove.js';
import { cmdRender } from '../../../src/cli/commands/render.js';
import { auditLogPath, indexPath, renderLedgerPath } from '../../../src/core/paths.js';
import { readLedger } from '../../../src/render/ledger.js';
import { setSecret } from '../../../src/storage/manager.js';
import type { FakeStore, Sandbox } from './fanout-helpers.js';
import { installFakePromptingStore, makeOtherRepo, makeRepo, makeSandbox } from './fanout-helpers.js';

const SENTINEL = 'sk-matrix-sentinel-108';
const RB = '# enigma:render:begin\n';
const RE = '# enigma:render:end\n';
const EB = '# enigma:begin\n';
const EE = '# enigma:end\n';

let sb: Sandbox;
let fake: FakeStore;
let prior: string;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  sb = makeSandbox();
  prior = process.cwd();
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  fake = installFakePromptingStore();
});

afterEach(() => {
  process.chdir(prior);
  fake.restore();
  vi.restoreAllMocks();
  sb.cleanup();
});

describe('lifecycle matrix, sequential, exact bytes after every step', () => {
  it('create / rotate / render / move (all directions) / delete / import (success and abort)', async () => {
    const { worktrees: [A, B] } = makeRepo(sb, 1);
    const C = makeOtherRepo(sb).worktree;
    const name = (w: string): string => (w === A ? 'A' : w === B ? 'B' : 'C');
    const file = (w: string): string | null => (existsSync(join(w, '.env')) ? readFileSync(join(w, '.env'), 'utf8') : null);
    const ledger = (): Array<[string, string[]]> => readLedger().targets.map((t) => [name(t.worktree), t.names]);
    const at = (w: string): void => process.chdir(w);
    const set = (w: string, n: string, v: string, o: Record<string, unknown> = {}) =>
      setSecret({ name: n, value: v, scope: 'project', depository: 'encrypted', cwd: w, actor: 'cli', ...o });
    const check = (label: string, want: { A: string | null; B: string | null; C: string | null; ledger: Array<[string, string[]]> }): void => {
      expect({ label, A: file(A!), B: file(B!), C: file(C), ledger: ledger() }).toEqual({ label, ...want });
    };

    // --- create (no-prompt): the originating worktree gains it; another project's identical name is its own
    await set(C, 'K1', 'c1');
    check('C creates K1 (encrypted)', { A: null, B: null, C: `${RB}K1=c1\n${RE}`, ledger: [['C', ['K1']]] });
    await set(A!, 'K1', SENTINEL);
    check('A creates K1 (encrypted)', { A: `${RB}K1=${SENTINEL}\n${RE}`, B: null, C: `${RB}K1=c1\n${RE}`, ledger: [['C', ['K1']], ['A', ['K1']]] });

    // --- plain render from B adopts every eligible name
    at(B!);
    expect(await cmdRender([])).toBe(0);
    const k1 = (v: string) => `${RB}K1=${v}\n${RE}`;
    check('render from B', { A: k1(SENTINEL), B: k1(SENTINEL), C: k1('c1'), ledger: [['C', ['K1']], ['A', ['K1']], ['B', ['K1']]] });

    // --- create (prompting): nothing rendered anywhere
    await set(A!, 'K2', 'k2', { depository: 'keychain' });
    check('A creates K2 (keychain)', { A: k1(SENTINEL), B: k1(SENTINEL), C: k1('c1'), ledger: [['C', ['K1']], ['A', ['K1']], ['B', ['K1']]] });

    // --- rotate (no-prompt): every holder of this project, from another worktree; C untouched
    await set(B!, 'K1', 'v2', { rotate: true });
    check('B rotates K1', { A: k1('v2'), B: k1('v2'), C: k1('c1'), ledger: [['C', ['K1']], ['A', ['K1']], ['B', ['K1']]] });

    // --- rotate (prompting): no holder, nothing changes, nothing added
    await set(A!, 'K2', 'k2b', { depository: 'keychain', rotate: true });
    check('A rotates K2 (keychain), no holder', { A: k1('v2'), B: k1('v2'), C: k1('c1'), ledger: [['C', ['K1']], ['A', ['K1']], ['B', ['K1']]] });

    // --- explicit render of a prompting-store name; then a rotate updates that holder only, no prompt
    at(A!);
    expect(await cmdRender(['K2'])).toBe(0);
    check('A renders K2 explicitly', { A: `${RB}K1=v2\nK2=k2b\n${RE}`, B: k1('v2'), C: k1('c1'), ledger: [['C', ['K1']], ['A', ['K1', 'K2']], ['B', ['K1']]] });
    fake.resolveCalls.length = 0;
    await set(B!, 'K2', 'k2c', { depository: 'keychain', rotate: true });
    check('B rotates K2 (keychain)', { A: `${RB}K1=v2\nK2=k2c\n${RE}`, B: k1('v2'), C: k1('c1'), ledger: [['C', ['K1']], ['A', ['K1', 'K2']], ['B', ['K1']]] });
    expect(fake.resolveCalls).toEqual([]);

    // --- move encrypted -> env from A: A's render line becomes its env-block copy; B (no env copy) keeps its line
    at(A!);
    expect(await cmdMove(['K1', '--to', 'env', '--scope', 'project'])).toBe(0);
    check('move K1 encrypted -> env', { A: `${RB}K2=k2c\n${RE}${EB}K1=v2\n${EE}`, B: k1('v2'), C: k1('c1'), ledger: [['C', ['K1']], ['A', ['K2']], ['B', ['K1']]] });

    // --- move env -> encrypted from A (review B2): A's env copy is gone, so it gains the render line
    expect(await cmdMove(['K1', '--to', 'encrypted', '--scope', 'project'])).toBe(0);
    check('move K1 env -> encrypted', { A: `${RB}K2=k2c\nK1=v2\n${RE}${EB}${EE}`, B: k1('v2'), C: k1('c1'), ledger: [['C', ['K1']], ['A', ['K1', 'K2']], ['B', ['K1']]] });

    // --- move into the keychain: stripped everywhere, rows gone
    expect(await cmdMove(['K1', '--to', 'keychain', '--scope', 'project'])).toBe(0);
    check('move K1 encrypted -> keychain', { A: `${RB}K2=k2c\n${RE}${EB}${EE}`, B: '', C: k1('c1'), ledger: [['C', ['K1']], ['A', ['K2']]] });

    // --- move out of the keychain into encrypted, from B: no holder, nothing is added
    at(B!);
    expect(await cmdMove(['K1', '--to', 'encrypted', '--scope', 'project'])).toBe(0);
    check('move K1 keychain -> encrypted (B)', { A: `${RB}K2=k2c\n${RE}${EB}${EE}`, B: '', C: k1('c1'), ledger: [['C', ['K1']], ['A', ['K2']]] });

    // --- encrypted -> env again, then env -> keychain
    at(A!);
    expect(await cmdMove(['K1', '--to', 'env', '--scope', 'project'])).toBe(0);
    check('move K1 encrypted -> env (again)', { A: `${RB}K2=k2c\n${RE}${EB}K1=v2\n${EE}`, B: '', C: k1('c1'), ledger: [['C', ['K1']], ['A', ['K2']]] });
    expect(await cmdMove(['K1', '--to', 'keychain', '--scope', 'project'])).toBe(0);
    check('move K1 env -> keychain', { A: `${RB}K2=k2c\n${RE}${EB}${EE}`, B: '', C: k1('c1'), ledger: [['C', ['K1']], ['A', ['K2']]] });

    // --- delete a keychain secret that is rendered: stripped, row gone, block gone
    expect(await cmdRemove(['K2', '--scope', 'project'])).toBe(0);
    check('delete K2', { A: `${EB}${EE}`, B: '', C: k1('c1'), ledger: [['C', ['K1']]] });

    // --- import success: plaintext lines gone, rendered exactly once
    writeFileSync(join(A!, 'import.env'), 'IMP1=a\nIMP2=b\n');
    expect(await cmdImport(['import.env', '--depository', 'encrypted'])).toBe(0);
    check('import success', { A: `${EB}${EE}${RB}IMP1=a\nIMP2=b\n${RE}`, B: '', C: k1('c1'), ledger: [['C', ['K1']], ['A', ['IMP1', 'IMP2']]] });
    expect(readFileSync(join(A!, 'import.env'), 'utf8')).toMatch(/^# Moved to Enigma \(encrypted\) by `enigma import` on [^\n]+: IMP1, IMP2\n+$/);

    // --- import abort (the second name already exists): file untouched, nothing rendered
    writeFileSync(join(A!, 'import2.env'), 'IMP3=c\nIMP1=x\n');
    expect(await cmdImport(['import2.env', '--depository', 'encrypted'])).toBe(1);
    expect(readFileSync(join(A!, 'import2.env'), 'utf8')).toBe('IMP3=c\nIMP1=x\n');
    check('import abort', { A: `${EB}${EE}${RB}IMP1=a\nIMP2=b\n${RE}`, B: '', C: k1('c1'), ledger: [['C', ['K1']], ['A', ['IMP1', 'IMP2']]] });

    // --- the aborted import STORED IMP3 (loud abort keeps what succeeded) but rendered nothing: the plain render the abort
    // note asks for renders it, leaves K1 (keychain, never auto-rendered) out, and keeps the rest byte for byte
    at(A!);
    expect(await cmdRender([])).toBe(0);
    check('plain render from A', { A: `${EB}${EE}${RB}IMP1=a\nIMP2=b\nIMP3=c\n${RE}`, B: '', C: k1('c1'), ledger: [['C', ['K1']], ['A', ['IMP1', 'IMP2', 'IMP3']]] });

    // --- no value reached any surface other than the target files
    const surfaces = [
      [...stdout.mock.calls, ...stderr.mock.calls].map((c: unknown[]) => String(c[0])).join(''),
      readFileSync(auditLogPath(), 'utf8'),
      readFileSync(renderLedgerPath(), 'utf8'),
      readFileSync(indexPath(), 'utf8'),
    ];
    for (const s of surfaces) expect(s).not.toContain(SENTINEL);
  });
});
