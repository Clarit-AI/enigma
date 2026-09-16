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

// src/cli/prompt.ts
var ETX = "";
var BACKSPACE = "\x7F";
var CTRL_H = "\b";
var RAW_MODE_SIGNALS = ["SIGINT", "SIGTERM"];
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
  const restoreTerminal = () => {
    stdin.setRawMode?.(wasRaw);
    stdin.pause();
  };
  let handleSignal;
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
      handleSignal = (signal) => {
        stdin.removeListener("data", onData);
        for (const s of RAW_MODE_SIGNALS) process.removeListener(s, handleSignal);
        restoreTerminal();
        process.kill(process.pid, signal);
      };
      for (const signal of RAW_MODE_SIGNALS) process.on(signal, handleSignal);
    });
  } finally {
    if (handleSignal) {
      for (const signal of RAW_MODE_SIGNALS) process.removeListener(signal, handleSignal);
    }
    restoreTerminal();
    stderr.write("\n");
  }
}
async function promptSecretValue(promptText, streams = {}) {
  const stdin = streams.stdin ?? process.stdin;
  const stderr = streams.stderr ?? process.stderr;
  if (!stdin.isTTY) {
    return readOneLine(stdin);
  }
  if (typeof stdin.setRawMode !== "function") {
    throw new EnigmaError({
      code: "E_NO_TTY_CONTROL",
      message: "cannot disable terminal echo on this TTY: setRawMode is unavailable"
    });
  }
  stderr.write(promptText);
  return readWithEchoDisabled(stdin, stderr);
}

// src/core/config.ts
import { existsSync, readFileSync } from "node:fs";
import { join as join2 } from "node:path";

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
var DEFAULT_MANIFEST = { secrets: {} };
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
function loadProjectManifest(projectPath) {
  const raw = readJsonIfExists(join2(projectPath, ".enigma.json"));
  if (!raw) return { ...DEFAULT_MANIFEST, secrets: {} };
  const manifest = { secrets: {} };
  if (typeof raw.defaultDepository === "string") manifest.defaultDepository = raw.defaultDepository;
  if (raw.secrets && typeof raw.secrets === "object") {
    for (const [name, description] of Object.entries(raw.secrets)) {
      if (typeof description === "string") manifest.secrets[name] = description;
    }
  }
  return manifest;
}

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
import { join as join3 } from "node:path";
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
  const gitignorePath = join3(projectPath, ".gitignore");
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
  const envFilePath = join3(requireProjectPath(ctx), ".env");
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

