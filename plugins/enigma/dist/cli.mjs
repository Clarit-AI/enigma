#!/usr/bin/env node

// src/cli/args.ts
var UsageError = class extends Error {
};
function parseArgs(argv, spec = {}) {
  const valueFlags = new Set(spec.value ?? []);
  const booleanFlags = new Set(spec.boolean ?? []);
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eqIdx = arg.indexOf("=");
    const rawName = eqIdx === -1 ? arg.slice(2) : arg.slice(2, eqIdx);
    if (valueFlags.has(rawName)) {
      if (eqIdx !== -1) {
        flags[rawName] = arg.slice(eqIdx + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next === void 0) throw new UsageError(`--${rawName} requires a value`);
      flags[rawName] = next;
      i++;
    } else if (booleanFlags.has(rawName)) {
      flags[rawName] = true;
    } else {
      throw new UsageError(`unknown option: --${rawName}`);
    }
  }
  return { positionals, flags };
}
function parseScope(raw) {
  if (raw === void 0) return void 0;
  if (raw !== "project" && raw !== "global") {
    throw new UsageError(`invalid --scope: ${String(raw)} (expected project or global)`);
  }
  return raw;
}
function parseScopeOrAll(raw) {
  if (raw === "all") return "all";
  return parseScope(raw);
}
function parseUsage(raw) {
  if (raw === void 0) return void 0;
  if (raw !== "interactive" && raw !== "unattended") {
    throw new UsageError(`invalid --usage: ${String(raw)} (expected interactive or unattended)`);
  }
  return raw;
}