// src/storage/depositories/linux-secret-service.ts
import { execFile } from "node:child_process";
var SECRET_TOOL_BIN = "secret-tool";
var SERVICE = "enigma";
var EXEC_TIMEOUT_MS = 1e4;
var EXEC_MAX_BUFFER_BYTES = 1024 * 1024;
var PROBE_REF = "__enigma_detect_probe__";
var REF_PATTERN = /^[A-Za-z0-9_./-]+$/;
var REF_MAX_LENGTH = 512;
function runSecretTool(args) {
  return new Promise((resolve2, reject) => {
    execFile(SECRET_TOOL_BIN, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        return;
      }
      resolve2({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}
function runSecretToolWithStdin(args, value) {
  return new Promise((resolve2, reject) => {
    const child = execFile(SECRET_TOOL_BIN, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        return;
      }
      resolve2({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    child.on("error", reject);
    if (!child.stdin) {
      child.kill();
      reject(new Error("secret-tool: stdin unavailable"));
      return;
    }
    child.stdin.on("error", reject);
    if (child.stdin.write(value)) {
      child.stdin.end();
    } else {
      child.stdin.once("drain", () => child.stdin?.end());
    }
  });
}
function looksLikeNoResults(failure) {
  return (failure.stdout ?? "").trim() === "" && (failure.stderr ?? "").trim() === "" && typeof failure.code !== "undefined";
}
function classifyUnavailable(failure) {
  if (failure.code === "ENOENT") return "secret-tool not installed";
  const stderr = failure.stderr ?? "";
  if (stderr.includes("Object does not exist at path") || stderr.includes("/org/freedesktop/secrets/collection/login")) {
    return "Secret Service default collection is missing";
  }
  if (stderr.includes("Cannot autolaunch D-Bus without X11 $DISPLAY") || stderr.includes("Failed to execute child process") || stderr.toLowerCase().includes("dbus")) {
    return "no D-Bus session bus available (headless environment)";
  }
  return "secret-tool probe failed";
}
function readFailed2() {
  throw new EnigmaError({
    code: "E_READ_FAILED",
    message: "failed to read secret from secret-service depository",
    depository: "secret-service"
  });
}
function writeFailed() {
  throw new EnigmaError({
    code: "E_WRITE_FAILED",
    message: "failed to write secret to secret-service depository",
    depository: "secret-service"
  });
}
function notFound() {
  throw new EnigmaError({ code: "E_NOT_FOUND", message: "secret not found", depository: "secret-service" });
}
function refInvalid() {
  throw new EnigmaError({
    code: "E_REF_INVALID",
    message: `invalid depository ref: expected ${REF_PATTERN} and at most ${REF_MAX_LENGTH} characters`,
    depository: "secret-service"
  });
}
function validateRef(ref) {
  if (ref.length === 0 || ref.length > REF_MAX_LENGTH || !REF_PATTERN.test(ref)) {
    refInvalid();
  }
}
function createSecretServiceDepository() {
  return {
    id: "secret-service",
    promptProfile: "may-prompt",
    async set(ref, value) {
      validateRef(ref);
      try {
        await runSecretToolWithStdin(["store", `--label=enigma ${ref}`, "service", SERVICE, "ref", ref], value);
      } catch {
        writeFailed();
      }
      return ref;
    },
    async resolve(ref) {
      validateRef(ref);
      try {
        const { stdout } = await runSecretTool(["lookup", "service", SERVICE, "ref", ref]);
        return stdout.replace(/\n$/, "");
      } catch (err) {
        const failure = err;
        if (looksLikeNoResults(failure)) notFound();
        return readFailed2();
      }
    },
    async delete(ref) {
      validateRef(ref);
      try {
        await runSecretTool(["clear", "service", SERVICE, "ref", ref]);
      } catch {
      }
    },
    async has(ref) {
      validateRef(ref);
      try {
        await runSecretTool(["lookup", "service", SERVICE, "ref", ref]);
        return true;
      } catch {
        return false;
      }
    }
  };
}
async function probeWritable() {
  let storeError;
  try {
    await runSecretToolWithStdin(["store", "--label=enigma detect probe", "service", SERVICE, "ref", PROBE_REF], "probe");
  } catch (err) {
    storeError = err;
  } finally {
    try {
      await runSecretTool(["clear", "service", SERVICE, "ref", PROBE_REF]);
    } catch {
    }
  }
  if (storeError) {
    return { available: false, reason: classifyUnavailable(storeError) };
  }
  return { available: true };
}
var linuxSecretServiceDepositoryModule = {
  id: "secret-service",
  promptProfile: "may-prompt",
  async detect() {
    if (process.platform !== "linux") {
      return { id: "secret-service", promptProfile: "may-prompt", available: false, reason: "not running on Linux" };
    }
    const probe = await probeWritable();
    return probe.available ? { id: "secret-service", promptProfile: "may-prompt", available: true } : { id: "secret-service", promptProfile: "may-prompt", available: false, reason: probe.reason };
  },
  create: createSecretServiceDepository
};

// src/storage/depositories/macos-keychain.ts
import { execFile as execFile2 } from "node:child_process";
import { existsSync as existsSync6 } from "node:fs";
var SECURITY_BIN = "/usr/bin/security";
var SERVICE2 = "enigma";
var EXEC_TIMEOUT_MS2 = 1e4;
var EXEC_MAX_BUFFER_BYTES2 = 1024 * 1024;
var NOT_FOUND_PATTERN = /could not be found/i;
var ERR_SEC_ITEM_NOT_FOUND = 44;
var BATCH_LINE_MAX_BYTES = 4096;
var REF_PATTERN2 = /^[A-Za-z0-9_./-]+$/;
var REF_MAX_LENGTH2 = 512;
var MARKER_BYTE = 1;
function runSecurity(args) {
  return new Promise((resolve2, reject) => {
    execFile2(SECURITY_BIN, args, { timeout: EXEC_TIMEOUT_MS2, maxBuffer: EXEC_MAX_BUFFER_BYTES2 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        return;
      }
      resolve2({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}
function runSecurityBatch(line) {
  return new Promise((resolve2, reject) => {
    const child = execFile2(SECURITY_BIN, ["-i"], { timeout: EXEC_TIMEOUT_MS2, maxBuffer: EXEC_MAX_BUFFER_BYTES2 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        return;
      }
      resolve2({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    child.on("error", reject);
    if (!child.stdin) {
      child.kill();
      reject(new Error("security -i: stdin unavailable"));
      return;
    }
    child.stdin.on("error", reject);
    if (child.stdin.write(`${line}
`)) {
      child.stdin.end();
    } else {
      child.stdin.once("drain", () => child.stdin?.end());
    }
  });
}
function encodeSecretHex(value) {
  return Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([MARKER_BYTE])]).toString("hex");
}
function decodeSecretOutput(stdout) {
  const trimmed = stdout.replace(/\n$/, "");
  if (/^[0-9a-fA-F]*$/.test(trimmed) && trimmed.length % 2 === 0 && trimmed.length > 0) {
    const bytes = Buffer.from(trimmed, "hex");
    if (bytes[bytes.length - 1] === MARKER_BYTE) {
      return bytes.subarray(0, bytes.length - 1).toString("utf8");
    }
  }
  return readFailed3();
}
function batchLineOverheadBytes(ref) {
  return Buffer.byteLength(`add-generic-password -a ${ref} -s ${SERVICE2} -X  -U
`, "utf8");
}
function maxValueBytes(ref) {
  const hexBudget = BATCH_LINE_MAX_BYTES - batchLineOverheadBytes(ref);
  return Math.floor(hexBudget / 2) - 1;
}
function readFailed3() {
  throw new EnigmaError({
    code: "E_READ_FAILED",
    message: "failed to read secret from keychain depository",
    depository: "keychain"
  });
}
function writeFailed2() {
  throw new EnigmaError({
    code: "E_WRITE_FAILED",
    message: "failed to write secret to keychain depository",
    depository: "keychain"
  });
}
function notFound2() {
  throw new EnigmaError({ code: "E_NOT_FOUND", message: "secret not found", depository: "keychain" });
}
function refInvalid2() {
  throw new EnigmaError({
    code: "E_REF_INVALID",
    message: `invalid depository ref: expected ${REF_PATTERN2} and at most ${REF_MAX_LENGTH2} characters`,
    depository: "keychain"
  });
}
function valueTooLarge(limitBytes) {
  throw new EnigmaError({
    code: "E_VALUE_TOO_LARGE",
    message: `value exceeds the keychain depository's ${limitBytes}-byte limit; use the "encrypted" depository for large material such as PEM keys`,
    depository: "keychain"
  });
}
function validateRef2(ref) {
  if (ref.length === 0 || ref.length > REF_MAX_LENGTH2 || !REF_PATTERN2.test(ref)) {
    refInvalid2();
  }
}
function isItemNotFound(failure) {
  return failure.code === ERR_SEC_ITEM_NOT_FOUND || NOT_FOUND_PATTERN.test(failure.stderr ?? "") || NOT_FOUND_PATTERN.test(failure.message ?? "");
}
function createKeychainDepository() {
  return {
    id: "keychain",
    promptProfile: "may-prompt",
    async set(ref, value) {
      validateRef2(ref);
      const limit = maxValueBytes(ref);
      if (Buffer.byteLength(value, "utf8") > limit) {
        valueTooLarge(limit);
      }
      const hex = encodeSecretHex(value);
      try {
        await runSecurityBatch(`add-generic-password -a ${ref} -s ${SERVICE2} -X ${hex} -U`);
      } catch {
        writeFailed2();
      }
      return ref;
    },
    async resolve(ref) {
      validateRef2(ref);
      try {
        const { stdout } = await runSecurity(["find-generic-password", "-a", ref, "-s", SERVICE2, "-w"]);
        return decodeSecretOutput(stdout);
      } catch (err) {
        const failure = err;
        if (isItemNotFound(failure)) {
          notFound2();
        }
        return readFailed3();
      }
    },
    async delete(ref) {
      validateRef2(ref);
      try {
        await runSecurity(["delete-generic-password", "-a", ref, "-s", SERVICE2]);
      } catch (err) {
        const failure = err;
        if (isItemNotFound(failure)) {
          return;
        }
        readFailed3();
      }
    },
    async has(ref) {
      validateRef2(ref);
      try {
        await runSecurity(["find-generic-password", "-a", ref, "-s", SERVICE2]);
        return true;
      } catch {
        return false;
      }
    }
  };
}
var macosKeychainDepositoryModule = {
  id: "keychain",
  promptProfile: "may-prompt",
  async detect() {
    if (process.platform !== "darwin") {
      return { id: "keychain", promptProfile: "may-prompt", available: false, reason: "not running on macOS" };
    }
    const available = existsSync6(SECURITY_BIN);
    return {
      id: "keychain",
      promptProfile: "may-prompt",
      available,
      reason: available ? void 0 : `${SECURITY_BIN} not found`
    };
  },
  create: createKeychainDepository
};

// src/storage/depositories/onepassword.ts
import { execFile as execFile3 } from "node:child_process";
import { basename } from "node:path";
var OP_BIN = "op";
var VAULT = "Enigma";
var MIN_MAJOR_VERSION = 2;
var EXEC_TIMEOUT_MS3 = 15e3;
var EXEC_MAX_BUFFER_BYTES3 = 1024 * 1024;
var REF_PATTERN3 = /^[A-Za-z0-9_./-]+$/;
var REF_MAX_LENGTH3 = 512;
var VAULT_MISSING_PATTERN = /isn't a vault|no vault named|could not find vault/i;
var ITEM_MISSING_PATTERN = /isn't an item|could not find item|item.*not found/i;
function runOp(args) {
  return new Promise((resolve2, reject) => {
    execFile3(OP_BIN, args, { timeout: EXEC_TIMEOUT_MS3, maxBuffer: EXEC_MAX_BUFFER_BYTES3 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        return;
      }
      resolve2({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}
function runOpWithStdin(args, stdinData) {
  return new Promise((resolve2, reject) => {
    const child = execFile3(OP_BIN, args, { timeout: EXEC_TIMEOUT_MS3, maxBuffer: EXEC_MAX_BUFFER_BYTES3 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        return;
      }
      resolve2({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    child.on("error", reject);
    if (!child.stdin) {
      child.kill();
      reject(new Error("op: stdin unavailable"));
      return;
    }
    child.stdin.on("error", reject);
    if (child.stdin.write(stdinData)) {
      child.stdin.end();
    } else {
      child.stdin.once("drain", () => child.stdin?.end());
    }
  });
}
function isTimeout(failure) {
  return failure.killed === true || failure.signal != null;
}
function refInvalid3() {
  throw new EnigmaError({
    code: "E_REF_INVALID",
    message: `invalid depository ref: expected ${REF_PATTERN3} and at most ${REF_MAX_LENGTH3} characters`,
    depository: "1password"
  });
}
function validateRef3(ref) {
  if (ref.length === 0 || ref.length > REF_MAX_LENGTH3 || !REF_PATTERN3.test(ref)) {
    refInvalid3();
  }
}
function writeFailed3(reason) {
  throw new EnigmaError({
    code: "E_WRITE_FAILED",
    message: reason ?? "failed to write secret to 1password depository",
    depository: "1password"
  });
}
function readFailed4(reason) {
  throw new EnigmaError({
    code: "E_READ_FAILED",
    message: reason ?? "failed to read secret from 1password depository",
    depository: "1password"
  });
}
function notFound3() {
  throw new EnigmaError({ code: "E_NOT_FOUND", message: "secret not found", depository: "1password" });
}
function vaultMissing() {
  throw new EnigmaError({
    code: "E_VAULT_MISSING",
    message: `the "${VAULT}" vault does not exist in 1Password; pass createVault to create it`,
    depository: "1password"
  });
}
function timedOut(op) {
  const message = `1password depository timed out waiting for the op CLI after ${EXEC_TIMEOUT_MS3}ms; run "op signin" or unlock 1Password and try again`;
  if (op === "read") readFailed4(message);
  writeFailed3(message);
}
function nameFromRef(ref) {
  const idx = ref.lastIndexOf("/");
  return idx === -1 ? ref : ref.slice(idx + 1);
}
function buildTitle(ref, ctx) {
  const name = nameFromRef(ref);
  const isGlobal = ref === name || ref.startsWith("global/");
  if (isGlobal || !ctx.projectPath) return name;
  return `${name} \xB7 ${basename(ctx.projectPath)}`;
}
function itemTemplate(title, value) {
  return JSON.stringify({
    title,
    category: "API_CREDENTIAL",
    fields: [{ id: "credential", type: "CONCEALED", label: "credential", value }]
  });
}
async function createVault() {
  try {
    await runOp(["vault", "create", VAULT, "--format", "json"]);
  } catch (err) {
    const failure = err;
    if (isTimeout(failure)) timedOut("write");
    writeFailed3(`failed to create the "${VAULT}" vault in 1Password`);
  }
}
async function createItem(title, value) {
  const { stdout } = await runOpWithStdin(["item", "create", "--vault", VAULT, "--format", "json", "-"], itemTemplate(title, value));
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return writeFailed3("op item create returned a response that could not be parsed");
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    return writeFailed3("op item create did not return an item id");
  }
  return parsed.id;
}
function createOnepasswordDepository(ctx) {
  return {
    id: "1password",
    promptProfile: "prompts-each-read",
    async set(ref, value) {
      validateRef3(ref);
      const title = buildTitle(ref, ctx);
      try {
        return await createItem(title, value);
      } catch (err) {
        const failure = err;
        if (isTimeout(failure)) timedOut("write");
        if (VAULT_MISSING_PATTERN.test(failure.stderr ?? "")) {
          if (!ctx.createVault) vaultMissing();
          await createVault();
          try {
            return await createItem(title, value);
          } catch (retryErr) {
            const retryFailure = retryErr;
            if (isTimeout(retryFailure)) timedOut("write");
            return writeFailed3();
          }
        }
        return writeFailed3();
      }
    },
    async resolve(ref) {
      validateRef3(ref);
      try {
        const { stdout } = await runOp(["read", `op://${VAULT}/${ref}/credential`]);
        return stdout.replace(/\n$/, "");
      } catch (err) {
        const failure = err;
        if (isTimeout(failure)) timedOut("read");
        if (ITEM_MISSING_PATTERN.test(failure.stderr ?? "")) notFound3();
        return readFailed4();
      }
    },
    async delete(ref) {
      validateRef3(ref);
      try {
        await runOp(["item", "delete", ref, "--vault", VAULT]);
      } catch (err) {
        const failure = err;
        if (isTimeout(failure)) timedOut("read");
        if (ITEM_MISSING_PATTERN.test(failure.stderr ?? "")) return;
        readFailed4();
      }
    },
    async has(ref) {
      validateRef3(ref);
      try {
        await runOp(["item", "get", ref, "--vault", VAULT]);
        return true;
      } catch {
        return false;
      }
    }
  };
}
function parseMajorVersion(stdout) {
  const match = /^(\d+)\./.exec(stdout.trim());
  return match ? Number(match[1]) : void 0;
}
var onepasswordDepositoryModule = {
  id: "1password",
  promptProfile: "prompts-each-read",
  /**
   * Available only when `op --version` is 2.x+ and `op whoami` succeeds —
   * both fail fast and never prompt. Vault existence is deliberately not
   * checked here (that's a `set`-time concern, AC2) since any vault-touching
   * `op` subcommand risks the ~60s authorization-timeout hang this module
   * otherwise avoids.
   */
  async detect() {
    let versionOut;
    try {
      versionOut = (await runOp(["--version"])).stdout;
    } catch (err) {
      const failure = err;
      const reason = failure.code === "ENOENT" ? "op CLI not installed" : "op --version failed";
      return { id: "1password", promptProfile: "prompts-each-read", available: false, reason };
    }
    const major = parseMajorVersion(versionOut);
    if (major === void 0 || major < MIN_MAJOR_VERSION) {
      return {
        id: "1password",
        promptProfile: "prompts-each-read",
        available: false,
        reason: `op CLI version ${versionOut.trim() || "unknown"} is older than the required ${MIN_MAJOR_VERSION}.x`
      };
    }
    try {
      await runOp(["whoami"]);
    } catch {
      return {
        id: "1password",
        promptProfile: "prompts-each-read",
        available: false,
        reason: "op CLI is not signed in (run `op signin`)"
      };
    }
    return { id: "1password", promptProfile: "prompts-each-read", available: true };
  },
  create: createOnepasswordDepository
};

// src/storage/detect.ts
var DEPOSITORY_MODULES = [
  encryptedDepositoryModule,
  envDepositoryModule,
  macosKeychainDepositoryModule,
  linuxSecretServiceDepositoryModule,
  onepasswordDepositoryModule
];
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
function createDepository(id, ctx = {}) {
  return getDepositoryModule(id).create(ctx);
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
  const depository = createDepository(opts.depository, { projectPath, createVault: opts.createVault });
  const op = opts.auditOp ?? (existing ? "rotated" : "set");
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
  const depository = createDepository(removed.depository, { projectPath: projectPathFor(removed, opts.cwd) });
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
  const op = opts.auditOp ?? "read";
  const depository = createDepository(entry.depository, { projectPath: projectPathFor(entry, opts.cwd) });
  try {
    const value = await depository.resolve(entry.ref);
    appendAuditEvent({ op, name, scope: entry.scope, depository: entry.depository, actor: opts.actor, ok: true, error: null });
    return value;
  } catch (err) {
    appendAuditEvent({ op, name, scope: entry.scope, depository: entry.depository, actor: opts.actor, ok: false, error: auditErrorText(err) });
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
import { execFile as execFile4 } from "node:child_process";
import { existsSync as existsSync7 } from "node:fs";
import { platform, release } from "node:os";
import { promisify } from "node:util";

// src/core/manifest-gaps.ts
function computeManifestGaps(cwd) {
  const projectPath = findProjectPath(cwd);
  const pid = projectId(cwd);
  const entries = listSecrets({ scope: "all", cwd: projectPath }).filter(
    (e) => e.scope === "global" || e.projectId === pid
  );
  const registeredNames = [...new Set(entries.map((e) => e.name))].sort();
  const manifest = loadProjectManifest(projectPath);
  const known = new Set(registeredNames);
  const gaps = Object.keys(manifest.secrets).filter((name) => !known.has(name)).sort();
  return { registeredNames, gaps };
}

// src/cli/commands/doctor.ts
var execFileAsync = promisify(execFile4);
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
    keyPresent: existsSync7(keyPath()),
    secretsFilePresent: existsSync7(secretsPath())
  };
  const { gaps: manifestGaps } = computeManifestGaps(process.cwd());
  const report2 = {
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
    vault,
    manifestGaps
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(report2)}
`);
    return 0;
  }
  const lines = [
    `Platform: ${report2.platform}`,
    "Depositories:",
    ...depositories.map(
      (d) => `  ${d.id}: ${d.available ? "available" : "unavailable"} (prompt profile: ${d.promptProfile}${d.reason ? `, ${d.reason}` : ""})`
    ),
    `1Password CLI (op): ${op.available ? `available (${op.version ?? "unknown version"})` : "not found"}`,
    `Config home: ${report2.config.home}`,
    `Index: ${index.ok ? `ok (${index.entries} entries)` : `ERROR: ${index.error}`}`,
    `Vault key: ${vault.keyPresent ? "present" : "missing"}`,
    `Vault file: ${vault.secretsFilePresent ? "present" : "missing"}`,
    `Manifest gaps: ${manifestGaps.length === 0 ? "none" : manifestGaps.join(", ")}`
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

// src/cli/commands/import.ts
import { existsSync as existsSync9, readFileSync as readFileSync6 } from "node:fs";
import { isAbsolute, join as join4 } from "node:path";

// src/mcp/result-text.ts
function findJustWrittenEntry(name, cwd) {
  const entries = listSecrets({ scope: "all", cwd }).filter((e) => e.name === name);
  if (entries.length <= 1) return entries[0];
  return entries.reduce((latest, entry) => entry.updatedAt > latest.updatedAt ? entry : latest);
}
function renderStoredLine(name, cwd) {
  const entry = findJustWrittenEntry(name, cwd);
  return entry ? `Stored ${name} in ${entry.depository} (${entry.scope})` : `Stored ${name}`;
}
function renderStoredLines(names, cwd) {
  return names.map((name) => renderStoredLine(name, cwd));
}
function renderOutcome(results, cwd) {
  const failed = results.filter((r) => !r.ok);
  const succeeded = results.filter((r) => r.ok);
  const lines = [
    ...failed.map((r) => `${r.name}: failed (${r.errorCode ?? "E_UNKNOWN"})`),
    ...renderStoredLines(succeeded.map((r) => r.name), cwd)
  ];
  return { text: lines.join("\n"), isError: succeeded.length === 0 };
}

// src/request/store.ts
import { randomBytes as randomBytes3 } from "node:crypto";
var REQUEST_TTL_MS = 15 * 60 * 1e3;
var REVEAL_TTL_MS = 5 * 60 * 1e3;
var SWEEP_INTERVAL_MS = 60 * 1e3;
var USED_GRACE_MS = 5 * 60 * 1e3;
function deferred() {
  let resolve2;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve2 = res;
    reject = rej;
  });
  return { promise, resolve: resolve2, reject };
}
function defaultTtlMs(kind) {
  return kind === "reveal" ? REVEAL_TTL_MS : REQUEST_TTL_MS;
}
var records = /* @__PURE__ */ new Map();
var waiters = /* @__PURE__ */ new Map();
var sweepTimer;
function isExpired(record, now) {
  return now > record.expiresAt;
}
function startSweeper() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}
function sweep() {
  const now = Date.now();
  for (const [id, record] of records) {
    if (record.usedAt !== void 0) {
      if (now - record.usedAt > USED_GRACE_MS) records.delete(id);
      continue;
    }
    if (isExpired(record, now)) {
      records.delete(id);
      const waiter = waiters.get(id);
      if (waiter) {
        waiter.reject(new Error("request expired"));
        waiters.delete(id);
      }
    }
  }
}
var RequestStore = {
  /** 32-hex id (128-bit random). Throws on a malformed kind/names combination (a caller bug, not reachable via HTTP input). */
  create(opts) {
    if (opts.kind === "reveal") {
      if (opts.names.length !== 1) throw new Error("a reveal covers exactly one secret name");
    } else if (opts.kind === "import") {
      if (opts.names.length < 1 || opts.names.length > 200) {
        throw new Error("an import must cover between 1 and 200 secret names");
      }
    } else if (opts.names.length < 1 || opts.names.length > 10) {
      throw new Error("a request must cover between 1 and 10 secret names");
    }
    const id = randomBytes3(16).toString("hex");
    const now = Date.now();
    const record = {
      id,
      kind: opts.kind,
      names: [...opts.names],
      reason: opts.reason,
      usage: opts.usage,
      depository: opts.depository,
      scope: opts.scope,
      rotate: opts.rotate,
      createdAt: now,
      expiresAt: now + (opts.ttlMs ?? defaultTtlMs(opts.kind)),
      values: opts.values ? { ...opts.values } : void 0,
      envFilePath: opts.envFilePath,
      ambiguousNames: opts.ambiguousNames ? [...opts.ambiguousNames] : void 0,
      ambiguousReasons: opts.ambiguousReasons ? { ...opts.ambiguousReasons } : void 0
    };
    records.set(id, record);
    startSweeper();
    return record;
  },
  /** Expiry-aware lookup. Returns the record while it is used-and-within-grace even past its TTL, so a 410 (not 404) can be rendered. */
  get(id) {
    const record = records.get(id);
    if (!record) return void 0;
    if (record.usedAt === void 0 && isExpired(record, Date.now())) return void 0;
    return record;
  },
  /**
   * Atomically checks existence, non-expiry, and non-use, then marks used.
   * This is the security boundary (S2.1): once it returns a record, every
   * later call for the same id returns undefined until the sweeper's grace
   * period elapses. Deliberately does NOT resolve the fulfilment waiter —
   * marking a token used and reporting what happened are two different
   * moments (see `fulfill`); a caller that wrote a value after this call
   * returns is still free to fail before ever calling `fulfill`.
   */
  tryMarkUsed(id) {
    const record = records.get(id);
    if (!record) return void 0;
    if (isExpired(record, Date.now())) {
      records.delete(id);
      return void 0;
    }
    if (record.usedAt !== void 0) return void 0;
    record.usedAt = Date.now();
    return record;
  },
  /**
   * Records the outcome of a used request/reveal and THEN resolves the
   * fulfilment waiter, in that order — a caller waking up from
   * `waitForFulfilled` is therefore guaranteed `get(id)?.results` is already
   * readable. `results` defaults to `[]` for a reveal, which has no
   * per-name write outcome to report but still needs the waiter to resolve
   * once the human has revealed it. No-op if the id is unknown.
   */
  fulfill(id, results = []) {
    const record = records.get(id);
    if (record) record.results = results;
    const waiter = waiters.get(id);
    if (waiter) {
      waiter.resolve("fulfilled");
      waiters.delete(id);
    }
  },
  /**
   * Resolves to the literal 'fulfilled' once `fulfill` has run for this id —
   * meaning the single-use token was consumed AND its outcome (`results`) is
   * already readable — or rejects if the id is unknown or expires first.
   * `fulfilled` means only that: a human completed the interaction. It says
   * nothing about per-name outcome, which `results` alone carries. Never
   * carries a value.
   */
  waitForFulfilled(id) {
    const record = records.get(id);
    if (!record) return Promise.reject(new Error("request not found"));
    if (record.results !== void 0) return Promise.resolve("fulfilled");
    let waiter = waiters.get(id);
    if (!waiter) {
      waiter = deferred();
      waiters.set(id, waiter);
    }
    return waiter.promise;
  },
  /** Test-only: clears all records/waiters and stops the sweeper so state never leaks between test files. */
  __resetForTests() {
    records.clear();
    waiters.clear();
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = void 0;
    }
  }
};

// src/storage/dotenv-file.ts
var BEGIN_MARKER2 = "# enigma:begin";
var END_MARKER2 = "# enigma:end";
var INLINE_COMMENT_REASON = 'the unquoted value contains a space then "#", which could start a comment or be part of the secret \u2014 quote the value if the # belongs to it, then rerun import';
function isAmbiguousUnquoted(raw) {
  return / #/.test(raw);
}
function detectEol2(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}
function findManagedBlock(lines) {
  const beginIdx = lines.findIndex((l) => l === BEGIN_MARKER2);
  if (beginIdx === -1) return void 0;
  const endIdx = lines.findIndex((l, i) => l === END_MARKER2 && i > beginIdx);
  if (endIdx === -1) return void 0;
  return { beginIdx, endIdx };
}
var ASSIGNMENT = /^(?:export\s+)?([^\s=]+)=(.*)$/;
function scanAssignments(lines, block) {
  const assignments = [];
  let i = 0;
  while (i < lines.length) {
    if (block && i >= block.beginIdx && i <= block.endIdx) {
      i++;
      continue;
    }
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    const match = ASSIGNMENT.exec(trimmed);
    if (!match) {
      i++;
      continue;
    }
    const name = match[1];
    const rest = match[2];
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      let joined = rest.slice(1);
      let endIdx = i;
      let closed = false;
      for (; ; ) {
        const closeIdx = findUnescapedQuote(joined, quote);
        if (closeIdx !== -1) {
          joined = joined.slice(0, closeIdx);
          closed = true;
          break;
        }
        const nextIdx = endIdx + 1;
        if (nextIdx >= lines.length || block && nextIdx >= block.beginIdx && nextIdx <= block.endIdx) break;
        endIdx = nextIdx;
        joined += `
${lines[endIdx]}`;
      }
      if (closed) {
        assignments.push({ name, value: joined, valid: NAME_PATTERN.test(name), ambiguous: false, startIdx: i, endIdx });
        i = endIdx + 1;
      } else {
        const ambiguous = isAmbiguousUnquoted(rest);
        assignments.push({
          name,
          value: rest.trim(),
          valid: NAME_PATTERN.test(name),
          ambiguous,
          ambiguousReason: ambiguous ? INLINE_COMMENT_REASON : void 0,
          startIdx: i,
          endIdx: i
        });
        i++;
      }
      continue;
    }
    {
      const ambiguous = isAmbiguousUnquoted(rest);
      assignments.push({
        name,
        value: rest.trim(),
        valid: NAME_PATTERN.test(name),
        ambiguous,
        ambiguousReason: ambiguous ? INLINE_COMMENT_REASON : void 0,
        startIdx: i,
        endIdx: i
      });
      i++;
    }
  }
  return assignments;
}
function findUnescapedQuote(text, quote) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === quote && text[i - 1] !== "\\") return i;
  }
  return -1;
}
function parseDotEnv(content) {
  const eol = detectEol2(content);
  const lines = content.length === 0 ? [] : content.split(eol);
  const block = findManagedBlock(lines);
  const assignments = scanAssignments(lines, block);
  const order = [];
  const values = /* @__PURE__ */ new Map();
  const ambiguousFlags = /* @__PURE__ */ new Map();
  const ambiguousReasons = /* @__PURE__ */ new Map();
  const invalidSeen = /* @__PURE__ */ new Set();
  const duplicateSeen = /* @__PURE__ */ new Set();
  for (const a of assignments) {
    if (!a.valid) {
      invalidSeen.add(a.name);
      continue;
    }
    if (values.has(a.name)) duplicateSeen.add(a.name);
    else order.push(a.name);
    values.set(a.name, a.value);
    ambiguousFlags.set(a.name, a.ambiguous);
    ambiguousReasons.set(a.name, a.ambiguousReason);
  }
  return {
    entries: order.map((name) => {
      const isDuplicate = duplicateSeen.has(name);
      return {
        name,
        value: values.get(name),
        ambiguous: isDuplicate || ambiguousFlags.get(name),
        ambiguousReason: isDuplicate ? `${name} is assigned more than once in this file \u2014 remove the duplicate line(s) and rerun import` : ambiguousReasons.get(name)
      };
    }),
    invalidNames: [...invalidSeen],
    duplicateNames: [...duplicateSeen]
  };
}
function removeDotEnvEntries(content, names, opts = {}) {
  const eol = detectEol2(content);
  const lines = content.length === 0 ? [] : content.split(eol);
  const block = findManagedBlock(lines);
  const assignments = scanAssignments(lines, block);
  const targets = new Set(names);
  const toRemove = assignments.filter((a) => a.valid && targets.has(a.name));
  if (toRemove.length === 0) return content;
  const removedLineIdx = /* @__PURE__ */ new Set();
  for (const a of toRemove) {
    for (let idx = a.startIdx; idx <= a.endIdx; idx++) removedLineIdx.add(idx);
  }
  const firstRemovedIdx = Math.min(...toRemove.map((a) => a.startIdx));
  const newLines = [];
  for (let idx = 0; idx < lines.length; idx++) {
    if (!removedLineIdx.has(idx)) {
      newLines.push(lines[idx]);
      continue;
    }
    if (idx === firstRemovedIdx && opts.comment) newLines.push(opts.comment);
  }
  return newLines.join(eol);
}

// src/storage/import-commit.ts
import { randomBytes as randomBytes4 } from "node:crypto";
import { existsSync as existsSync8, readFileSync as readFileSync5, renameSync as renameSync2, unlinkSync, writeFileSync as writeFileSync4 } from "node:fs";
var FILE_MODE4 = 384;
function writeFileAtomic(path, content, mode) {
  const tmpPath = `${path}.${randomBytes4(6).toString("hex")}.tmp`;
  try {
    writeFileSync4(tmpPath, content, { mode });
    renameSync2(tmpPath, path);
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      if (existsSync8(tmpPath)) unlinkSync(tmpPath);
      return { ok: false, error };
    } catch {
      return { ok: false, error, leftoverPath: tmpPath };
    }
  }
}
function ambiguousValueError(entry, envFilePath) {
  return new EnigmaError({
    code: "E_VALUE_AMBIGUOUS",
    message: `${entry.name} in ${envFilePath} is ambiguous: ${entry.ambiguousReason ?? "the value or its assignment could not be resolved unambiguously"}`,
    secretName: entry.name
  });
}
async function commitImport(opts) {
  const succeeded = [];
  const failed = [];
  for (const entry of opts.entries) {
    try {
      if (entry.ambiguous) throw ambiguousValueError(entry, opts.envFilePath);
      await setSecret({
        name: entry.name,
        value: entry.value,
        scope: opts.scope,
        depository: opts.depository,
        cwd: opts.cwd,
        actor: opts.actor,
        rotate: opts.rotate,
        createVault: opts.createVault,
        auditOp: "import"
      });
      succeeded.push(entry.name);
    } catch (err) {
      failed.push({
        name: entry.name,
        errorCode: err instanceof EnigmaError ? err.code : "E_UNKNOWN",
        message: err instanceof EnigmaError ? err.message : void 0
      });
      break;
    }
  }
  const attempted = /* @__PURE__ */ new Set([...succeeded, ...failed.map((f) => f.name)]);
  const notAttempted = opts.entries.map((e) => e.name).filter((name) => !attempted.has(name));
  const warnings = checkEnvGitignore(opts.projectPath);
  if (failed.length > 0) {
    if (opts.depository === "env" && succeeded.length > 0) {
      warnings.push(
        `${succeeded.length} secret(s) (${succeeded.join(", ")}) were already written into the .env managed block before the failure on ${failed[0].name}; the original plaintext line(s) were deliberately left in place. Fix the issue and rerun import, or remove them from .env manually.`
      );
    }
    return { succeeded, failed, notAttempted, skippedMismatch: [], fileRewritten: false, warnings };
  }
  const currentContent = existsSync8(opts.envFilePath) ? readFileSync5(opts.envFilePath, "utf8") : "";
  const valueByName = new Map(opts.entries.map((e) => [e.name, e.value]));
  const currentValueByName = new Map(parseDotEnv(currentContent).entries.map((e) => [e.name, e.value]));
  const toRemove = [];
  const skippedMismatch = [];
  for (const name of succeeded) {
    const currentValue = currentValueByName.get(name);
    if (currentValue === void 0) continue;
    if (currentValue === valueByName.get(name)) toRemove.push(name);
    else skippedMismatch.push(name);
  }
  for (const name of skippedMismatch) {
    warnings.push(
      `${name} was migrated, but its value in .env changed before the file could be rewritten \u2014 left in place rather than guessing which copy is current. Rerun import to migrate the new value, or remove the line manually.`
    );
  }
  const movedComment = toRemove.length === 0 || opts.depository === "env" ? void 0 : `# Moved to Enigma (${opts.depository}) by \`enigma import\` on ${(/* @__PURE__ */ new Date()).toISOString()}: ${toRemove.join(", ")}`;
  const rewritten = toRemove.length > 0 ? removeDotEnvEntries(currentContent, toRemove, { comment: movedComment }) : currentContent;
  const needsWrite = rewritten !== currentContent;
  if (!needsWrite) {
    return { succeeded, failed: [], notAttempted: [], skippedMismatch, fileRewritten: false, warnings };
  }
  const writeResult = writeFileAtomic(opts.envFilePath, rewritten, FILE_MODE4);
  if (!writeResult.ok) {
    warnings.push(
      `Failed to rewrite ${opts.envFilePath} (${writeResult.error}). The migrated secret(s) (${toRemove.join(", ")}) are safely stored, but their plaintext line(s) were left in place because the file could not be rewritten \u2014 rerun import once the issue is fixed, or remove them from .env manually.`
    );
    if (writeResult.leftoverPath) {
      warnings.push(
        `A temporary file containing the full rewritten .env content was left behind at ${writeResult.leftoverPath} and could not be removed automatically \u2014 delete it manually as soon as possible.`
      );
    }
    return { succeeded, failed: [], notAttempted: [], skippedMismatch, fileRewritten: false, warnings };
  }
  return { succeeded, failed: [], notAttempted: [], skippedMismatch, fileRewritten: true, warnings };
}

// src/web/server.ts
import * as http from "node:http";

// src/web/network-policy.ts
import { isIP } from "node:net";
var LOCALHOST_ADDRESSES = /* @__PURE__ */ new Set(["localhost", "127.0.0.1", "::1"]);
function isLocalhostBinding(host) {
  return LOCALHOST_ADDRESSES.has(host);
}
function isTailscaleHost(host) {
  const lower = host.toLowerCase();
  if (lower.endsWith(".ts.net")) return true;
  if (isIP(host) !== 4) return false;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 100 && b >= 64 && b <= 127;
}
function decideInsecureHttpPolicy(host, allowOverride) {
  if (isLocalhostBinding(host)) return { allow: true, reason: "localhost" };
  if (isTailscaleHost(host)) return { allow: true, reason: "tailscale" };
  if (allowOverride) return { allow: true, reason: "override" };
  return { allow: false, reason: "refuse" };
}

// src/web/headers.ts
function applySecurityHeaders(res) {
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

// src/web/templates/request-form.html?raw
var request_form_default = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Enigma \u2014 secret request</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    max-width: 480px;
    margin: 6vh auto 40px;
    padding: 0 16px;
    box-sizing: border-box;
    color: #18181b;
    background: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e4e4e7; background: #18181b; }
    .card, fieldset { border-color: #3f3f46 !important; background: #27272a !important; }
    input, select { background: #18181b !important; color: #e4e4e7 !important; border-color: #3f3f46 !important; }
    button[type="submit"] { background: #e4e4e7 !important; color: #18181b !important; }
    .warn { background: #422006 !important; color: #fde68a !important; }
    .error { background: #450a0a !important; color: #fecaca !important; }
  }
  * { box-sizing: border-box; }
  .card { border: 1px solid #e4e4e7; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  h1 { font-size: 1.1rem; margin: 0 0 4px; }
  p.muted { color: #71717a; margin: 4px 0 16px; }
  fieldset { border: 1px solid #e4e4e7; border-radius: 10px; margin: 0 0 12px; padding: 12px; }
  legend { padding: 0 6px; font-weight: 600; font-size: 0.9rem; }
  label { display: block; font-size: 0.85rem; margin: 10px 0 4px; }
  input[type="password"], input[type="text"], select {
    width: 100%; padding: 10px; border: 1px solid #d4d4d8; border-radius: 8px; font-size: 1rem;
  }
  .checkbox-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .checkbox-row label { margin: 0; }
  button[type="submit"] {
    width: 100%; padding: 12px; border: none; border-radius: 8px;
    background: #18181b; color: #fff; font-size: 1rem; cursor: pointer; margin-top: 8px;
  }
  .warn { background: #fef9c3; color: #713f12; border-radius: 8px; padding: 10px; font-size: 0.85rem; margin-bottom: 12px; }
  .error { background: #fee2e2; color: #7f1d1d; border-radius: 8px; padding: 10px; font-size: 0.85rem; margin-bottom: 12px; }
  .rotate-note { color: #ca8a04; font-size: 0.8rem; margin-top: 2px; }
  .rotate-note:empty { display: none; margin: 0; }
  .qr-card { text-align: center; }
  .qr-card svg { width: 180px; height: 180px; background: #ffffff; padding: 10px; border-radius: 8px; }
  .qr-card p.muted { margin: 8px 0 0; }
</style>
</head>
<body>
  <div class="card">
    <h1>Secret request</h1>
    <p class="muted">{{REASON}}</p>

    <!--BLOCK:ERROR_BLOCK-->
    <div class="error">{{ERROR_MESSAGE}}</div>
    <!--/BLOCK:ERROR_BLOCK-->

    <!--BLOCK:QR_BLOCK-->
    <div class="qr-card">
      {{RAW_QR_SVG}}
      <p class="muted">Scan to open this request on your phone</p>
    </div>
    <!--/BLOCK:QR_BLOCK-->

    <!--BLOCK:CONFIRM_BLOCK-->
    <div class="warn">
      The <strong>{{CONFIRM_DEPOSITORY}}</strong> depository isn't set up yet. Check the box below to confirm creating it and try again.
    </div>
    <!--/BLOCK:CONFIRM_BLOCK-->

    <form method="post" action="/r/{{ID}}">
      <!--BLOCK:NAME_ROW-->
      <label for="field-{{NAME}}">{{NAME}}<br /><span class="muted">{{DESCRIPTION}} ({{USAGE}})</span></label>
      <input id="field-{{NAME}}" type="password" name="{{NAME}}" autocomplete="off" required />
      <p class="rotate-note">{{ROTATE_NOTE}}</p>
      <!--/BLOCK:NAME_ROW-->

      <fieldset>
        <legend>Where to store it</legend>
        <label for="depository">Depository</label>
        <select id="depository" name="depository">
          <!--BLOCK:DEP_OPTION-->
          <option value="{{DEP_ID}}" {{DEP_SELECTED}}>{{DEP_LABEL}}</option>
          <!--/BLOCK:DEP_OPTION-->
        </select>

        <label for="scope">Scope</label>
        <select id="scope" name="scope">
          <option value="project" {{SCOPE_PROJECT_SELECTED}}>This project</option>
          <option value="global" {{SCOPE_GLOBAL_SELECTED}}>Global</option>
        </select>

        <div class="checkbox-row">
          <input id="rotate" type="checkbox" name="rotate" {{ROTATE_CHECKED}} />
          <label for="rotate">Rotate if already present</label>
        </div>

        <!--BLOCK:CONFIRM_CHECKBOX-->
        <div class="checkbox-row">
          <input id="confirmCreateVault" type="checkbox" name="confirmCreateVault" />
          <label for="confirmCreateVault">Create the {{CONFIRM_DEPOSITORY}} depository</label>
        </div>
        <!--/BLOCK:CONFIRM_CHECKBOX-->
      </fieldset>

      <button type="submit">Submit</button>
    </form>
  </div>
</body>
</html>
`;

// src/web/templates/request-done.html?raw
var request_done_default = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>Enigma \u2014 done</title>\n<style>\n  :root { color-scheme: light dark; }\n  body {\n    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;\n    max-width: 480px;\n    margin: 10vh auto 0;\n    padding: 0 16px;\n    box-sizing: border-box;\n    color: #18181b;\n    background: #ffffff;\n  }\n  @media (prefers-color-scheme: dark) {\n    body { color: #e4e4e7; background: #18181b; }\n    .card { border-color: #3f3f46 !important; background: #27272a !important; }\n  }\n  * { box-sizing: border-box; }\n  .card { border: 1px solid #e4e4e7; border-radius: 12px; padding: 20px; }\n  h1 { font-size: 1.1rem; margin: 0 0 12px; }\n  ul { list-style: none; margin: 0; padding: 0; }\n  li { padding: 6px 0; border-top: 1px solid #e4e4e7; }\n  li:first-child { border-top: none; }\n  .ok { color: #16a34a; }\n  .fail { color: #dc2626; }\n  p.muted { color: #71717a; margin-top: 16px; font-size: 0.9rem; }\n</style>\n</head>\n<body>\n  <div class="card">\n    <h1>Request complete</h1>\n    <ul>\n      <!--BLOCK:RESULT_ROW-->\n      <li class="{{STATUS_CLASS}}">{{NAME}} \u2014 {{STATUS_TEXT}}</li>\n      <!--/BLOCK:RESULT_ROW-->\n    </ul>\n    <p class="muted">You can close this tab.</p>\n  </div>\n</body>\n</html>\n';

// src/web/templates/reveal-shell.html?raw
var reveal_shell_default = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>Enigma \u2014 reveal {{NAME}}</title>\n<style>\n  :root { color-scheme: light dark; }\n  body {\n    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;\n    max-width: 480px;\n    margin: 10vh auto 0;\n    padding: 0 16px;\n    box-sizing: border-box;\n    color: #18181b;\n    background: #ffffff;\n  }\n  @media (prefers-color-scheme: dark) {\n    body { color: #e4e4e7; background: #18181b; }\n    .card { border-color: #3f3f46 !important; background: #27272a !important; }\n    button { background: #e4e4e7 !important; color: #18181b !important; }\n    code { background: #3f3f46 !important; }\n  }\n  * { box-sizing: border-box; }\n  .card { border: 1px solid #e4e4e7; border-radius: 12px; padding: 20px; }\n  h1 { font-size: 1.1rem; margin: 0 0 4px; }\n  p.muted { color: #71717a; margin: 4px 0 16px; }\n  button { width: 100%; padding: 12px; border: none; border-radius: 8px; background: #18181b; color: #fff; font-size: 1rem; cursor: pointer; }\n  button:disabled { opacity: 0.6; cursor: default; }\n  code { display: block; word-break: break-all; background: #f4f4f5; padding: 10px; border-radius: 8px; margin-top: 12px; }\n  #status { margin-top: 12px; color: #71717a; font-size: 0.9rem; }\n</style>\n</head>\n<body>\n  <div class="card">\n    <h1>Reveal {{NAME}}</h1>\n    <p class="muted">This link works once. The value never appears until you click Reveal, and it is hidden again after 60 seconds.</p>\n    <button id="revealBtn" type="button" data-id="{{ID}}">Reveal</button>\n    <code id="valueBox" hidden></code>\n    <p id="status"></p>\n  </div>\n  <script src="/static/reveal.js"></script>\n</body>\n</html>\n';

// src/web/templates/error.html?raw
var error_default = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>Enigma \u2014 {{STATUS}}</title>\n<style>\n  :root { color-scheme: light dark; }\n  body {\n    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;\n    max-width: 480px;\n    margin: 15vh auto 0;\n    padding: 0 16px;\n    color: #18181b;\n    background: #ffffff;\n  }\n  @media (prefers-color-scheme: dark) {\n    body { color: #e4e4e7; background: #18181b; }\n  }\n  h1 { font-size: 1.25rem; }\n  p { color: #71717a; }\n</style>\n</head>\n<body>\n  <h1>{{STATUS}}</h1>\n  <p>{{MESSAGE}}</p>\n</body>\n</html>\n';

// src/web/templates/import-form.html?raw
var import_form_default = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Enigma \u2014 import</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    max-width: 480px;
    margin: 6vh auto 40px;
    padding: 0 16px;
    box-sizing: border-box;
    color: #18181b;
    background: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e4e4e7; background: #18181b; }
    .card, fieldset { border-color: #3f3f46 !important; background: #27272a !important; }
    select { background: #18181b !important; color: #e4e4e7 !important; border-color: #3f3f46 !important; }
    button[type="submit"] { background: #e4e4e7 !important; color: #18181b !important; }
    .warn { background: #422006 !important; color: #fde68a !important; }
    .error { background: #450a0a !important; color: #fecaca !important; }
  }
  * { box-sizing: border-box; }
  .card { border: 1px solid #e4e4e7; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  h1 { font-size: 1.1rem; margin: 0 0 4px; }
  p.muted { color: #71717a; margin: 4px 0 16px; }
  fieldset { border: 1px solid #e4e4e7; border-radius: 10px; margin: 0 0 12px; padding: 12px; }
  legend { padding: 0 6px; font-weight: 600; font-size: 0.9rem; }
  label { display: block; font-size: 0.85rem; margin: 10px 0 4px; }
  select { width: 100%; padding: 10px; border: 1px solid #d4d4d8; border-radius: 8px; font-size: 1rem; }
  ul.names { list-style: none; margin: 0 0 12px; padding: 0; }
  ul.names li { padding: 6px 0; border-top: 1px solid #e4e4e7; font-size: 0.9rem; }
  ul.names li:first-child { border-top: none; }
  .checkbox-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .checkbox-row label { margin: 0; }
  button[type="submit"] {
    width: 100%; padding: 12px; border: none; border-radius: 8px;
    background: #18181b; color: #fff; font-size: 1rem; cursor: pointer; margin-top: 8px;
  }
  .warn { background: #fef9c3; color: #713f12; border-radius: 8px; padding: 10px; font-size: 0.85rem; margin-bottom: 12px; }
  .error { background: #fee2e2; color: #7f1d1d; border-radius: 8px; padding: 10px; font-size: 0.85rem; margin-bottom: 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Import secrets</h1>
    <p class="muted">{{COUNT}} secret(s) parsed from the project's .env. Choose where to store them.</p>

    <!--BLOCK:ERROR_BLOCK-->
    <div class="error">{{ERROR_MESSAGE}}</div>
    <!--/BLOCK:ERROR_BLOCK-->

    <!--BLOCK:WARN_BLOCK-->
    <div class="warn">{{WARN_MESSAGE}}</div>
    <!--/BLOCK:WARN_BLOCK-->

    <!--BLOCK:CONFIRM_BLOCK-->
    <div class="warn">
      The <strong>{{CONFIRM_DEPOSITORY}}</strong> depository isn't set up yet. Check the box below to confirm creating it and try again.
    </div>
    <!--/BLOCK:CONFIRM_BLOCK-->

    <ul class="names">
      <!--BLOCK:NAME_ROW-->
      <li>{{NAME}}</li>
      <!--/BLOCK:NAME_ROW-->
    </ul>

    <form method="post" action="/i/{{ID}}">
      <fieldset>
        <legend>Where to store them</legend>
        <label for="depository">Depository</label>
        <select id="depository" name="depository">
          <!--BLOCK:DEP_OPTION-->
          <option value="{{DEP_ID}}" {{DEP_SELECTED}}>{{DEP_LABEL}}</option>
          <!--/BLOCK:DEP_OPTION-->
        </select>

        <div class="checkbox-row">
          <input id="rotate" type="checkbox" name="rotate" />
          <label for="rotate">Rotate any that already exist</label>
        </div>

        <!--BLOCK:CONFIRM_CHECKBOX-->
        <div class="checkbox-row">
          <input id="confirmCreateVault" type="checkbox" name="confirmCreateVault" />
          <label for="confirmCreateVault">Create the {{CONFIRM_DEPOSITORY}} depository</label>
        </div>
        <!--/BLOCK:CONFIRM_CHECKBOX-->
      </fieldset>

      <button type="submit">Import</button>
    </form>
  </div>
</body>
</html>
`;

// src/web/templates/render.ts
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function renderTemplate(html, vars) {
  return html.replace(
    /\{\{([A-Z0-9_]+)\}\}/g,
    (match, token) => Object.prototype.hasOwnProperty.call(vars, token) ? escapeHtml(vars[token]) : match
  );
}
function renderRepeatingBlock(html, blockName, rows) {
  const start = `<!--BLOCK:${blockName}-->`;
  const end = `<!--/BLOCK:${blockName}-->`;
  const startIndex = html.indexOf(start);
  const endIndex = html.indexOf(end);
  if (startIndex === -1 || endIndex === -1) return html;
  const rowTemplate = html.slice(startIndex + start.length, endIndex);
  const rendered = rows.map((row) => renderTemplate(rowTemplate, row)).join("");
  return html.slice(0, startIndex) + rendered + html.slice(endIndex + end.length);
}

// src/web/responses.ts
function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
function sendStaticJs(res, content) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/javascript; charset=utf-8");
  res.end(content);
}
function sendErrorPage(res, status, statusText, message) {
  sendHtml(res, status, renderTemplate(error_default, { STATUS: statusText, MESSAGE: message }));
}

// src/web/body.ts
var MAX_BODY_BYTES = 64 * 1024;
var PayloadTooLargeError = class extends Error {
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = "PayloadTooLargeError";
  }
};
function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve2, reject) => {
    const chunks = [];
    let total = 0;
    let settled2 = false;
    const settleError = (err) => {
      if (settled2) return;
      settled2 = true;
      reject(err);
    };
    req.on("data", (chunk) => {
      if (settled2) return;
      total += chunk.length;
      if (total > maxBytes) {
        settleError(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled2) return;
      settled2 = true;
      resolve2(Buffer.concat(chunks));
    });
    req.on("error", settleError);
  });
}
function truthy(value) {
  return value === "on" || value === "true" || value === "1";
}
function parseSubmission(contentType, body, names) {
  const text = body.toString("utf8");
  if (contentType?.toLowerCase().includes("application/json")) {
    const parsed = JSON.parse(text);
    const values2 = {};
    for (const name of names) {
      const raw = parsed.values?.[name];
      if (typeof raw === "string") values2[name] = raw;
    }
    return {
      values: values2,
      depository: typeof parsed.depository === "string" ? parsed.depository : void 0,
      scope: typeof parsed.scope === "string" ? parsed.scope : void 0,
      rotate: Boolean(parsed.rotate),
      confirmCreateVault: Boolean(parsed.confirmCreateVault)
    };
  }
  const params = new URLSearchParams(text);
  const values = {};
  for (const name of names) {
    const raw = params.get(name);
    if (raw !== null) values[name] = raw;
  }
  return {
    values,
    depository: params.get("depository") ?? void 0,
    scope: params.get("scope") ?? void 0,
    rotate: truthy(params.get("rotate")),
    confirmCreateVault: truthy(params.get("confirmCreateVault"))
  };
}

// src/web/depository-picker.ts
var PROMPT_PROFILE_LABEL = {
  none: "no prompt",
  "may-prompt": "may prompt",
  "prompts-each-read": "prompts every read"
};
function pickDefaultDepository(detections, opts = {}) {
  const available = detections.filter((d) => d.available);
  if (opts.sticky && available.some((d) => d.id === opts.sticky)) return opts.sticky;
  if (opts.usage === "unattended") {
    const noPrompt = available.find((d) => d.promptProfile === "none");
    if (noPrompt) return noPrompt.id;
  }
  return available[0]?.id;
}
function buildDepositoryOptions(detections, opts = {}) {
  const preselected = opts.requested ?? pickDefaultDepository(detections, opts);
  return detections.map((d) => ({
    id: d.id,
    label: `${d.id} (${PROMPT_PROFILE_LABEL[d.promptProfile]})`,
    promptProfile: d.promptProfile,
    available: d.available,
    reason: d.reason,
    selected: d.id === preselected
  }));
}
function needsAvailabilityConfirmation(detections, id) {
  if (!id) return false;
  const match = detections.find((d) => d.id === id);
  return !match || !match.available;
}

// src/web/routes/import-form.ts
async function renderForm(res, record, opts = {}) {
  const detections = await detectAll();
  const config = loadConfig();
  const requested = opts.selectedDepositoryId ?? record.depository;
  const options = buildDepositoryOptions(detections, { sticky: config.defaultDepository, requested });
  const warnings = checkEnvGitignore(findProjectPath(process.cwd()));
  let html = import_form_default;
  html = renderTemplate(html, { ID: record.id, COUNT: String(record.names.length) });
  html = renderRepeatingBlock(html, "NAME_ROW", record.names.map((name) => ({ NAME: name })));
  html = renderRepeatingBlock(
    html,
    "DEP_OPTION",
    options.map((o) => ({ DEP_ID: o.id, DEP_LABEL: o.label, DEP_SELECTED: o.selected ? "selected" : "" }))
  );
  html = renderRepeatingBlock(html, "ERROR_BLOCK", opts.errorMessage ? [{ ERROR_MESSAGE: opts.errorMessage }] : []);
  html = renderRepeatingBlock(html, "WARN_BLOCK", warnings.map((w) => ({ WARN_MESSAGE: w })));
  const confirmRows = opts.confirmDepository ? [{ CONFIRM_DEPOSITORY: opts.confirmDepository }] : [];
  html = renderRepeatingBlock(html, "CONFIRM_BLOCK", confirmRows);
  html = renderRepeatingBlock(html, "CONFIRM_CHECKBOX", confirmRows);
  sendHtml(res, opts.status ?? 200, html);
}
function getUsableImportRecord(id) {
  const record = RequestStore.get(id);
  if (!record || record.kind !== "import") return "not-found";
  if (record.usedAt !== void 0) return "used";
  return record;
}
async function handleImportFormGet(res, id) {
  const record = getUsableImportRecord(id);
  if (record === "not-found") {
    sendErrorPage(res, 404, "Not found", "This link is unknown or has expired.");
    return;
  }
  if (record === "used") {
    sendErrorPage(res, 410, "Already used", "This link has already been used.");
    return;
  }
  await renderForm(res, record);
}
async function handleImportFormPost(req, res, id) {
  const record = getUsableImportRecord(id);
  if (record === "not-found") {
    sendErrorPage(res, 404, "Not found", "This link is unknown or has expired.");
    return;
  }
  if (record === "used") {
    sendErrorPage(res, 410, "Already used", "This link has already been used.");
    return;
  }
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendErrorPage(res, 413, "Payload too large", "The submission is too large.");
      return;
    }
    sendErrorPage(res, 400, "Bad request", "Could not read the submission.");
    return;
  }
  let submission;
  try {
    submission = parseSubmission(req.headers["content-type"], body, []);
  } catch {
    sendErrorPage(res, 400, "Bad request", "Could not parse the submission.");
    return;
  }
  const chosenDepository = submission.depository;
  if (!chosenDepository) {
    await renderForm(res, record, { errorMessage: "Choose a depository." });
    return;
  }
  const detections = await detectAll();
  if (needsAvailabilityConfirmation(detections, chosenDepository) && !submission.confirmCreateVault) {
    await renderForm(res, record, { confirmDepository: chosenDepository, selectedDepositoryId: chosenDepository });
    return;
  }
  const marked = RequestStore.tryMarkUsed(id);
  if (!marked) {
    sendErrorPage(res, 410, "Already used", "This link has already been used.");
    return;
  }
  const cwd = process.cwd();
  const projectPath = findProjectPath(cwd);
  const scope = record.scope ?? "project";
  const values = record.values ?? {};
  const ambiguousNames = new Set(record.ambiguousNames ?? []);
  const ambiguousReasons = record.ambiguousReasons ?? {};
  const entries = record.names.map((name) => ({
    name,
    value: values[name] ?? "",
    ambiguous: ambiguousNames.has(name),
    ambiguousReason: ambiguousReasons[name]
  }));
  const commitResult = await commitImport({
    entries,
    depository: chosenDepository,
    scope,
    cwd,
    projectPath,
    envFilePath: record.envFilePath ?? `${projectPath}/.env`,
    actor: "user",
    rotate: submission.rotate,
    createVault: submission.confirmCreateVault
  });
  const results = [
    ...commitResult.failed.map((f) => ({ name: f.name, ok: false, errorCode: f.errorCode })),
    ...commitResult.notAttempted.map((name) => ({ name, ok: false, errorCode: "E_NOT_ATTEMPTED" })),
    ...commitResult.succeeded.map((name) => ({ name, ok: true }))
  ];
  record.importOutcome = {
    fileRewritten: commitResult.fileRewritten,
    warnings: commitResult.warnings,
    skippedMismatch: commitResult.skippedMismatch,
    depository: chosenDepository
  };
  RequestStore.fulfill(id, results);
  let html = request_done_default;
  html = renderRepeatingBlock(
    html,
    "RESULT_ROW",
    results.map((r) => ({
      NAME: r.name,
      STATUS_CLASS: r.ok ? "ok" : "fail",
      STATUS_TEXT: r.ok ? "stored" : `failed (${r.errorCode})`
    }))
  );
  sendHtml(res, 200, html);
}

// src/remote/cloudflared.ts
var MAX_STDERR_BYTES = 64 * 1024;

// src/remote/index.ts
var active = /* @__PURE__ */ new Map();
function getActiveRemoteUrl(requestId) {
  return active.get(requestId)?.tunnel?.url;
}
function stopAllActiveTunnels() {
  for (const entry of active.values()) {
    try {
      entry.tunnel?.stop();
    } catch {
    }
  }
}
var shutdownHandlersRegistered = false;
function registerShutdownHandlers() {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;
  process.once("exit", stopAllActiveTunnels);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      try {
        stopAllActiveTunnels();
      } finally {
        process.kill(process.pid, signal);
      }
    });
  }
}
registerShutdownHandlers();

// node_modules/qrcode-generator/dist/qrcode.mjs
var qrcode = function(typeNumber, errorCorrectionLevel) {
  const PAD0 = 236;
  const PAD1 = 17;
  let _typeNumber = typeNumber;
  const _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
  let _modules = null;
  let _moduleCount = 0;
  let _dataCache = null;
  const _dataList = [];
  const _this = {};
  const makeImpl = function(test, maskPattern) {
    _moduleCount = _typeNumber * 4 + 17;
    _modules = (function(moduleCount) {
      const modules = new Array(moduleCount);
      for (let row = 0; row < moduleCount; row += 1) {
        modules[row] = new Array(moduleCount);
        for (let col = 0; col < moduleCount; col += 1) {
          modules[row][col] = null;
        }
      }
      return modules;
    })(_moduleCount);
    setupPositionProbePattern(0, 0);
    setupPositionProbePattern(_moduleCount - 7, 0);
    setupPositionProbePattern(0, _moduleCount - 7);
    setupPositionAdjustPattern();
    setupTimingPattern();
    setupTypeInfo(test, maskPattern);
    if (_typeNumber >= 7) {
      setupTypeNumber(test);
    }
    if (_dataCache == null) {
      _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
    }
    mapData(_dataCache, maskPattern);
  };
  const setupPositionProbePattern = function(row, col) {
    for (let r = -1; r <= 7; r += 1) {
      if (row + r <= -1 || _moduleCount <= row + r) continue;
      for (let c = -1; c <= 7; c += 1) {
        if (col + c <= -1 || _moduleCount <= col + c) continue;
        if (0 <= r && r <= 6 && (c == 0 || c == 6) || 0 <= c && c <= 6 && (r == 0 || r == 6) || 2 <= r && r <= 4 && 2 <= c && c <= 4) {
          _modules[row + r][col + c] = true;
        } else {
          _modules[row + r][col + c] = false;
        }
      }
    }
  };
  const getBestMaskPattern = function() {
    let minLostPoint = 0;
    let pattern = 0;
    for (let i = 0; i < 8; i += 1) {
      makeImpl(true, i);
      const lostPoint = QRUtil.getLostPoint(_this);
      if (i == 0 || minLostPoint > lostPoint) {
        minLostPoint = lostPoint;
        pattern = i;
      }
    }
    return pattern;
  };
  const setupTimingPattern = function() {
    for (let r = 8; r < _moduleCount - 8; r += 1) {
      if (_modules[r][6] != null) {
        continue;
      }
      _modules[r][6] = r % 2 == 0;
    }
    for (let c = 8; c < _moduleCount - 8; c += 1) {
      if (_modules[6][c] != null) {
        continue;
      }
      _modules[6][c] = c % 2 == 0;
    }
  };
  const setupPositionAdjustPattern = function() {
    const pos = QRUtil.getPatternPosition(_typeNumber);
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = 0; j < pos.length; j += 1) {
        const row = pos[i];
        const col = pos[j];
        if (_modules[row][col] != null) {
          continue;
        }
        for (let r = -2; r <= 2; r += 1) {
          for (let c = -2; c <= 2; c += 1) {
            if (r == -2 || r == 2 || c == -2 || c == 2 || r == 0 && c == 0) {
              _modules[row + r][col + c] = true;
            } else {
              _modules[row + r][col + c] = false;
            }
          }
        }
      }
    }
  };
  const setupTypeNumber = function(test) {
    const bits = QRUtil.getBCHTypeNumber(_typeNumber);
    for (let i = 0; i < 18; i += 1) {
      const mod = !test && (bits >> i & 1) == 1;
      _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
    }
    for (let i = 0; i < 18; i += 1) {
      const mod = !test && (bits >> i & 1) == 1;
      _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
    }
  };
  const setupTypeInfo = function(test, maskPattern) {
    const data = _errorCorrectionLevel << 3 | maskPattern;
    const bits = QRUtil.getBCHTypeInfo(data);
    for (let i = 0; i < 15; i += 1) {
      const mod = !test && (bits >> i & 1) == 1;
      if (i < 6) {
        _modules[i][8] = mod;
      } else if (i < 8) {
        _modules[i + 1][8] = mod;
      } else {
        _modules[_moduleCount - 15 + i][8] = mod;
      }
    }
    for (let i = 0; i < 15; i += 1) {
      const mod = !test && (bits >> i & 1) == 1;
      if (i < 8) {
        _modules[8][_moduleCount - i - 1] = mod;
      } else if (i < 9) {
        _modules[8][15 - i - 1 + 1] = mod;
      } else {
        _modules[8][15 - i - 1] = mod;
      }
    }
    _modules[_moduleCount - 8][8] = !test;
  };
  const mapData = function(data, maskPattern) {
    let inc = -1;
    let row = _moduleCount - 1;
    let bitIndex = 7;
    let byteIndex = 0;
    const maskFunc = QRUtil.getMaskFunction(maskPattern);
    for (let col = _moduleCount - 1; col > 0; col -= 2) {
      if (col == 6) col -= 1;
      while (true) {
        for (let c = 0; c < 2; c += 1) {
          if (_modules[row][col - c] == null) {
            let dark = false;
            if (byteIndex < data.length) {
              dark = (data[byteIndex] >>> bitIndex & 1) == 1;
            }
            const mask = maskFunc(row, col - c);
            if (mask) {
              dark = !dark;
            }
            _modules[row][col - c] = dark;
            bitIndex -= 1;
            if (bitIndex == -1) {
              byteIndex += 1;
              bitIndex = 7;
            }
          }
        }
        row += inc;
        if (row < 0 || _moduleCount <= row) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  };
  const createBytes = function(buffer, rsBlocks) {
    let offset = 0;
    let maxDcCount = 0;
    let maxEcCount = 0;
    const dcdata = new Array(rsBlocks.length);
    const ecdata = new Array(rsBlocks.length);
    for (let r = 0; r < rsBlocks.length; r += 1) {
      const dcCount = rsBlocks[r].dataCount;
      const ecCount = rsBlocks[r].totalCount - dcCount;
      maxDcCount = Math.max(maxDcCount, dcCount);
      maxEcCount = Math.max(maxEcCount, ecCount);
      dcdata[r] = new Array(dcCount);
      for (let i = 0; i < dcdata[r].length; i += 1) {
        dcdata[r][i] = 255 & buffer.getBuffer()[i + offset];
      }
      offset += dcCount;
      const rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
      const rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);
      const modPoly = rawPoly.mod(rsPoly);
      ecdata[r] = new Array(rsPoly.getLength() - 1);
      for (let i = 0; i < ecdata[r].length; i += 1) {
        const modIndex = i + modPoly.getLength() - ecdata[r].length;
        ecdata[r][i] = modIndex >= 0 ? modPoly.getAt(modIndex) : 0;
      }
    }
    let totalCodeCount = 0;
    for (let i = 0; i < rsBlocks.length; i += 1) {
      totalCodeCount += rsBlocks[i].totalCount;
    }
    const data = new Array(totalCodeCount);
    let index = 0;
    for (let i = 0; i < maxDcCount; i += 1) {
      for (let r = 0; r < rsBlocks.length; r += 1) {
        if (i < dcdata[r].length) {
          data[index] = dcdata[r][i];
          index += 1;
        }
      }
    }
    for (let i = 0; i < maxEcCount; i += 1) {
      for (let r = 0; r < rsBlocks.length; r += 1) {
        if (i < ecdata[r].length) {
          data[index] = ecdata[r][i];
          index += 1;
        }
      }
    }
    return data;
  };
  const createData = function(typeNumber2, errorCorrectionLevel2, dataList) {
    const rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, errorCorrectionLevel2);
    const buffer = qrBitBuffer();
    for (let i = 0; i < dataList.length; i += 1) {
      const data = dataList[i];
      buffer.put(data.getMode(), 4);
      buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
      data.write(buffer);
    }
    let totalDataCount = 0;
    for (let i = 0; i < rsBlocks.length; i += 1) {
      totalDataCount += rsBlocks[i].dataCount;
    }
    if (buffer.getLengthInBits() > totalDataCount * 8) {
      throw "code length overflow. (" + buffer.getLengthInBits() + ">" + totalDataCount * 8 + ")";
    }
    if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
      buffer.put(0, 4);
    }
    while (buffer.getLengthInBits() % 8 != 0) {
      buffer.putBit(false);
    }
    while (true) {
      if (buffer.getLengthInBits() >= totalDataCount * 8) {
        break;
      }
      buffer.put(PAD0, 8);
      if (buffer.getLengthInBits() >= totalDataCount * 8) {
        break;
      }
      buffer.put(PAD1, 8);
    }
    return createBytes(buffer, rsBlocks);
  };
  _this.addData = function(data, mode) {
    mode = mode || "Byte";
    let newData = null;
    switch (mode) {
      case "Numeric":
        newData = qrNumber(data);
        break;
      case "Alphanumeric":
        newData = qrAlphaNum(data);
        break;
      case "Byte":
        newData = qr8BitByte(data);
        break;
      case "Kanji":
        newData = qrKanji(data);
        break;
      default:
        throw "mode:" + mode;
    }
    _dataList.push(newData);
    _dataCache = null;
  };
  _this.isDark = function(row, col) {
    if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
      throw row + "," + col;
    }
    return _modules[row][col];
  };
  _this.getModuleCount = function() {
    return _moduleCount;
  };
  _this.make = function() {
    if (_typeNumber < 1) {
      let typeNumber2 = 1;
      for (; typeNumber2 < 40; typeNumber2++) {
        const rsBlocks = QRRSBlock.getRSBlocks(typeNumber2, _errorCorrectionLevel);
        const buffer = qrBitBuffer();
        for (let i = 0; i < _dataList.length; i++) {
          const data = _dataList[i];
          buffer.put(data.getMode(), 4);
          buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber2));
          data.write(buffer);
        }
        let totalDataCount = 0;
        for (let i = 0; i < rsBlocks.length; i++) {
          totalDataCount += rsBlocks[i].dataCount;
        }
        if (buffer.getLengthInBits() <= totalDataCount * 8) {
          break;
        }
      }
      _typeNumber = typeNumber2;
    }
    makeImpl(false, getBestMaskPattern());
  };
  _this.createTableTag = function(cellSize, margin) {
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    let qrHtml = "";
    qrHtml += '<table style="';
    qrHtml += " border-width: 0px; border-style: none;";
    qrHtml += " border-collapse: collapse;";
    qrHtml += " padding: 0px; margin: " + margin + "px;";
    qrHtml += '">';
    qrHtml += "<tbody>";
    for (let r = 0; r < _this.getModuleCount(); r += 1) {
      qrHtml += "<tr>";
      for (let c = 0; c < _this.getModuleCount(); c += 1) {
        qrHtml += '<td style="';
        qrHtml += " border-width: 0px; border-style: none;";
        qrHtml += " border-collapse: collapse;";
        qrHtml += " padding: 0px; margin: 0px;";
        qrHtml += " width: " + cellSize + "px;";
        qrHtml += " height: " + cellSize + "px;";
        qrHtml += " background-color: ";
        qrHtml += _this.isDark(r, c) ? "#000000" : "#ffffff";
        qrHtml += ";";
        qrHtml += '"/>';
      }
      qrHtml += "</tr>";
    }
    qrHtml += "</tbody>";
    qrHtml += "</table>";
    return qrHtml;
  };
  _this.createSvgTag = function(cellSize, margin, alt, title) {
    let opts = {};
    if (typeof arguments[0] == "object") {
      opts = arguments[0];
      cellSize = opts.cellSize;
      margin = opts.margin;
      alt = opts.alt;
      title = opts.title;
    }
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    alt = typeof alt === "string" ? { text: alt } : alt || {};
    alt.text = alt.text || null;
    alt.id = alt.text ? alt.id || "qrcode-description" : null;
    title = typeof title === "string" ? { text: title } : title || {};
    title.text = title.text || null;
    title.id = title.text ? title.id || "qrcode-title" : null;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    let c, mc, r, mr, qrSvg = "", rect;
    rect = "l" + cellSize + ",0 0," + cellSize + " -" + cellSize + ",0 0,-" + cellSize + "z ";
    qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
    qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : "";
    qrSvg += ' viewBox="0 0 ' + size + " " + size + '" ';
    qrSvg += ' preserveAspectRatio="xMinYMin meet"';
    qrSvg += title.text || alt.text ? ' role="img" aria-labelledby="' + escapeXml([title.id, alt.id].join(" ").trim()) + '"' : "";
    qrSvg += ">";
    qrSvg += title.text ? '<title id="' + escapeXml(title.id) + '">' + escapeXml(title.text) + "</title>" : "";
    qrSvg += alt.text ? '<description id="' + escapeXml(alt.id) + '">' + escapeXml(alt.text) + "</description>" : "";
    qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
    qrSvg += '<path d="';
    for (r = 0; r < _this.getModuleCount(); r += 1) {
      mr = r * cellSize + margin;
      for (c = 0; c < _this.getModuleCount(); c += 1) {
        if (_this.isDark(r, c)) {
          mc = c * cellSize + margin;
          qrSvg += "M" + mc + "," + mr + rect;
        }
      }
    }
    qrSvg += '" stroke="transparent" fill="black"/>';
    qrSvg += "</svg>";
    return qrSvg;
  };
  _this.createDataURL = function(cellSize, margin) {
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    const min = margin;
    const max = size - margin;
    return createDataURL(size, size, function(x, y) {
      if (min <= x && x < max && min <= y && y < max) {
        const c = Math.floor((x - min) / cellSize);
        const r = Math.floor((y - min) / cellSize);
        return _this.isDark(r, c) ? 0 : 1;
      } else {
        return 1;
      }
    });
  };
  _this.createImgTag = function(cellSize, margin, alt) {
    cellSize = cellSize || 2;
    margin = typeof margin == "undefined" ? cellSize * 4 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    let img = "";
    img += "<img";
    img += ' src="';
    img += _this.createDataURL(cellSize, margin);
    img += '"';
    img += ' width="';
    img += size;
    img += '"';
    img += ' height="';
    img += size;
    img += '"';
    if (alt) {
      img += ' alt="';
      img += escapeXml(alt);
      img += '"';
    }
    img += "/>";
    return img;
  };
  const escapeXml = function(s) {
    let escaped = "";
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charAt(i);
      switch (c) {
        case "<":
          escaped += "&lt;";
          break;
        case ">":
          escaped += "&gt;";
          break;
        case "&":
          escaped += "&amp;";
          break;
        case '"':
          escaped += "&quot;";
          break;
        default:
          escaped += c;
          break;
      }
    }
    return escaped;
  };
  const _createHalfASCII = function(margin) {
    const cellSize = 1;
    margin = typeof margin == "undefined" ? cellSize * 2 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    const min = margin;
    const max = size - margin;
    let y, x, r1, r2, p;
    const blocks = {
      "\u2588\u2588": "\u2588",
      "\u2588 ": "\u2580",
      " \u2588": "\u2584",
      "  ": " "
    };
    const blocksLastLineNoMargin = {
      "\u2588\u2588": "\u2580",
      "\u2588 ": "\u2580",
      " \u2588": " ",
      "  ": " "
    };
    let ascii = "";
    for (y = 0; y < size; y += 2) {
      r1 = Math.floor((y - min) / cellSize);
      r2 = Math.floor((y + 1 - min) / cellSize);
      for (x = 0; x < size; x += 1) {
        p = "\u2588";
        if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
          p = " ";
        }
        if (min <= x && x < max && min <= y + 1 && y + 1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
          p += " ";
        } else {
          p += "\u2588";
        }
        ascii += margin < 1 && y + 1 >= max ? blocksLastLineNoMargin[p] : blocks[p];
      }
      ascii += "\n";
    }
    if (size % 2 && margin > 0) {
      return ascii.substring(0, ascii.length - size - 1) + Array(size + 1).join("\u2580");
    }
    return ascii.substring(0, ascii.length - 1);
  };
  _this.createASCII = function(cellSize, margin) {
    cellSize = cellSize || 1;
    if (cellSize < 2) {
      return _createHalfASCII(margin);
    }
    cellSize -= 1;
    margin = typeof margin == "undefined" ? cellSize * 2 : margin;
    const size = _this.getModuleCount() * cellSize + margin * 2;
    const min = margin;
    const max = size - margin;
    let y, x, r, p;
    const white = Array(cellSize + 1).join("\u2588\u2588");
    const black = Array(cellSize + 1).join("  ");
    let ascii = "";
    let line = "";
    for (y = 0; y < size; y += 1) {
      r = Math.floor((y - min) / cellSize);
      line = "";
      for (x = 0; x < size; x += 1) {
        p = 1;
        if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
          p = 0;
        }
        line += p ? white : black;
      }
      for (r = 0; r < cellSize; r += 1) {
        ascii += line + "\n";
      }
    }
    return ascii.substring(0, ascii.length - 1);
  };
  _this.renderTo2dContext = function(context, cellSize) {
    cellSize = cellSize || 2;
    const length = _this.getModuleCount();
    for (let row = 0; row < length; row++) {
      for (let col = 0; col < length; col++) {
        context.fillStyle = _this.isDark(row, col) ? "black" : "white";
        context.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
      }
    }
  };
  return _this;
};
qrcode.stringToBytes = function(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    bytes.push(c & 255);
  }
  return bytes;
};
qrcode.createStringToBytes = function(unicodeData, numChars) {
  const unicodeMap = (function() {
    const bin = base64DecodeInputStream(unicodeData);
    const read = function() {
      const b = bin.read();
      if (b == -1) throw "eof";
      return b;
    };
    let count = 0;
    const unicodeMap2 = {};
    while (true) {
      const b0 = bin.read();
      if (b0 == -1) break;
      const b1 = read();
      const b2 = read();
      const b3 = read();
      const k = String.fromCharCode(b0 << 8 | b1);
      const v = b2 << 8 | b3;
      unicodeMap2[k] = v;
      count += 1;
    }
    if (count != numChars) {
      throw count + " != " + numChars;
    }
    return unicodeMap2;
  })();
  const unknownChar = "?".charCodeAt(0);
  return function(s) {
    const bytes = [];
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c < 128) {
        bytes.push(c);
      } else {
        const b = unicodeMap[s.charAt(i)];
        if (typeof b == "number") {
          if ((b & 255) == b) {
            bytes.push(b);
          } else {
            bytes.push(b >>> 8);
            bytes.push(b & 255);
          }
        } else {
          bytes.push(unknownChar);
        }
      }
    }
    return bytes;
  };
};
var QRMode = {
  MODE_NUMBER: 1 << 0,
  MODE_ALPHA_NUM: 1 << 1,
  MODE_8BIT_BYTE: 1 << 2,
  MODE_KANJI: 1 << 3
};
var QRErrorCorrectionLevel = {
  L: 1,
  M: 0,
  Q: 3,
  H: 2
};
var QRMaskPattern = {
  PATTERN000: 0,
  PATTERN001: 1,
  PATTERN010: 2,
  PATTERN011: 3,
  PATTERN100: 4,
  PATTERN101: 5,
  PATTERN110: 6,
  PATTERN111: 7
};
var QRUtil = (function() {
  const PATTERN_POSITION_TABLE = [
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58],
    [6, 34, 62],
    [6, 26, 46, 66],
    [6, 26, 48, 70],
    [6, 26, 50, 74],
    [6, 30, 54, 78],
    [6, 30, 56, 82],
    [6, 30, 58, 86],
    [6, 34, 62, 90],
    [6, 28, 50, 72, 94],
    [6, 26, 50, 74, 98],
    [6, 30, 54, 78, 102],
    [6, 28, 54, 80, 106],
    [6, 32, 58, 84, 110],
    [6, 30, 58, 86, 114],
    [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122],
    [6, 30, 54, 78, 102, 126],
    [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134],
    [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150],
    [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158],
    [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166],
    [6, 30, 58, 86, 114, 142, 170]
  ];
  const G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
  const G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
  const G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
  const _this = {};
  const getBCHDigit = function(data) {
    let digit = 0;
    while (data != 0) {
      digit += 1;
      data >>>= 1;
    }
    return digit;
  };
  _this.getBCHTypeInfo = function(data) {
    let d = data << 10;
    while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
      d ^= G15 << getBCHDigit(d) - getBCHDigit(G15);
    }
    return (data << 10 | d) ^ G15_MASK;
  };
  _this.getBCHTypeNumber = function(data) {
    let d = data << 12;
    while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
      d ^= G18 << getBCHDigit(d) - getBCHDigit(G18);
    }
    return data << 12 | d;
  };
  _this.getPatternPosition = function(typeNumber) {
    return PATTERN_POSITION_TABLE[typeNumber - 1];
  };
  _this.getMaskFunction = function(maskPattern) {
    switch (maskPattern) {
      case QRMaskPattern.PATTERN000:
        return function(i, j) {
          return (i + j) % 2 == 0;
        };
      case QRMaskPattern.PATTERN001:
        return function(i, j) {
          return i % 2 == 0;
        };
      case QRMaskPattern.PATTERN010:
        return function(i, j) {
          return j % 3 == 0;
        };
      case QRMaskPattern.PATTERN011:
        return function(i, j) {
          return (i + j) % 3 == 0;
        };
      case QRMaskPattern.PATTERN100:
        return function(i, j) {
          return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 == 0;
        };
      case QRMaskPattern.PATTERN101:
        return function(i, j) {
          return i * j % 2 + i * j % 3 == 0;
        };
      case QRMaskPattern.PATTERN110:
        return function(i, j) {
          return (i * j % 2 + i * j % 3) % 2 == 0;
        };
      case QRMaskPattern.PATTERN111:
        return function(i, j) {
          return (i * j % 3 + (i + j) % 2) % 2 == 0;
        };
      default:
        throw "bad maskPattern:" + maskPattern;
    }
  };
  _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
    let a = qrPolynomial([1], 0);
    for (let i = 0; i < errorCorrectLength; i += 1) {
      a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0));
    }
    return a;
  };
  _this.getLengthInBits = function(mode, type) {
    if (1 <= type && type < 10) {
      switch (mode) {
        case QRMode.MODE_NUMBER:
          return 10;
        case QRMode.MODE_ALPHA_NUM:
          return 9;
        case QRMode.MODE_8BIT_BYTE:
          return 8;
        case QRMode.MODE_KANJI:
          return 8;
        default:
          throw "mode:" + mode;
      }
    } else if (type < 27) {
      switch (mode) {
        case QRMode.MODE_NUMBER:
          return 12;
        case QRMode.MODE_ALPHA_NUM:
          return 11;
        case QRMode.MODE_8BIT_BYTE:
          return 16;
        case QRMode.MODE_KANJI:
          return 10;
        default:
          throw "mode:" + mode;
      }
    } else if (type < 41) {
      switch (mode) {
        case QRMode.MODE_NUMBER:
          return 14;
        case QRMode.MODE_ALPHA_NUM:
          return 13;
        case QRMode.MODE_8BIT_BYTE:
          return 16;
        case QRMode.MODE_KANJI:
          return 12;
        default:
          throw "mode:" + mode;
      }
    } else {
      throw "type:" + type;
    }
  };
  _this.getLostPoint = function(qrcode2) {
    const moduleCount = qrcode2.getModuleCount();
    let lostPoint = 0;
    for (let row = 0; row < moduleCount; row += 1) {
      for (let col = 0; col < moduleCount; col += 1) {
        let sameCount = 0;
        const dark = qrcode2.isDark(row, col);
        for (let r = -1; r <= 1; r += 1) {
          if (row + r < 0 || moduleCount <= row + r) {
            continue;
          }
          for (let c = -1; c <= 1; c += 1) {
            if (col + c < 0 || moduleCount <= col + c) {
              continue;
            }
            if (r == 0 && c == 0) {
              continue;
            }
            if (dark == qrcode2.isDark(row + r, col + c)) {
              sameCount += 1;
            }
          }
        }
        if (sameCount > 5) {
          lostPoint += 3 + sameCount - 5;
        }
      }
    }
    ;
    for (let row = 0; row < moduleCount - 1; row += 1) {
      for (let col = 0; col < moduleCount - 1; col += 1) {
        let count = 0;
        if (qrcode2.isDark(row, col)) count += 1;
        if (qrcode2.isDark(row + 1, col)) count += 1;
        if (qrcode2.isDark(row, col + 1)) count += 1;
        if (qrcode2.isDark(row + 1, col + 1)) count += 1;
        if (count == 0 || count == 4) {
          lostPoint += 3;
        }
      }
    }
    for (let row = 0; row < moduleCount; row += 1) {
      for (let col = 0; col < moduleCount - 6; col += 1) {
        if (qrcode2.isDark(row, col) && !qrcode2.isDark(row, col + 1) && qrcode2.isDark(row, col + 2) && qrcode2.isDark(row, col + 3) && qrcode2.isDark(row, col + 4) && !qrcode2.isDark(row, col + 5) && qrcode2.isDark(row, col + 6)) {
          lostPoint += 40;
        }
      }
    }
    for (let col = 0; col < moduleCount; col += 1) {
      for (let row = 0; row < moduleCount - 6; row += 1) {
        if (qrcode2.isDark(row, col) && !qrcode2.isDark(row + 1, col) && qrcode2.isDark(row + 2, col) && qrcode2.isDark(row + 3, col) && qrcode2.isDark(row + 4, col) && !qrcode2.isDark(row + 5, col) && qrcode2.isDark(row + 6, col)) {
          lostPoint += 40;
        }
      }
    }
    let darkCount = 0;
    for (let col = 0; col < moduleCount; col += 1) {
      for (let row = 0; row < moduleCount; row += 1) {
        if (qrcode2.isDark(row, col)) {
          darkCount += 1;
        }
      }
    }
    const ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
    lostPoint += ratio * 10;
    return lostPoint;
  };
  return _this;
})();
var QRMath = (function() {
  const EXP_TABLE = new Array(256);
  const LOG_TABLE = new Array(256);
  for (let i = 0; i < 8; i += 1) {
    EXP_TABLE[i] = 1 << i;
  }
  for (let i = 8; i < 256; i += 1) {
    EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
  }
  for (let i = 0; i < 255; i += 1) {
    LOG_TABLE[EXP_TABLE[i]] = i;
  }
  const _this = {};
  _this.glog = function(n) {
    if (n < 1) {
      throw "glog(" + n + ")";
    }
    return LOG_TABLE[n];
  };
  _this.gexp = function(n) {
    while (n < 0) {
      n += 255;
    }
    while (n >= 256) {
      n -= 255;
    }
    return EXP_TABLE[n];
  };
  return _this;
})();
var qrPolynomial = function(num, shift) {
  if (typeof num.length == "undefined") {
    throw num.length + "/" + shift;
  }
  const _num = (function() {
    let offset = 0;
    while (offset < num.length && num[offset] == 0) {
      offset += 1;
    }
    const _num2 = new Array(num.length - offset + shift);
    for (let i = 0; i < num.length - offset; i += 1) {
      _num2[i] = num[i + offset];
    }
    return _num2;
  })();
  const _this = {};
  _this.getAt = function(index) {
    return _num[index];
  };
  _this.getLength = function() {
    return _num.length;
  };
  _this.multiply = function(e) {
    const num2 = new Array(_this.getLength() + e.getLength() - 1);
    for (let i = 0; i < _this.getLength(); i += 1) {
      for (let j = 0; j < e.getLength(); j += 1) {
        num2[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i)) + QRMath.glog(e.getAt(j)));
      }
    }
    return qrPolynomial(num2, 0);
  };
  _this.mod = function(e) {
    if (_this.getLength() - e.getLength() < 0) {
      return _this;
    }
    const ratio = QRMath.glog(_this.getAt(0)) - QRMath.glog(e.getAt(0));
    const num2 = new Array(_this.getLength());
    for (let i = 0; i < _this.getLength(); i += 1) {
      num2[i] = _this.getAt(i);
    }
    for (let i = 0; i < e.getLength(); i += 1) {
      num2[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i)) + ratio);
    }
    return qrPolynomial(num2, 0).mod(e);
  };
  return _this;
};
var QRRSBlock = (function() {
  const RS_BLOCK_TABLE = [
    // L
    // M
    // Q
    // H
    // 1
    [1, 26, 19],
    [1, 26, 16],
    [1, 26, 13],
    [1, 26, 9],
    // 2
    [1, 44, 34],
    [1, 44, 28],
    [1, 44, 22],
    [1, 44, 16],
    // 3
    [1, 70, 55],
    [1, 70, 44],
    [2, 35, 17],
    [2, 35, 13],
    // 4
    [1, 100, 80],
    [2, 50, 32],
    [2, 50, 24],
    [4, 25, 9],
    // 5
    [1, 134, 108],
    [2, 67, 43],
    [2, 33, 15, 2, 34, 16],
    [2, 33, 11, 2, 34, 12],
    // 6
    [2, 86, 68],
    [4, 43, 27],
    [4, 43, 19],
    [4, 43, 15],
    // 7
    [2, 98, 78],
    [4, 49, 31],
    [2, 32, 14, 4, 33, 15],
    [4, 39, 13, 1, 40, 14],
    // 8
    [2, 121, 97],
    [2, 60, 38, 2, 61, 39],
    [4, 40, 18, 2, 41, 19],
    [4, 40, 14, 2, 41, 15],
    // 9
    [2, 146, 116],
    [3, 58, 36, 2, 59, 37],
    [4, 36, 16, 4, 37, 17],
    [4, 36, 12, 4, 37, 13],
    // 10
    [2, 86, 68, 2, 87, 69],
    [4, 69, 43, 1, 70, 44],
    [6, 43, 19, 2, 44, 20],
    [6, 43, 15, 2, 44, 16],
    // 11
    [4, 101, 81],
    [1, 80, 50, 4, 81, 51],
    [4, 50, 22, 4, 51, 23],
    [3, 36, 12, 8, 37, 13],
    // 12
    [2, 116, 92, 2, 117, 93],
    [6, 58, 36, 2, 59, 37],
    [4, 46, 20, 6, 47, 21],
    [7, 42, 14, 4, 43, 15],
    // 13
    [4, 133, 107],
    [8, 59, 37, 1, 60, 38],
    [8, 44, 20, 4, 45, 21],
    [12, 33, 11, 4, 34, 12],
    // 14
    [3, 145, 115, 1, 146, 116],
    [4, 64, 40, 5, 65, 41],
    [11, 36, 16, 5, 37, 17],
    [11, 36, 12, 5, 37, 13],
    // 15
    [5, 109, 87, 1, 110, 88],
    [5, 65, 41, 5, 66, 42],
    [5, 54, 24, 7, 55, 25],
    [11, 36, 12, 7, 37, 13],
    // 16
    [5, 122, 98, 1, 123, 99],
    [7, 73, 45, 3, 74, 46],
    [15, 43, 19, 2, 44, 20],
    [3, 45, 15, 13, 46, 16],
    // 17
    [1, 135, 107, 5, 136, 108],
    [10, 74, 46, 1, 75, 47],
    [1, 50, 22, 15, 51, 23],
    [2, 42, 14, 17, 43, 15],
    // 18
    [5, 150, 120, 1, 151, 121],
    [9, 69, 43, 4, 70, 44],
    [17, 50, 22, 1, 51, 23],
    [2, 42, 14, 19, 43, 15],
    // 19
    [3, 141, 113, 4, 142, 114],
    [3, 70, 44, 11, 71, 45],
    [17, 47, 21, 4, 48, 22],
    [9, 39, 13, 16, 40, 14],
    // 20
    [3, 135, 107, 5, 136, 108],
    [3, 67, 41, 13, 68, 42],
    [15, 54, 24, 5, 55, 25],
    [15, 43, 15, 10, 44, 16],
    // 21
    [4, 144, 116, 4, 145, 117],
    [17, 68, 42],
    [17, 50, 22, 6, 51, 23],
    [19, 46, 16, 6, 47, 17],
    // 22
    [2, 139, 111, 7, 140, 112],
    [17, 74, 46],
    [7, 54, 24, 16, 55, 25],
    [34, 37, 13],
    // 23
    [4, 151, 121, 5, 152, 122],
    [4, 75, 47, 14, 76, 48],
    [11, 54, 24, 14, 55, 25],
    [16, 45, 15, 14, 46, 16],
    // 24
    [6, 147, 117, 4, 148, 118],
    [6, 73, 45, 14, 74, 46],
    [11, 54, 24, 16, 55, 25],
    [30, 46, 16, 2, 47, 17],
    // 25
    [8, 132, 106, 4, 133, 107],
    [8, 75, 47, 13, 76, 48],
    [7, 54, 24, 22, 55, 25],
    [22, 45, 15, 13, 46, 16],
    // 26
    [10, 142, 114, 2, 143, 115],
    [19, 74, 46, 4, 75, 47],
    [28, 50, 22, 6, 51, 23],
    [33, 46, 16, 4, 47, 17],
    // 27
    [8, 152, 122, 4, 153, 123],
    [22, 73, 45, 3, 74, 46],
    [8, 53, 23, 26, 54, 24],
    [12, 45, 15, 28, 46, 16],
    // 28
    [3, 147, 117, 10, 148, 118],
    [3, 73, 45, 23, 74, 46],
    [4, 54, 24, 31, 55, 25],
    [11, 45, 15, 31, 46, 16],
    // 29
    [7, 146, 116, 7, 147, 117],
    [21, 73, 45, 7, 74, 46],
    [1, 53, 23, 37, 54, 24],
    [19, 45, 15, 26, 46, 16],
    // 30
    [5, 145, 115, 10, 146, 116],
    [19, 75, 47, 10, 76, 48],
    [15, 54, 24, 25, 55, 25],
    [23, 45, 15, 25, 46, 16],
    // 31
    [13, 145, 115, 3, 146, 116],
    [2, 74, 46, 29, 75, 47],
    [42, 54, 24, 1, 55, 25],
    [23, 45, 15, 28, 46, 16],
    // 32
    [17, 145, 115],
    [10, 74, 46, 23, 75, 47],
    [10, 54, 24, 35, 55, 25],
    [19, 45, 15, 35, 46, 16],
    // 33
    [17, 145, 115, 1, 146, 116],
    [14, 74, 46, 21, 75, 47],
    [29, 54, 24, 19, 55, 25],
    [11, 45, 15, 46, 46, 16],
    // 34
    [13, 145, 115, 6, 146, 116],
    [14, 74, 46, 23, 75, 47],
    [44, 54, 24, 7, 55, 25],
    [59, 46, 16, 1, 47, 17],
    // 35
    [12, 151, 121, 7, 152, 122],
    [12, 75, 47, 26, 76, 48],
    [39, 54, 24, 14, 55, 25],
    [22, 45, 15, 41, 46, 16],
    // 36
    [6, 151, 121, 14, 152, 122],
    [6, 75, 47, 34, 76, 48],
    [46, 54, 24, 10, 55, 25],
    [2, 45, 15, 64, 46, 16],
    // 37
    [17, 152, 122, 4, 153, 123],
    [29, 74, 46, 14, 75, 47],
    [49, 54, 24, 10, 55, 25],
    [24, 45, 15, 46, 46, 16],
    // 38
    [4, 152, 122, 18, 153, 123],
    [13, 74, 46, 32, 75, 47],
    [48, 54, 24, 14, 55, 25],
    [42, 45, 15, 32, 46, 16],
    // 39
    [20, 147, 117, 4, 148, 118],
    [40, 75, 47, 7, 76, 48],
    [43, 54, 24, 22, 55, 25],
    [10, 45, 15, 67, 46, 16],
    // 40
    [19, 148, 118, 6, 149, 119],
    [18, 75, 47, 31, 76, 48],
    [34, 54, 24, 34, 55, 25],
    [20, 45, 15, 61, 46, 16]
  ];
  const qrRSBlock = function(totalCount, dataCount) {
    const _this2 = {};
    _this2.totalCount = totalCount;
    _this2.dataCount = dataCount;
    return _this2;
  };
  const _this = {};
  const getRsBlockTable = function(typeNumber, errorCorrectionLevel) {
    switch (errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H:
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default:
        return void 0;
    }
  };
  _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {
    const rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);
    if (typeof rsBlock == "undefined") {
      throw "bad rs block @ typeNumber:" + typeNumber + "/errorCorrectionLevel:" + errorCorrectionLevel;
    }
    const length = rsBlock.length / 3;
    const list = [];
    for (let i = 0; i < length; i += 1) {
      const count = rsBlock[i * 3 + 0];
      const totalCount = rsBlock[i * 3 + 1];
      const dataCount = rsBlock[i * 3 + 2];
      for (let j = 0; j < count; j += 1) {
        list.push(qrRSBlock(totalCount, dataCount));
      }
    }
    return list;
  };
  return _this;
})();
var qrBitBuffer = function() {
  const _buffer = [];
  let _length = 0;
  const _this = {};
  _this.getBuffer = function() {
    return _buffer;
  };
  _this.getAt = function(index) {
    const bufIndex = Math.floor(index / 8);
    return (_buffer[bufIndex] >>> 7 - index % 8 & 1) == 1;
  };
  _this.put = function(num, length) {
    for (let i = 0; i < length; i += 1) {
      _this.putBit((num >>> length - i - 1 & 1) == 1);
    }
  };
  _this.getLengthInBits = function() {
    return _length;
  };
  _this.putBit = function(bit) {
    const bufIndex = Math.floor(_length / 8);
    if (_buffer.length <= bufIndex) {
      _buffer.push(0);
    }
    if (bit) {
      _buffer[bufIndex] |= 128 >>> _length % 8;
    }
    _length += 1;
  };
  return _this;
};
var qrNumber = function(data) {
  const _mode = QRMode.MODE_NUMBER;
  const _data = data;
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return _data.length;
  };
  _this.write = function(buffer) {
    const data2 = _data;
    let i = 0;
    while (i + 2 < data2.length) {
      buffer.put(strToNum(data2.substring(i, i + 3)), 10);
      i += 3;
    }
    if (i < data2.length) {
      if (data2.length - i == 1) {
        buffer.put(strToNum(data2.substring(i, i + 1)), 4);
      } else if (data2.length - i == 2) {
        buffer.put(strToNum(data2.substring(i, i + 2)), 7);
      }
    }
  };
  const strToNum = function(s) {
    let num = 0;
    for (let i = 0; i < s.length; i += 1) {
      num = num * 10 + chatToNum(s.charAt(i));
    }
    return num;
  };
  const chatToNum = function(c) {
    if ("0" <= c && c <= "9") {
      return c.charCodeAt(0) - "0".charCodeAt(0);
    }
    throw "illegal char :" + c;
  };
  return _this;
};
var qrAlphaNum = function(data) {
  const _mode = QRMode.MODE_ALPHA_NUM;
  const _data = data;
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return _data.length;
  };
  _this.write = function(buffer) {
    const s = _data;
    let i = 0;
    while (i + 1 < s.length) {
      buffer.put(
        getCode(s.charAt(i)) * 45 + getCode(s.charAt(i + 1)),
        11
      );
      i += 2;
    }
    if (i < s.length) {
      buffer.put(getCode(s.charAt(i)), 6);
    }
  };
  const getCode = function(c) {
    if ("0" <= c && c <= "9") {
      return c.charCodeAt(0) - "0".charCodeAt(0);
    } else if ("A" <= c && c <= "Z") {
      return c.charCodeAt(0) - "A".charCodeAt(0) + 10;
    } else {
      switch (c) {
        case " ":
          return 36;
        case "$":
          return 37;
        case "%":
          return 38;
        case "*":
          return 39;
        case "+":
          return 40;
        case "-":
          return 41;
        case ".":
          return 42;
        case "/":
          return 43;
        case ":":
          return 44;
        default:
          throw "illegal char :" + c;
      }
    }
  };
  return _this;
};
var qr8BitByte = function(data) {
  const _mode = QRMode.MODE_8BIT_BYTE;
  const _data = data;
  const _bytes = qrcode.stringToBytes(data);
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return _bytes.length;
  };
  _this.write = function(buffer) {
    for (let i = 0; i < _bytes.length; i += 1) {
      buffer.put(_bytes[i], 8);
    }
  };
  return _this;
};
var qrKanji = function(data) {
  const _mode = QRMode.MODE_KANJI;
  const _data = data;
  const stringToBytes2 = qrcode.stringToBytes;
  !(function(c, code) {
    const test = stringToBytes2(c);
    if (test.length != 2 || (test[0] << 8 | test[1]) != code) {
      throw "sjis not supported.";
    }
  })("\u53CB", 38726);
  const _bytes = stringToBytes2(data);
  const _this = {};
  _this.getMode = function() {
    return _mode;
  };
  _this.getLength = function(buffer) {
    return ~~(_bytes.length / 2);
  };
  _this.write = function(buffer) {
    const data2 = _bytes;
    let i = 0;
    while (i + 1 < data2.length) {
      let c = (255 & data2[i]) << 8 | 255 & data2[i + 1];
      if (33088 <= c && c <= 40956) {
        c -= 33088;
      } else if (57408 <= c && c <= 60351) {
        c -= 49472;
      } else {
        throw "illegal char at " + (i + 1) + "/" + c;
      }
      c = (c >>> 8 & 255) * 192 + (c & 255);
      buffer.put(c, 13);
      i += 2;
    }
    if (i < data2.length) {
      throw "illegal char at " + (i + 1);
    }
  };
  return _this;
};
var byteArrayOutputStream = function() {
  const _bytes = [];
  const _this = {};
  _this.writeByte = function(b) {
    _bytes.push(b & 255);
  };
  _this.writeShort = function(i) {
    _this.writeByte(i);
    _this.writeByte(i >>> 8);
  };
  _this.writeBytes = function(b, off, len) {
    off = off || 0;
    len = len || b.length;
    for (let i = 0; i < len; i += 1) {
      _this.writeByte(b[i + off]);
    }
  };
  _this.writeString = function(s) {
    for (let i = 0; i < s.length; i += 1) {
      _this.writeByte(s.charCodeAt(i));
    }
  };
  _this.toByteArray = function() {
    return _bytes;
  };
  _this.toString = function() {
    let s = "";
    s += "[";
    for (let i = 0; i < _bytes.length; i += 1) {
      if (i > 0) {
        s += ",";
      }
      s += _bytes[i];
    }
    s += "]";
    return s;
  };
  return _this;
};
var base64EncodeOutputStream = function() {
  let _buffer = 0;
  let _buflen = 0;
  let _length = 0;
  let _base64 = "";
  const _this = {};
  const writeEncoded = function(b) {
    _base64 += String.fromCharCode(encode(b & 63));
  };
  const encode = function(n) {
    if (n < 0) {
      throw "n:" + n;
    } else if (n < 26) {
      return 65 + n;
    } else if (n < 52) {
      return 97 + (n - 26);
    } else if (n < 62) {
      return 48 + (n - 52);
    } else if (n == 62) {
      return 43;
    } else if (n == 63) {
      return 47;
    } else {
      throw "n:" + n;
    }
  };
  _this.writeByte = function(n) {
    _buffer = _buffer << 8 | n & 255;
    _buflen += 8;
    _length += 1;
    while (_buflen >= 6) {
      writeEncoded(_buffer >>> _buflen - 6);
      _buflen -= 6;
    }
  };
  _this.flush = function() {
    if (_buflen > 0) {
      writeEncoded(_buffer << 6 - _buflen);
      _buffer = 0;
      _buflen = 0;
    }
    if (_length % 3 != 0) {
      const padlen = 3 - _length % 3;
      for (let i = 0; i < padlen; i += 1) {
        _base64 += "=";
      }
    }
  };
  _this.toString = function() {
    return _base64;
  };
  return _this;
};
var base64DecodeInputStream = function(str) {
  const _str = str;
  let _pos = 0;
  let _buffer = 0;
  let _buflen = 0;
  const _this = {};
  _this.read = function() {
    while (_buflen < 8) {
      if (_pos >= _str.length) {
        if (_buflen == 0) {
          return -1;
        }
        throw "unexpected end of file./" + _buflen;
      }
      const c = _str.charAt(_pos);
      _pos += 1;
      if (c == "=") {
        _buflen = 0;
        return -1;
      } else if (c.match(/^\s$/)) {
        continue;
      }
      _buffer = _buffer << 6 | decode(c.charCodeAt(0));
      _buflen += 6;
    }
    const n = _buffer >>> _buflen - 8 & 255;
    _buflen -= 8;
    return n;
  };
  const decode = function(c) {
    if (65 <= c && c <= 90) {
      return c - 65;
    } else if (97 <= c && c <= 122) {
      return c - 97 + 26;
    } else if (48 <= c && c <= 57) {
      return c - 48 + 52;
    } else if (c == 43) {
      return 62;
    } else if (c == 47) {
      return 63;
    } else {
      throw "c:" + c;
    }
  };
  return _this;
};
var gifImage = function(width, height) {
  const _width = width;
  const _height = height;
  const _data = new Array(width * height);
  const _this = {};
  _this.setPixel = function(x, y, pixel) {
    _data[y * _width + x] = pixel;
  };
  _this.write = function(out) {
    out.writeString("GIF87a");
    out.writeShort(_width);
    out.writeShort(_height);
    out.writeByte(128);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(0);
    out.writeByte(255);
    out.writeByte(255);
    out.writeByte(255);
    out.writeString(",");
    out.writeShort(0);
    out.writeShort(0);
    out.writeShort(_width);
    out.writeShort(_height);
    out.writeByte(0);
    const lzwMinCodeSize = 2;
    const raster = getLZWRaster(lzwMinCodeSize);
    out.writeByte(lzwMinCodeSize);
    let offset = 0;
    while (raster.length - offset > 255) {
      out.writeByte(255);
      out.writeBytes(raster, offset, 255);
      offset += 255;
    }
    out.writeByte(raster.length - offset);
    out.writeBytes(raster, offset, raster.length - offset);
    out.writeByte(0);
    out.writeString(";");
  };
  const bitOutputStream = function(out) {
    const _out = out;
    let _bitLength = 0;
    let _bitBuffer = 0;
    const _this2 = {};
    _this2.write = function(data, length) {
      if (data >>> length != 0) {
        throw "length over";
      }
      while (_bitLength + length >= 8) {
        _out.writeByte(255 & (data << _bitLength | _bitBuffer));
        length -= 8 - _bitLength;
        data >>>= 8 - _bitLength;
        _bitBuffer = 0;
        _bitLength = 0;
      }
      _bitBuffer = data << _bitLength | _bitBuffer;
      _bitLength = _bitLength + length;
    };
    _this2.flush = function() {
      if (_bitLength > 0) {
        _out.writeByte(_bitBuffer);
      }
    };
    return _this2;
  };
  const getLZWRaster = function(lzwMinCodeSize) {
    const clearCode = 1 << lzwMinCodeSize;
    const endCode = (1 << lzwMinCodeSize) + 1;
    let bitLength = lzwMinCodeSize + 1;
    const table = lzwTable();
    for (let i = 0; i < clearCode; i += 1) {
      table.add(String.fromCharCode(i));
    }
    table.add(String.fromCharCode(clearCode));
    table.add(String.fromCharCode(endCode));
    const byteOut = byteArrayOutputStream();
    const bitOut = bitOutputStream(byteOut);
    bitOut.write(clearCode, bitLength);
    let dataIndex = 0;
    let s = String.fromCharCode(_data[dataIndex]);
    dataIndex += 1;
    while (dataIndex < _data.length) {
      const c = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;
      if (table.contains(s + c)) {
        s = s + c;
      } else {
        bitOut.write(table.indexOf(s), bitLength);
        if (table.size() < 4095) {
          if (table.size() == 1 << bitLength) {
            bitLength += 1;
          }
          table.add(s + c);
        }
        s = c;
      }
    }
    bitOut.write(table.indexOf(s), bitLength);
    bitOut.write(endCode, bitLength);
    bitOut.flush();
    return byteOut.toByteArray();
  };
  const lzwTable = function() {
    const _map = {};
    let _size = 0;
    const _this2 = {};
    _this2.add = function(key) {
      if (_this2.contains(key)) {
        throw "dup key:" + key;
      }
      _map[key] = _size;
      _size += 1;
    };
    _this2.size = function() {
      return _size;
    };
    _this2.indexOf = function(key) {
      return _map[key];
    };
    _this2.contains = function(key) {
      return typeof _map[key] != "undefined";
    };
    return _this2;
  };
  return _this;
};
var createDataURL = function(width, height, getPixel) {
  const gif = gifImage(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      gif.setPixel(x, y, getPixel(x, y));
    }
  }
  const b = byteArrayOutputStream();
  gif.write(b);
  const base64 = base64EncodeOutputStream();
  const bytes = b.toByteArray();
  for (let i = 0; i < bytes.length; i += 1) {
    base64.writeByte(bytes[i]);
  }
  base64.flush();
  return "data:image/gif;base64," + base64;
};
var qrcode_default = qrcode;
var stringToBytes = qrcode.stringToBytes;

// src/remote/qr.ts
function renderQrSvg(text) {
  const qr = qrcode_default(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ scalable: true });
}

// src/web/routes/request-form.ts
var QR_BLOCK_START = "<!--BLOCK:QR_BLOCK-->";
var QR_BLOCK_END = "<!--/BLOCK:QR_BLOCK-->";
var RAW_QR_SVG_TOKEN = "{{RAW_QR_SVG}}";
function insertQrBlock(html, activeRemoteUrl, requestId) {
  const start = html.indexOf(QR_BLOCK_START);
  const end = html.indexOf(QR_BLOCK_END);
  if (start === -1 || end === -1) return html;
  if (!activeRemoteUrl) {
    return html.slice(0, start) + html.slice(end + QR_BLOCK_END.length);
  }
  const blockContent = html.slice(start + QR_BLOCK_START.length, end);
  const svg = renderQrSvg(`${activeRemoteUrl}/r/${requestId}`);
  const filled = blockContent.replace(RAW_QR_SVG_TOKEN, () => svg);
  return html.slice(0, start) + filled + html.slice(end + QR_BLOCK_END.length);
}
async function renderForm2(res, record, opts = {}) {
  const detections = await detectAll();
  const config = loadConfig();
  const scope = opts.selectedScope ?? record.scope ?? "project";
  const requested = opts.selectedDepositoryId ?? record.depository;
  const options = buildDepositoryOptions(detections, {
    usage: record.usage,
    sticky: config.defaultDepository,
    requested
  });
  const entries = listSecrets({ scope: "all", cwd: process.cwd() });
  const nameRows = record.names.map((name) => {
    const existing = entries.find((e) => e.name === name && e.scope === scope) ?? entries.find((e) => e.name === name);
    return {
      NAME: name,
      DESCRIPTION: existing?.description ?? "",
      USAGE: record.usage ?? "interactive",
      ROTATE_NOTE: existing ? `${name} already exists and will be rotated.` : ""
    };
  });
  let html = request_form_default;
  html = renderTemplate(html, {
    ID: record.id,
    REASON: record.reason ?? "",
    SCOPE_PROJECT_SELECTED: scope === "project" ? "selected" : "",
    SCOPE_GLOBAL_SELECTED: scope === "global" ? "selected" : "",
    ROTATE_CHECKED: opts.rotateChecked ?? record.rotate ? "checked" : ""
  });
  html = renderRepeatingBlock(html, "NAME_ROW", nameRows);
  html = renderRepeatingBlock(
    html,
    "DEP_OPTION",
    options.map((o) => ({ DEP_ID: o.id, DEP_LABEL: o.label, DEP_SELECTED: o.selected ? "selected" : "" }))
  );
  html = renderRepeatingBlock(html, "ERROR_BLOCK", opts.errorMessage ? [{ ERROR_MESSAGE: opts.errorMessage }] : []);
  const confirmRows = opts.confirmDepository ? [{ CONFIRM_DEPOSITORY: opts.confirmDepository }] : [];
  html = renderRepeatingBlock(html, "CONFIRM_BLOCK", confirmRows);
  html = renderRepeatingBlock(html, "CONFIRM_CHECKBOX", confirmRows);
  html = insertQrBlock(html, getActiveRemoteUrl(record.id), record.id);
  sendHtml(res, opts.status ?? 200, html);
}
async function handleRequestFormGet(res, id) {
  const record = RequestStore.get(id);
  if (!record || record.kind !== "request") {
    sendErrorPage(res, 404, "Not found", "This link is unknown or has expired.");
    return;
  }
  if (record.usedAt !== void 0) {
    sendErrorPage(res, 410, "Already used", "This link has already been used.");
    return;
  }
  await renderForm2(res, record);
}
async function handleRequestFormPost(req, res, id) {
  const record = RequestStore.get(id);
  if (!record || record.kind !== "request") {
    sendErrorPage(res, 404, "Not found", "This link is unknown or has expired.");
    return;
  }
  if (record.usedAt !== void 0) {
    sendErrorPage(res, 410, "Already used", "This link has already been used.");
    return;
  }
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      sendErrorPage(res, 413, "Payload too large", "The submission is too large.");
      return;
    }
    sendErrorPage(res, 400, "Bad request", "Could not read the submission.");
    return;
  }
  let submission;
  try {
    submission = parseSubmission(req.headers["content-type"], body, record.names);
  } catch {
    sendErrorPage(res, 400, "Bad request", "Could not parse the submission.");
    return;
  }
  const chosenDepository = submission.depository;
  const scope = submission.scope ?? record.scope ?? "project";
  if (!chosenDepository) {
    await renderForm2(res, record, { errorMessage: "Choose a depository.", selectedScope: scope, rotateChecked: submission.rotate });
    return;
  }
  const detections = await detectAll();
  if (needsAvailabilityConfirmation(detections, chosenDepository) && !submission.confirmCreateVault) {
    await renderForm2(res, record, {
      confirmDepository: chosenDepository,
      selectedDepositoryId: chosenDepository,
      selectedScope: scope,
      rotateChecked: submission.rotate
    });
    return;
  }
  const marked = RequestStore.tryMarkUsed(id);
  if (!marked) {
    sendErrorPage(res, 410, "Already used", "This link has already been used.");
    return;
  }
  const results = [];
  for (const name of record.names) {
    const value = submission.values[name];
    if (!value) {
      results.push({ name, ok: false, errorCode: "E_MISSING_VALUE" });
      continue;
    }
    try {
      await setSecret({
        name,
        value,
        scope,
        depository: chosenDepository,
        cwd: process.cwd(),
        rotate: submission.rotate,
        actor: "user",
        createVault: submission.confirmCreateVault
      });
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, errorCode: err instanceof EnigmaError ? err.code : "E_UNKNOWN" });
    }
  }
  RequestStore.fulfill(id, results);
  let html = request_done_default;
  html = renderRepeatingBlock(
    html,
    "RESULT_ROW",
    results.map((r) => ({
      NAME: r.name,
      STATUS_CLASS: r.ok ? "ok" : "fail",
      STATUS_TEXT: r.ok ? "stored" : `failed (${r.errorCode})`
    }))
  );
  sendHtml(res, 200, html);
}