// src/cli/prompt.ts
var ETX = "";
var BACKSPACE = "\x7F";
var CTRL_H = "\b";
async function readOneLine(stdin) {
  let buffered = "";
  const iterable = stdin;
  for await (const chunk of iterable) {
    buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const idx = buffered.indexOf("\n");
    if (idx !== -1) {
      const line = buffered.slice(0, idx);
      return line.endsWith("\r") ? line.slice(0, -1) : line;
    }
  }
  return buffered.endsWith("\r") ? buffered.slice(0, -1) : buffered;
}
async function readWithEchoDisabled(stdin, stderr) {
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode?.(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  try {
    return await new Promise((resolve2, reject) => {
      let value = "";
      const onData = (chunk) => {
        for (const ch of chunk) {
          if (ch === "\r" || ch === "\n") {
            stdin.removeListener("data", onData);
            resolve2(value);
            return;
          }
          if (ch === ETX) {
            stdin.removeListener("data", onData);
            reject(new Error("aborted"));
            return;
          }
          if (ch === BACKSPACE || ch === CTRL_H) {
            value = value.slice(0, -1);
            continue;
          }
          value += ch;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode?.(wasRaw);
    stdin.pause();
    stderr.write("\n");
  }
}
async function promptSecretValue(promptText, streams = {}) {
  const stdin = streams.stdin ?? process.stdin;
  const stderr = streams.stderr ?? process.stderr;
  if (!stdin.isTTY) {
    return readOneLine(stdin);
  }
  stderr.write(promptText);
  return readWithEchoDisabled(stdin, stderr);
}

// src/core/config.ts
import { existsSync, readFileSync } from "node:fs";

// src/core/paths.ts
import { homedir } from "node:os";
import { join } from "node:path";
function enigmaHome() {
  return process.env.ENIGMA_HOME || join(homedir(), ".config", "enigma");
}
function indexPath() {
  return join(enigmaHome(), "index.json");
}
function auditLogPath() {
  return join(enigmaHome(), "audit.log");
}
function configPath() {
  return join(enigmaHome(), "config.json");
}
function keyPath() {
  return join(enigmaHome(), "enigma.key");
}
function secretsPath() {
  return join(enigmaHome(), "secrets.enc");
}

// src/core/config.ts
var DEFAULT_CONFIG = {};
function readJsonIfExists(path) {
  if (!existsSync(path)) return void 0;
  return JSON.parse(readFileSync(path, "utf8"));
}
function loadConfig() {
  const raw = readJsonIfExists(configPath());
  if (!raw) return { ...DEFAULT_CONFIG };
  const config = {};
  if (typeof raw.defaultDepository === "string") config.defaultDepository = raw.defaultDepository;
  if (raw.remote === "cloudflared" || raw.remote === "tailscale") config.remote = raw.remote;
  if (raw.tripwire && typeof raw.tripwire === "object" && Array.isArray(raw.tripwire.depositories)) {
    config.tripwire = { depositories: raw.tripwire.depositories };
  }
  if (raw.ui === "web" || raw.ui === "native") config.ui = raw.ui;
  return config;
}

// src/core/errors.ts
var EnigmaError = class _EnigmaError extends Error {
  code;
  secretName;
  depository;
  constructor(options) {
    super(options.message);
    this.name = "EnigmaError";
    this.code = options.code;
    this.secretName = options.secretName;
    this.depository = options.depository;
    Object.setPrototypeOf(this, _EnigmaError.prototype);
  }
};

// src/core/naming.ts
var NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
function validateName(name) {
  if (!NAME_PATTERN.test(name)) {
    throw new EnigmaError({
      code: "E_NAME_INVALID",
      message: `invalid secret name: expected ${NAME_PATTERN}`,
      secretName: name
    });
  }
}

// src/core/project.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync2 } from "node:fs";
import { dirname, resolve } from "node:path";
var PROJECT_ID_LENGTH = 16;
function findProjectPath(cwd) {
  let dir = resolve(cwd);
  for (; ; ) {
    if (existsSync2(`${dir}/.git`)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}
function projectId(cwd) {
  const projectPath = findProjectPath(cwd);
  return createHash("sha256").update(projectPath).digest("hex").slice(0, PROJECT_ID_LENGTH);
}

// src/core/secure-file.ts
import { mkdirSync, appendFileSync, chmodSync, existsSync as existsSync3, readFileSync as readFileSync2, renameSync, writeFileSync } from "node:fs";
import { dirname as dirname2 } from "node:path";
import { randomBytes } from "node:crypto";
var FILE_MODE = 384;
var DIR_MODE = 448;
function ensureParentDir(path) {
  const dir = dirname2(path);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
}
function readJsonFile(path, fallback, corruptErrorCode) {
  if (!existsSync3(path)) return fallback;
  const raw = readFileSync2(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    if (!corruptErrorCode) throw err;
    throw new EnigmaError({ code: corruptErrorCode, message: `failed to parse ${path}: not valid JSON` });
  }
}
function writeJsonFileAtomic(path, data) {
  ensureParentDir(path);
  const tmpPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: FILE_MODE });
  chmodSync(tmpPath, FILE_MODE);
  renameSync(tmpPath, path);
}
function appendLineSecure(path, line) {
  ensureParentDir(path);
  appendFileSync(path, `${line}
`, { mode: FILE_MODE });
}

// src/core/audit.ts
function auditErrorText(err) {
  if (err instanceof EnigmaError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.constructor.name;
  return "UnknownError";
}
function appendAuditEvent(event) {
  const line = { ts: (/* @__PURE__ */ new Date()).toISOString(), ...event };
  appendLineSecure(auditLogPath(), JSON.stringify(line));
}

// src/core/index-store.ts
var EMPTY_INDEX = { version: 1, entries: [] };
function buildRef(name, scope, projectId2) {
  return scope === "global" ? `global/${name}` : `${projectId2}/${name}`;
}
function readIndex() {
  return readJsonFile(indexPath(), EMPTY_INDEX, "E_INDEX_CORRUPT");
}
function writeIndex(index) {
  writeJsonFileAtomic(indexPath(), index);
}
function sameEntry(entry, name, scope, projectId2) {
  if (entry.name !== name || entry.scope !== scope) return false;
  return scope === "global" ? true : entry.projectId === projectId2;
}
function findIndexEntry(index, name, scope, projectId2) {
  return index.entries.find((e) => sameEntry(e, name, scope, projectId2));
}
function resolveIndexEntry(index, name, scope, currentProjectId) {
  if (scope) return findIndexEntry(index, name, scope, currentProjectId);
  const projectEntry = currentProjectId ? findIndexEntry(index, name, "project", currentProjectId) : void 0;
  return projectEntry ?? findIndexEntry(index, name, "global");
}
function upsertIndexEntry(index, entry) {
  const others = index.entries.filter((e) => !sameEntry(e, entry.name, entry.scope, entry.projectId));
  return { ...index, entries: [...others, entry] };
}
function removeIndexEntry(index, name, scope, currentProjectId) {
  if (!scope) {
    const projectEntry = currentProjectId ? findIndexEntry(index, name, "project", currentProjectId) : void 0;
    const globalEntry = findIndexEntry(index, name, "global");
    if (projectEntry && globalEntry) {
      throw new EnigmaError({
        code: "E_AMBIGUOUS_SCOPE",
        message: `${name} exists in both project and global scope; specify --scope`,
        secretName: name
      });
    }
  }
  const removed = resolveIndexEntry(index, name, scope, currentProjectId);
  if (!removed) {
    throw new EnigmaError({ code: "E_NOT_FOUND", message: `${name} not found`, secretName: name });
  }
  const entries = index.entries.filter((e) => e !== removed);
  return { index: { ...index, entries }, removed };
}
function listIndexEntries(index, opts = {}) {
  const scope = opts.scope ?? "all";
  const entries = scope === "all" ? index.entries : index.entries.filter((e) => e.scope === scope);
  return entries.map((entry) => {
    if (entry.scope !== "global") return { ...entry };
    const shadowedBy = opts.currentProjectId ? findIndexEntry(index, entry.name, "project", opts.currentProjectId) : void 0;
    return { ...entry, shadowed: Boolean(shadowedBy) };
  });
}

// src/storage/depositories/encrypted.ts
import { createCipheriv, createDecipheriv, randomBytes as randomBytes2 } from "node:crypto";
import { existsSync as existsSync4, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
var ALGORITHM = "aes-256-gcm";
var KEY_BYTES = 32;
var IV_BYTES = 12;
var FILE_MODE2 = 384;
var EMPTY_SECRETS_FILE = { version: 1, entries: {} };
function readKey() {
  if (!existsSync4(keyPath())) return void 0;
  const key = Buffer.from(readFileSync3(keyPath(), "utf8"), "base64");
  if (key.length !== KEY_BYTES) readFailed();
  return key;
}
function getOrCreateKey() {
  const existing = readKey();
  if (existing) return existing;
  const key = randomBytes2(KEY_BYTES);
  writeFileSync2(keyPath(), key.toString("base64"), { mode: FILE_MODE2 });
  return key;
}
function readSecretsFile() {
  return readJsonFile(secretsPath(), EMPTY_SECRETS_FILE);
}
function writeSecretsFile(file) {
  writeJsonFileAtomic(secretsPath(), file);
}
function encryptValue(value, key) {
  const iv = randomBytes2(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("base64"), tag: tag.toString("base64"), ct: ct.toString("base64") };
}
function decryptEntry(entry, key) {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(entry.iv, "base64"));
  decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(entry.ct, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}
function readFailed() {
  throw new EnigmaError({
    code: "E_READ_FAILED",
    message: "failed to read secret from encrypted depository",
    depository: "encrypted"
  });
}
function createEncryptedDepository() {
  return {
    id: "encrypted",
    promptProfile: "none",
    async set(ref, value) {
      const key = getOrCreateKey();
      const file = readSecretsFile();
      file.entries[ref] = encryptValue(value, key);
      writeSecretsFile(file);
      return ref;
    },
    async resolve(ref) {
      const key = readKey();
      if (!key) readFailed();
      const file = readSecretsFile();
      const entry = file.entries[ref];
      if (!entry) throw new EnigmaError({ code: "E_NOT_FOUND", message: "secret not found", depository: "encrypted" });
      try {
        return decryptEntry(entry, key);
      } catch {
        return readFailed();
      }
    },
    async delete(ref) {
      const file = readSecretsFile();
      if (ref in file.entries) {
        delete file.entries[ref];
        writeSecretsFile(file);
      }
    },
    async has(ref) {
      return ref in readSecretsFile().entries;
    }
  };
}
var encryptedDepositoryModule = {
  id: "encrypted",
  promptProfile: "none",
  async detect() {
    return { id: "encrypted", promptProfile: "none", available: true };
  },
  create: createEncryptedDepository
};

// src/storage/depositories/env.ts
import { existsSync as existsSync5, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join2 } from "node:path";
var BEGIN_MARKER = "# enigma:begin";
var END_MARKER = "# enigma:end";
var FILE_MODE3 = 384;
var GITIGNORE_ENV_PATTERNS = /* @__PURE__ */ new Set([".env", ".env*", "*.env", "**/.env", ".env**"]);
var NEEDS_QUOTING = /[\s#"'\\$]/;
function detectEol(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}
function encodeValue(value) {
  if (!NEEDS_QUOTING.test(value)) return value;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  return `"${escaped}"`;
}
function decodeValue(raw) {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  return inner.replace(/\\\\|\\"|\\r|\\n/g, (escape) => {
    switch (escape) {
      case "\\\\":
        return "\\";
      case '\\"':
        return '"';
      case "\\r":
        return "\r";
      default:
        return "\n";
    }
  });
}
function findBlock(lines) {
  const beginIdx = lines.findIndex((l) => l === BEGIN_MARKER);
  if (beginIdx === -1) return void 0;
  const endIdx = lines.findIndex((l, i) => l === END_MARKER && i > beginIdx);
  if (endIdx === -1) return void 0;
  return { beginIdx, endIdx };
}
function upsertManagedBlock(content, name, value) {
  const eol = detectEol(content);
  const lines = content.length === 0 ? [] : content.split(eol);
  const block = findBlock(lines);
  const encoded = encodeValue(value);
  if (block) {
    const blockLines = lines.slice(block.beginIdx + 1, block.endIdx);
    const existingIdx = blockLines.findIndex((l) => l.startsWith(`${name}=`));
    if (existingIdx !== -1) {
      blockLines[existingIdx] = `${name}=${encoded}`;
    } else {
      blockLines.push(`${name}=${encoded}`);
    }
    const newLines = [...lines.slice(0, block.beginIdx + 1), ...blockLines, ...lines.slice(block.endIdx)];
    return newLines.join(eol);
  }
  const needsNewline = content.length > 0 && !content.endsWith(eol);
  const prefix = needsNewline ? content + eol : content;
  return `${prefix}${BEGIN_MARKER}${eol}${name}=${encoded}${eol}${END_MARKER}${eol}`;
}
function extractManagedValue(content, name) {
  const eol = detectEol(content);
  const lines = content.length === 0 ? [] : content.split(eol);
  const block = findBlock(lines);
  if (!block) return void 0;
  const match = lines.slice(block.beginIdx + 1, block.endIdx).find((l) => l.startsWith(`${name}=`));
  return match ? decodeValue(match.slice(name.length + 1)) : void 0;
}
function removeManagedValue(content, name) {
  const eol = detectEol(content);
  const lines = content.length === 0 ? [] : content.split(eol);
  const block = findBlock(lines);
  if (!block) return content;
  const blockLines = lines.slice(block.beginIdx + 1, block.endIdx).filter((l) => !l.startsWith(`${name}=`));
  const newLines = [...lines.slice(0, block.beginIdx + 1), ...blockLines, ...lines.slice(block.endIdx)];
  return newLines.join(eol);
}
function checkEnvGitignore(projectPath) {
  const gitignorePath = join2(projectPath, ".gitignore");
  if (!existsSync5(gitignorePath)) {
    return [".env is not gitignored: no .gitignore file found in this project"];
  }
  const lines = readFileSync4(gitignorePath, "utf8").split(/\r?\n/);
  const covered = lines.some((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return false;
    const normalized = line.replace(/^\//, "").replace(/\/$/, "");
    return GITIGNORE_ENV_PATTERNS.has(normalized);
  });
  return covered ? [] : [".env is not gitignored: add .env to .gitignore before committing"];
}
function requireProjectPath(ctx) {
  if (!ctx.projectPath) {
    throw new EnigmaError({
      code: "E_DEPOSITORY_UNAVAILABLE",
      message: "env depository requires a project path",
      depository: "env"
    });
  }
  return ctx.projectPath;
}
function createEnvDepository(ctx) {
  const envFilePath = join2(requireProjectPath(ctx), ".env");
  const readEnvFile = () => existsSync5(envFilePath) ? readFileSync4(envFilePath, "utf8") : "";
  return {
    id: "env",
    promptProfile: "none",
    // ref is the bare NAME for env — the file itself is located via DepositoryContext.projectPath.
    async set(ref, value) {
      writeFileSync3(envFilePath, upsertManagedBlock(readEnvFile(), ref, value), { mode: FILE_MODE3 });
      return ref;
    },
    async resolve(ref) {
      const value = extractManagedValue(readEnvFile(), ref);
      if (value === void 0) {
        throw new EnigmaError({ code: "E_NOT_FOUND", message: "secret not found", depository: "env" });
      }
      return value;
    },
    async delete(ref) {
      const content = readEnvFile();
      if (content) writeFileSync3(envFilePath, removeManagedValue(content, ref), { mode: FILE_MODE3 });
    },
    async has(ref) {
      return extractManagedValue(readEnvFile(), ref) !== void 0;
    }
  };
}
var envDepositoryModule = {
  id: "env",
  promptProfile: "none",
  async detect() {
    return { id: "env", promptProfile: "none", available: true };
  },
  create: createEnvDepository
};

// src/storage/detect.ts
var DEPOSITORY_MODULES = [encryptedDepositoryModule, envDepositoryModule];
async function detectAll() {
  return Promise.all(DEPOSITORY_MODULES.map((mod) => mod.detect()));
}

// src/storage/manager.ts
function getDepositoryModule(id) {
  const mod = DEPOSITORY_MODULES.find((m) => m.id === id);
  if (!mod) {
    throw new EnigmaError({
      code: "E_DEPOSITORY_UNAVAILABLE",
      message: `depository not available: ${id}`,
      depository: id
    });
  }
  return mod;
}
function createDepository(id, projectPath) {
  return getDepositoryModule(id).create({ projectPath });
}
function projectPathFor(entry, cwd) {
  if (entry.scope === "project") return entry.projectPath;
  return cwd ? findProjectPath(cwd) : void 0;
}
async function setSecret(opts) {
  validateName(opts.name);
  if (opts.depository === "env" && opts.scope === "global") {
    throw new EnigmaError({
      code: "E_SCOPE_INVALID",
      message: "env depository does not support global scope; a project .env file has no global location",
      secretName: opts.name
    });
  }
  const needsProjectPath = opts.scope === "project" || opts.depository === "env";
  const projectPath = needsProjectPath ? findProjectPath(opts.cwd ?? process.cwd()) : void 0;
  const pid = opts.scope === "project" ? projectId(opts.cwd ?? process.cwd()) : void 0;
  const index = readIndex();
  const existing = findIndexEntry(index, opts.name, opts.scope, pid);
  if (existing && !opts.rotate) {
    throw new EnigmaError({
      code: "E_EXISTS",
      message: `${opts.name} already exists in ${opts.scope} scope; pass rotate to overwrite`,
      secretName: opts.name
    });
  }
  const providedRef = opts.depository === "env" ? opts.name : buildRef(opts.name, opts.scope, pid);
  const depository = createDepository(opts.depository, opts.depository === "env" ? projectPath : void 0);
  const op = existing ? "rotated" : "set";
  let ref;
  try {
    ref = await depository.set(providedRef, opts.value);
  } catch (err) {
    appendAuditEvent({ op, name: opts.name, scope: opts.scope, depository: opts.depository, actor: opts.actor, ok: false, error: auditErrorText(err) });
    throw err;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const entry = {
    name: opts.name,
    scope: opts.scope,
    projectId: pid,
    projectPath: opts.scope === "project" ? projectPath : void 0,
    depository: opts.depository,
    ref,
    description: opts.description,
    usage: opts.usage,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  writeIndex(upsertIndexEntry(index, entry));
  appendAuditEvent({ op, name: opts.name, scope: opts.scope, depository: opts.depository, actor: opts.actor, ok: true, error: null });
  const warnings = opts.depository === "env" && projectPath ? checkEnvGitignore(projectPath) : [];
  return { rotated: Boolean(existing), warnings };
}
function listSecrets(opts = {}) {
  const index = readIndex();
  const currentProjectId = opts.cwd ? projectId(opts.cwd) : void 0;
  return listIndexEntries(index, { scope: opts.scope, currentProjectId });
}
async function deleteSecret(name, opts) {
  const pid = opts.cwd ? projectId(opts.cwd) : void 0;
  const index = readIndex();
  const { index: updated, removed } = removeIndexEntry(index, name, opts.scope, pid);
  const depository = createDepository(removed.depository, projectPathFor(removed, opts.cwd));
  try {
    await depository.delete(removed.ref);
  } catch (err) {
    appendAuditEvent({ op: "remove", name, scope: removed.scope, depository: removed.depository, actor: opts.actor, ok: false, error: auditErrorText(err) });
    throw err;
  }
  writeIndex(updated);
  appendAuditEvent({ op: "remove", name, scope: removed.scope, depository: removed.depository, actor: opts.actor, ok: true, error: null });
}
async function resolveSecret(name, opts) {
  const pid = opts.cwd ? projectId(opts.cwd) : void 0;
  const index = readIndex();
  const entry = resolveIndexEntry(index, name, opts.scope, pid);
  if (!entry) {
    throw new EnigmaError({ code: "E_NOT_FOUND", message: `${name} not found`, secretName: name });
  }
  const depository = createDepository(entry.depository, projectPathFor(entry, opts.cwd));
  try {
    const value = await depository.resolve(entry.ref);
    appendAuditEvent({ op: "read", name, scope: entry.scope, depository: entry.depository, actor: opts.actor, ok: true, error: null });
    return value;
  } catch (err) {
    appendAuditEvent({ op: "read", name, scope: entry.scope, depository: entry.depository, actor: opts.actor, ok: false, error: auditErrorText(err) });
    throw err;
  }
}

// src/cli/commands/add.ts
var USAGE = "enigma add NAME [--depository ID] [--scope project|global] [--description TEXT] [--usage interactive|unattended]";
async function cmdAdd(argv, streams = {}) {
  const { positionals, flags } = parseArgs(argv, { value: ["depository", "scope", "description", "usage"] });
  const [name] = positionals;
  if (!name) throw new UsageError(USAGE);
  const scope = parseScope(flags.scope) ?? "project";
  const depository = flags.depository ?? loadConfig().defaultDepository ?? "encrypted";
  const description = typeof flags.description === "string" ? flags.description : void 0;
  const usage = parseUsage(flags.usage);
  const value = await promptSecretValue(`Enter value for ${name}: `, streams);
  const result = await setSecret({
    name,
    value,
    scope,
    depository,
    cwd: process.cwd(),
    description,
    usage,
    actor: "cli"
  });
  process.stdout.write(`Stored ${name} in ${depository} (${scope})
`);
  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${warning}
`);
  }
  return 0;
}

// src/cli/commands/doctor.ts
import { execFile } from "node:child_process";
import { existsSync as existsSync6 } from "node:fs";
import { platform, release } from "node:os";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
async function opStatus() {
  try {
    const { stdout } = await execFileAsync("op", ["--version"], { timeout: 2e3, maxBuffer: 1024 });
    return { available: true, version: stdout.trim() || null };
  } catch {
    return { available: false, version: null };
  }
}
async function cmdDoctor(argv) {
  const { flags } = parseArgs(argv, { boolean: ["json"] });
  const json = Boolean(flags.json);
  const [depositoriesRaw, op] = await Promise.all([detectAll(), opStatus()]);
  const depositories = depositoriesRaw.map((d) => ({
    id: d.id,
    available: d.available,
    promptProfile: d.promptProfile,
    reason: d.reason ?? null
  }));
  let index;
  try {
    index = { ok: true, entries: readIndex().entries.length };
  } catch (err) {
    index = { ok: false, error: err instanceof EnigmaError ? err.code : "unknown error" };
  }
  const vault = {
    keyPresent: existsSync6(keyPath()),
    secretsFilePresent: existsSync6(secretsPath())
  };
  const report = {
    platform: `${platform()} ${release()}`,
    depositories,
    op,
    config: {
      home: enigmaHome(),
      indexPath: indexPath(),
      auditLogPath: auditLogPath(),
      configPath: configPath(),
      keyPath: keyPath(),
      secretsPath: secretsPath()
    },
    index,
    vault
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}
`);
    return 0;
  }
  const lines = [
    `Platform: ${report.platform}`,
    "Depositories:",
    ...depositories.map(
      (d) => `  ${d.id}: ${d.available ? "available" : "unavailable"} (prompt profile: ${d.promptProfile}${d.reason ? `, ${d.reason}` : ""})`
    ),
    `1Password CLI (op): ${op.available ? `available (${op.version ?? "unknown version"})` : "not found"}`,
    `Config home: ${report.config.home}`,
    `Index: ${index.ok ? `ok (${index.entries} entries)` : `ERROR: ${index.error}`}`,
    `Vault key: ${vault.keyPresent ? "present" : "missing"}`,
    `Vault file: ${vault.secretsFilePresent ? "present" : "missing"}`
  ];
  process.stdout.write(`${lines.join("\n")}
`);
  return 0;
}

// src/cli/commands/get.ts
var USAGE2 = "enigma get NAME [--scope project|global]";
async function cmdGet(argv) {
  const { positionals, flags } = parseArgs(argv, { value: ["scope"] });
  const [name] = positionals;
  if (!name) throw new UsageError(USAGE2);
  const scope = parseScope(flags.scope);
  process.stderr.write(
    `warning: printing ${name} to stdout; prefer 'enigma run -- <cmd>' so the value never lands in your shell history or terminal scrollback
`
  );
  const value = await resolveSecret(name, { scope, cwd: process.cwd(), actor: "cli" });
  process.stdout.write(`${value}
`);
  return 0;
}

// src/cli/commands/list.ts
function promptProfileFor(depository) {
  return DEPOSITORY_MODULES.find((m) => m.id === depository)?.promptProfile ?? "unknown";
}
async function cmdList(argv) {
  const { flags } = parseArgs(argv, { value: ["scope"], boolean: ["json"] });
  const scope = parseScopeOrAll(flags.scope) ?? "all";
  const json = Boolean(flags.json);
  const entries = listSecrets({ scope, cwd: process.cwd() });
  if (json) {
    process.stdout.write(`${JSON.stringify({ entries })}
`);
    return 0;
  }
  if (entries.length === 0) {
    process.stdout.write("No secrets found.\n");
    return 0;
  }
  const rows = entries.map((e) => ({
    name: e.name,
    scope: e.scope,
    depository: e.depository,
    promptProfile: promptProfileFor(e.depository),
    usage: e.usage ?? "",
    updatedAt: e.updatedAt,
    shadowed: e.shadowed ? "yes" : ""
  }));
  const headers = ["NAME", "SCOPE", "DEPOSITORY", "PROMPT PROFILE", "USAGE", "UPDATED", "SHADOWED"];
  const columns = [headers, ...rows.map((r) => [r.name, r.scope, r.depository, r.promptProfile, r.usage, r.updatedAt, r.shadowed])];
  const widths = headers.map((_, i) => Math.max(...columns.map((row) => row[i].length)));
  const lines = columns.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd());
  process.stdout.write(`${lines.join("\n")}
`);
  return 0;
}

// src/cli/commands/move.ts
var USAGE3 = "enigma move NAME --to ID [--scope project|global]";
async function cmdMove(argv) {
  const { positionals, flags } = parseArgs(argv, { value: ["to", "scope"] });
  const [name] = positionals;
  const to = flags.to;
  if (!name || typeof to !== "string") throw new UsageError(USAGE3);
  const target = to;
  const scopeFlag = parseScope(flags.scope);
  const cwd = process.cwd();
  const pid = projectId(cwd);
  const entry = resolveIndexEntry(readIndex(), name, scopeFlag, pid);
  if (!entry) {
    throw new EnigmaError({ code: "E_NOT_FOUND", message: `${name} not found`, secretName: name });
  }
  if (entry.depository === target) {
    process.stdout.write(`${name} is already in ${target}
`);
    return 0;
  }
  try {
    const value = await resolveSecret(name, { scope: entry.scope, cwd, actor: "cli" });
    await setSecret({
      name,
      value,
      scope: entry.scope,
      depository: target,
      cwd,
      description: entry.description,
      usage: entry.usage,
      rotate: true,
      actor: "cli"
    });
  } catch (err) {
    appendAuditEvent({ op: "move", name, scope: entry.scope, depository: target, actor: "cli", ok: false, error: auditErrorText(err) });
    throw err;
  }
  const oldModule = DEPOSITORY_MODULES.find((m) => m.id === entry.depository);
  if (oldModule) {
    const projectPath = entry.scope === "project" ? entry.projectPath : void 0;
    await oldModule.create({ projectPath }).delete(entry.ref).catch(() => void 0);
  }
  appendAuditEvent({ op: "move", name, scope: entry.scope, depository: target, actor: "cli", ok: true, error: null });
  process.stdout.write(`Moved ${name} to ${target} (${entry.scope})
`);
  return 0;
}

// src/cli/commands/remove.ts
var USAGE4 = "enigma remove NAME [--scope project|global]";
async function cmdRemove(argv) {
  const { positionals, flags } = parseArgs(argv, { value: ["scope"] });
  const [name] = positionals;
  if (!name) throw new UsageError(USAGE4);
  const scope = parseScope(flags.scope);
  await deleteSecret(name, { scope, cwd: process.cwd(), actor: "cli" });
  process.stdout.write(`Removed ${name}${scope ? ` (${scope})` : ""}
`);
  return 0;
}

// src/cli/commands/run.ts
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
var USAGE5 = "enigma run [--only A,B] [--scope project|global] -- <command> [args...]";
var FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
function entriesToInject(entries, only) {
  const visible = only ? entries : entries.filter((e) => !e.shadowed);
  if (!only) return visible;
  const wanted = new Set(only);
  const matched = visible.filter((e) => wanted.has(e.name));
  const missing = only.filter((name) => !matched.some((e) => e.name === name));
  if (missing.length > 0) {
    throw new EnigmaError({ code: "E_NOT_FOUND", message: `not found: ${missing.join(", ")}`, secretName: missing[0] });
  }
  return matched;
}
function spawnChild(command, args, env) {
  return new Promise((resolve2, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    const forward = (signal) => {
      child.kill(signal);
    };
    for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
    const stopForwarding = () => {
      for (const signal of FORWARDED_SIGNALS) process.removeListener(signal, forward);
    };
    child.on("error", (err) => {
      stopForwarding();
      reject(err);
    });
    child.on("exit", (code, signal) => {
      stopForwarding();
      if (signal) {
        const signum = osConstants.signals[signal] ?? 0;
        resolve2(128 + signum);
        return;
      }
      resolve2(code ?? 1);
    });
  });
}
async function cmdRun(argv) {
  const dashIdx = argv.indexOf("--");
  if (dashIdx === -1) throw new UsageError(USAGE5);
  const commandArgv = argv.slice(dashIdx + 1);
  if (commandArgv.length === 0) throw new UsageError(USAGE5);
  const { flags } = parseArgs(argv.slice(0, dashIdx), { value: ["only", "scope"] });
  const scope = parseScope(flags.scope) ?? "all";
  const only = typeof flags.only === "string" ? flags.only.split(",").map((n) => n.trim()).filter((n) => n.length > 0) : void 0;
  const cwd = process.cwd();
  const entries = entriesToInject(listSecrets({ scope, cwd }), only);
  const childEnv = { ...process.env };
  for (const entry of entries) {
    childEnv[entry.name] = await resolveSecret(entry.name, { scope: entry.scope, cwd, actor: "cli" });
  }
  const [command, ...commandArgs] = commandArgv;
  return spawnChild(command, commandArgs, childEnv);
}

// src/cli/commands/not-implemented.ts
function notImplemented(command) {
  return async () => {
    process.stderr.write(`enigma ${command}: not yet implemented
`);
    return 2;
  };
}

// src/cli/index.ts
var USAGE6 = `Usage: enigma <command> [options]

Commands:
  add NAME [--depository ID] [--scope project|global] [--description TEXT] [--usage interactive|unattended]
  list [--scope project|global|all] [--json]
  remove NAME [--scope project|global]
  move NAME --to ID [--scope project|global]
  run [--only A,B] [--scope project|global] -- <command> [args...]
  get NAME [--scope project|global]
  doctor [--json]

Not yet implemented: request, reveal, import, install
`;
var COMMANDS = {
  add: cmdAdd,
  list: cmdList,
  remove: cmdRemove,
  move: cmdMove,
  run: cmdRun,
  get: cmdGet,
  doctor: cmdDoctor,
  request: notImplemented("request"),
  reveal: notImplemented("reveal"),
  import: notImplemented("import"),
  install: notImplemented("install")
};
async function main(argv) {
  const [command, ...rest] = argv;
  if (!command) {
    process.stderr.write(USAGE6);
    return 2;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`enigma: unknown command '${command}'
${USAGE6}`);
    return 2;
  }
  try {
    return await handler(rest);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}
`);
      return 2;
    }
    if (err instanceof EnigmaError) {
      process.stderr.write(`${err.code}: ${err.message}
`);
      return 1;
    }
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}
`);
    return 1;
  }
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
export {
  main
};