// src/web/routes/reveal.ts
function handleRevealGet(res, id) {
  const record = RequestStore.get(id);
  if (!record || record.kind !== "reveal") {
    sendErrorPage(res, 404, "Not found", "This link is unknown or has expired.");
    return;
  }
  if (record.usedAt !== void 0) {
    sendErrorPage(res, 410, "Already used", "This link has already been used.");
    return;
  }
  const [name] = record.names;
  const html = renderTemplate(reveal_shell_default, { ID: record.id, NAME: name ?? "" });
  sendHtml(res, 200, html);
}
async function handleRevealPost(res, id) {
  const record = RequestStore.get(id);
  if (!record || record.kind !== "reveal") {
    sendErrorPage(res, 404, "Not found", "This link is unknown or has expired.");
    return;
  }
  const marked = RequestStore.tryMarkUsed(id);
  if (!marked) {
    sendErrorPage(res, 410, "Already used", "This link has already been used.");
    return;
  }
  RequestStore.fulfill(id);
  const [name] = marked.names;
  if (!name) {
    sendErrorPage(res, 404, "Not found", "This link is unknown or has expired.");
    return;
  }
  try {
    const value = await resolveSecret(name, { scope: marked.scope, cwd: process.cwd(), actor: "user", auditOp: "reveal" });
    sendJson(res, 200, { name, value });
  } catch (err) {
    if (err instanceof EnigmaError && err.code === "E_NOT_FOUND") {
      sendErrorPage(res, 404, "Not found", "This secret no longer exists.");
      return;
    }
    sendErrorPage(res, 500, "Internal error", "Could not reveal this secret.");
  }
}

// src/web/static/reveal-script.ts
var REVEAL_CLIENT_JS = `(() => {
  const btn = document.getElementById('revealBtn');
  const box = document.getElementById('valueBox');
  const status = document.getElementById('status');
  if (!btn || !box || !status) return;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = 'Revealing...';
    const id = btn.getAttribute('data-id');
    try {
      const resp = await fetch('/v/' + encodeURIComponent(id) + '/reveal', { method: 'POST' });
      if (resp.status === 410) {
        status.textContent = 'This link has already been used.';
        return;
      }
      if (resp.status === 404) {
        status.textContent = 'This link has expired.';
        return;
      }
      if (!resp.ok) {
        status.textContent = 'Something went wrong.';
        return;
      }
      const data = await resp.json();
      box.textContent = data.value;
      box.hidden = false;
      status.textContent = 'Hides again in 60s.';
      setTimeout(() => {
        box.textContent = '';
        box.hidden = true;
        status.textContent = 'Hidden.';
      }, 60000);
    } catch (err) {
      status.textContent = 'Network error.';
    }
  });
})();
`;

// src/web/router.ts
var ID = "[0-9a-f]{32}";
var REQUEST_PATH = new RegExp(`^/r/(${ID})$`);
var IMPORT_PATH = new RegExp(`^/i/(${ID})$`);
var REVEAL_SHELL_PATH = new RegExp(`^/v/(${ID})$`);
var REVEAL_ACTION_PATH = new RegExp(`^/v/(${ID})/reveal$`);
async function handleRequest(req, res) {
  applySecurityHeaders(res);
  const method = req.method ?? "GET";
  let pathname;
  try {
    pathname = new URL(req.url ?? "/", "http://internal").pathname;
  } catch {
    sendErrorPage(res, 400, "Bad request", "Malformed URL.");
    return;
  }
  try {
    if (method === "GET" && pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === "GET" && pathname === "/static/reveal.js") {
      sendStaticJs(res, REVEAL_CLIENT_JS);
      return;
    }
    const requestMatch = pathname.match(REQUEST_PATH);
    if (requestMatch) {
      const id = requestMatch[1];
      if (method === "GET") return await handleRequestFormGet(res, id);
      if (method === "POST") return await handleRequestFormPost(req, res, id);
    }
    const importMatch = pathname.match(IMPORT_PATH);
    if (importMatch) {
      const id = importMatch[1];
      if (method === "GET") return await handleImportFormGet(res, id);
      if (method === "POST") return await handleImportFormPost(req, res, id);
    }
    const revealShellMatch = pathname.match(REVEAL_SHELL_PATH);
    if (revealShellMatch && method === "GET") {
      return handleRevealGet(res, revealShellMatch[1]);
    }
    const revealActionMatch = pathname.match(REVEAL_ACTION_PATH);
    if (revealActionMatch && method === "POST") {
      return await handleRevealPost(res, revealActionMatch[1]);
    }
    sendErrorPage(res, 404, "Not found", "Nothing lives at this address.");
  } catch {
    sendErrorPage(res, 500, "Internal error", "Something went wrong.");
  }
}

// src/web/server.ts
var DEFAULT_HOST = "127.0.0.1";
var DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1e3;
var state;
var starting;
function settled(value) {
  return new Promise((resolve2) => resolve2(value));
}
function toHandle(s) {
  return { port: s.port, origin: `http://${s.host}:${s.port}`, close: stopServer };
}
function resetIdleTimer(s) {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    void stopServer();
  }, s.idleTimeoutMs);
  s.idleTimer.unref();
}
function startServer(opts = {}) {
  if (state) {
    resetIdleTimer(state);
    return settled(toHandle(state));
  }
  if (starting) return starting;
  const host = opts.host ?? DEFAULT_HOST;
  const policy = decideInsecureHttpPolicy(host, opts.allowInsecureHttp ?? false);
  if (!policy.allow) {
    return new Promise(
      (_resolve, reject) => reject(new Error(`refusing to bind ${host} over plain HTTP; pass allowInsecureHttp to override (ADR-005)`))
    );
  }
  starting = new Promise((resolve2, reject) => {
    const server = http.createServer((req, res) => {
      if (state) resetIdleTimer(state);
      void handleRequest(req, res);
    });
    server.on("error", (err) => {
      starting = void 0;
      reject(err);
    });
    server.listen(0, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      const newState = { server, port, host, idleTimeoutMs: opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS };
      state = newState;
      resetIdleTimer(newState);
      starting = void 0;
      resolve2(toHandle(newState));
    });
  });
  return starting;
}
function stopServer() {
  const current = state;
  if (!current) return settled(void 0);
  state = void 0;
  if (current.idleTimer) clearTimeout(current.idleTimer);
  return new Promise((resolve2) => current.server.close(() => resolve2()));
}

// src/cli/commands/import.ts
var USAGE3 = "enigma import [PATH] [--depository ID] [--json]";
function report(data, json, cwd, note) {
  if (json) {
    process.stdout.write(`${JSON.stringify(data)}
`);
  } else {
    const lines = [];
    if (note) lines.push(note);
    if (data.imported.length > 0 || data.failed.length > 0) {
      const results = [
        ...data.failed.map((f) => ({ name: f.name, ok: false, errorCode: f.errorCode })),
        ...data.imported.map((name) => ({ name, ok: true }))
      ];
      lines.push(renderOutcome(results, cwd).text);
    }
    for (const f of data.failed) if (f.message) lines.push(`${f.name}: ${f.message}`);
    for (const name of data.notAttempted) lines.push(`${name}: not attempted (aborted after an earlier failure)`);
    for (const name of data.skippedInvalid) lines.push(`${name}: skipped (invalid secret name)`);
    for (const name of data.skippedMismatch) lines.push(`${name}: migrated, but its .env line was left in place (see warnings)`);
    for (const warning of data.warnings) lines.push(`warning: ${warning}`);
    if (data.failed.length > 0 && !data.fileRewritten) {
      lines.push(".env was left untouched because not every key succeeded.");
    }
    process.stdout.write(`${lines.filter((l) => l.length > 0).join("\n")}
`);
  }
  return data.failed.length > 0 ? 1 : 0;
}
async function runBrowserFlow(entries, opts) {
  const handle = await startServer();
  const record = RequestStore.create({
    kind: "import",
    names: entries.map((e) => e.name),
    values: Object.fromEntries(entries.map((e) => [e.name, e.value])),
    ambiguousNames: entries.filter((e) => e.ambiguous).map((e) => e.name),
    ambiguousReasons: Object.fromEntries(entries.filter((e) => e.ambiguous && e.ambiguousReason).map((e) => [e.name, e.ambiguousReason])),
    scope: "project",
    envFilePath: opts.absPath
  });
  const url = `${handle.origin}/i/${record.id}`;
  process.stderr.write(
    `Open ${url} to choose where to store ${entries.length} secret(s): ${entries.map((e) => e.name).join(", ")}
`
  );
  try {
    await RequestStore.waitForFulfilled(record.id);
  } catch {
    return report(
      {
        imported: [],
        failed: [],
        notAttempted: entries.map((e) => e.name),
        skippedInvalid: opts.skippedInvalid,
        skippedMismatch: [],
        warnings: [],
        fileRewritten: false
      },
      opts.json,
      opts.cwd,
      "Import link expired before it was completed."
    );
  }
  const finalRecord = RequestStore.get(record.id);
  const results = finalRecord?.results ?? [];
  const outcome = finalRecord?.importOutcome;
  return report(
    {
      imported: results.filter((r) => r.ok).map((r) => r.name),
      failed: results.filter((r) => !r.ok && r.errorCode !== "E_NOT_ATTEMPTED").map((r) => ({ name: r.name, errorCode: r.errorCode ?? "E_UNKNOWN" })),
      notAttempted: results.filter((r) => r.errorCode === "E_NOT_ATTEMPTED").map((r) => r.name),
      skippedInvalid: opts.skippedInvalid,
      skippedMismatch: outcome?.skippedMismatch ?? [],
      warnings: outcome?.warnings ?? [],
      fileRewritten: outcome?.fileRewritten ?? false,
      depository: outcome?.depository
    },
    opts.json,
    opts.cwd
  );
}
async function cmdImport(argv) {
  const { positionals, flags } = parseArgs(argv, { value: ["depository"], boolean: ["json"] });
  const pathArg = positionals[0] ?? ".env";
  const depository = flags.depository;
  const json = Boolean(flags.json);
  if (positionals.length > 1) throw new UsageError(USAGE3);
  const cwd = process.cwd();
  const projectPath = findProjectPath(cwd);
  const absPath = isAbsolute(pathArg) ? pathArg : join4(cwd, pathArg);
  if (!existsSync9(absPath)) {
    throw new EnigmaError({ code: "E_NOT_FOUND", message: `${pathArg} not found` });
  }
  const content = readFileSync6(absPath, "utf8");
  const parsed = parseDotEnv(content);
  if (parsed.entries.length === 0) {
    return report(
      {
        imported: [],
        failed: [],
        notAttempted: [],
        skippedInvalid: parsed.invalidNames,
        skippedMismatch: [],
        warnings: [],
        fileRewritten: false
      },
      json,
      cwd,
      "No importable secrets found."
    );
  }
  if (!depository) {
    return runBrowserFlow(parsed.entries, { cwd, absPath, json, skippedInvalid: parsed.invalidNames });
  }
  const result = await commitImport({
    entries: parsed.entries,
    depository,
    scope: "project",
    cwd,
    projectPath,
    envFilePath: absPath,
    actor: "cli"
  });
  return report(
    {
      imported: result.succeeded,
      failed: result.failed,
      notAttempted: result.notAttempted,
      skippedInvalid: parsed.invalidNames,
      skippedMismatch: result.skippedMismatch,
      warnings: result.warnings,
      fileRewritten: result.fileRewritten,
      depository
    },
    json,
    cwd
  );
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
var USAGE4 = "enigma move NAME --to ID [--scope project|global]";
async function cmdMove(argv) {
  const { positionals, flags } = parseArgs(argv, { value: ["to", "scope"] });
  const [name] = positionals;
  const to = flags.to;
  if (!name || typeof to !== "string") throw new UsageError(USAGE4);
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
    await oldModule.create({ projectPath }).delete(entry.ref).catch((err) => {
      process.stderr.write(
        `Warning: failed to delete old copy from ${entry.depository} (ref ${entry.ref}): ${auditErrorText(err)}
`
      );
    });
  }
  appendAuditEvent({ op: "move", name, scope: entry.scope, depository: target, actor: "cli", ok: true, error: null });
  process.stdout.write(`Moved ${name} to ${target} (${entry.scope})
`);
  return 0;
}

// src/cli/commands/remove.ts
var USAGE5 = "enigma remove NAME [--scope project|global]";
async function cmdRemove(argv) {
  const { positionals, flags } = parseArgs(argv, { value: ["scope"] });
  const [name] = positionals;
  if (!name) throw new UsageError(USAGE5);
  const scope = parseScope(flags.scope);
  await deleteSecret(name, { scope, cwd: process.cwd(), actor: "cli" });
  process.stdout.write(`Removed ${name}${scope ? ` (${scope})` : ""}
`);
  return 0;
}

// src/cli/commands/run.ts
import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
var USAGE6 = "enigma run [--only A,B] [--scope project|global] -- <command> [args...]";
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
  if (dashIdx === -1) throw new UsageError(USAGE6);
  const commandArgv = argv.slice(dashIdx + 1);
  if (commandArgv.length === 0) throw new UsageError(USAGE6);
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
var USAGE7 = `Usage: enigma <command> [options]

Commands:
  add NAME [--depository ID] [--scope project|global] [--description TEXT] [--usage interactive|unattended]
  list [--scope project|global|all] [--json]
  remove NAME [--scope project|global]
  move NAME --to ID [--scope project|global]
  run [--only A,B] [--scope project|global] -- <command> [args...]
  get NAME [--scope project|global]
  import [PATH] [--depository ID] [--json]
  doctor [--json]

Not yet implemented: request, reveal, install
`;
var COMMANDS = {
  add: cmdAdd,
  list: cmdList,
  remove: cmdRemove,
  move: cmdMove,
  run: cmdRun,
  get: cmdGet,
  doctor: cmdDoctor,
  import: cmdImport,
  request: notImplemented("request"),
  reveal: notImplemented("reveal"),
  install: notImplemented("install")
};
async function main(argv) {
  const [command, ...rest] = argv;
  if (!command) {
    process.stderr.write(USAGE7);
    return 2;
  }
  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`enigma: unknown command '${command}'
${USAGE7}`);
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
