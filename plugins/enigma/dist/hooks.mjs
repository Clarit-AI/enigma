// src/hooks/stdin.ts
function readStdinJson() {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      if (data.length === 0) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on("error", reject);
  });
}

// src/core/config.ts
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

// src/core/secure-file.ts
import { mkdirSync, appendFileSync, chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

// src/core/errors.ts
var EnigmaError = class _EnigmaError extends Error {
  code;
  secretName;
  depository;
  exitCode;
  constructor(options) {
    super(options.message);
    this.name = "EnigmaError";
    this.code = options.code;
    this.secretName = options.secretName;
    this.depository = options.depository;
    this.exitCode = options.exitCode;
    Object.setPrototypeOf(this, _EnigmaError.prototype);
  }
};

// src/core/secure-file.ts
var FILE_MODE = 384;
var DIR_MODE = 448;
function ensureParentDir(path) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
}
function readJsonFile(path, fallback, corruptErrorCode, corruptDepository) {
  if (!existsSync(path)) return fallback;
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    if (!corruptErrorCode) throw err;
    throw new EnigmaError({
      code: corruptErrorCode,
      message: `${path} is not valid JSON. Fix or remove it by hand, then try again.`,
      depository: corruptDepository
    });
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

// src/core/config.ts
var DEFAULT_CONFIG = {};
var DEFAULT_MANIFEST = { secrets: {} };
function loadConfig() {
  const raw = readJsonFile(configPath(), void 0, "E_CONFIG_CORRUPT");
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
  const raw = readJsonFile(join2(projectPath, ".enigma.json"), void 0, "E_CONFIG_CORRUPT");
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

// src/core/project.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync2, readFileSync as readFileSync2, realpathSync, statSync } from "node:fs";
import { basename, dirname as dirname2, join as join3, resolve } from "node:path";
import * as nodePath from "node:path";
var PROJECT_ID_LENGTH = 16;
function findProjectPath(cwd) {
  let dir = resolve(cwd);
  for (; ; ) {
    if (existsSync2(`${dir}/.git`)) return dir;
    const parent = dirname2(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}
var platformPath = nodePath;
function parseGitdirPointer(content) {
  const firstLine = content.split(/\r?\n/, 1)[0];
  if (firstLine === void 0) return null;
  const match = /^gitdir:(\s*)(\S.*?)?\s*$/.exec(firstLine);
  if (!match) return null;
  return match[2] ?? null;
}
function parseCommondirPointer(content) {
  const firstLine = content.split(/\r?\n/, 1)[0];
  if (firstLine === void 0) return null;
  const trimmed = firstLine.trim();
  return trimmed || null;
}
function resolveGitPointer(baseDir, rawContent, pathImpl = platformPath) {
  const trimmed = rawContent.trim();
  return pathImpl.isAbsolute(trimmed) ? trimmed : pathImpl.resolve(baseDir, trimmed);
}
function gitEntryKind(entryPath) {
  try {
    const st = statSync(entryPath);
    if (st.isDirectory()) return "directory";
    if (st.isFile()) return "file";
    return "missing";
  } catch {
    return "missing";
  }
}
function pathStat(p) {
  try {
    statSync(p);
    return "exists";
  } catch (err) {
    const code = err.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "error";
  }
}
function safeRealpath(p, fallback) {
  try {
    return realpathSync(p);
  } catch {
    return fallback;
  }
}
function readFileSafe(filePath) {
  try {
    return readFileSync2(filePath, "utf8");
  } catch {
    return null;
  }
}
function findRepoIdentityPath(cwd) {
  const worktreeRoot = findProjectPath(cwd);
  const fallback = safeRealpath(worktreeRoot, worktreeRoot);
  try {
    const gitEntryPath = `${worktreeRoot}/.git`;
    const kind = gitEntryKind(gitEntryPath);
    let commonDir;
    if (kind === "directory") {
      commonDir = gitEntryPath;
    } else if (kind === "file") {
      const raw = readFileSafe(gitEntryPath);
      if (raw === null) return fallback;
      const pointer = parseGitdirPointer(raw);
      if (pointer === null) return fallback;
      const gitdir = resolveGitPointer(worktreeRoot, pointer);
      if (pathStat(gitdir) !== "exists") return fallback;
      const commondirFile = join3(gitdir, "commondir");
      const commondirState = pathStat(commondirFile);
      if (commondirState === "exists") {
        const content = readFileSafe(commondirFile);
        if (content === null) return fallback;
        const cdp = parseCommondirPointer(content);
        if (cdp === null) return fallback;
        commonDir = resolveGitPointer(gitdir, cdp);
      } else if (commondirState === "absent") {
        commonDir = gitdir;
      } else {
        return fallback;
      }
    } else {
      return fallback;
    }
    const resolved = safeRealpath(commonDir, fallback);
    return basename(resolved) === ".git" ? dirname2(resolved) : resolved;
  } catch {
    return fallback;
  }
}
function projectId(cwd) {
  const identityPath = findRepoIdentityPath(cwd);
  return createHash("sha256").update(identityPath).digest("hex").slice(0, PROJECT_ID_LENGTH);
}

// src/core/audit.ts
function appendAuditEvent(event) {
  const line = { ts: (/* @__PURE__ */ new Date()).toISOString(), ...event };
  appendLineSecure(auditLogPath(), JSON.stringify(line));
}

// src/core/index-store.ts
var EMPTY_INDEX = { version: 1, entries: [] };
function readIndex() {
  return readJsonFile(indexPath(), EMPTY_INDEX, "E_INDEX_CORRUPT");
}
function sameEntry(entry, name, scope, projectId2) {
  if (entry.name !== name || entry.scope !== scope) return false;
  return scope === "global" ? true : entry.projectId === projectId2;
}
function findIndexEntry(index, name, scope, projectId2) {
  return index.entries.find((e) => sameEntry(e, name, scope, projectId2));
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
import { existsSync as existsSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
var ALGORITHM = "aes-256-gcm";
var KEY_BYTES = 32;
var IV_BYTES = 12;
var FILE_MODE2 = 384;
var EMPTY_SECRETS_FILE = { version: 1, entries: {} };
function readKey() {
  if (!existsSync3(keyPath())) return void 0;
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
  return readJsonFile(secretsPath(), EMPTY_SECRETS_FILE, "E_VAULT_CORRUPT", "encrypted");
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
import { existsSync as existsSync4, readFileSync as readFileSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join4 } from "node:path";
var BEGIN_MARKER = "# enigma:begin";
var END_MARKER = "# enigma:end";
var FILE_MODE3 = 384;
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
  const envFilePath = join4(requireProjectPath(ctx), ".env");
  const readEnvFile = () => existsSync4(envFilePath) ? readFileSync4(envFilePath, "utf8") : "";
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
  return new Promise((resolve3, reject) => {
    execFile(SECRET_TOOL_BIN, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        return;
      }
      resolve3({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}
function runSecretToolWithStdin(args, value) {
  return new Promise((resolve3, reject) => {
    const child = execFile(SECRET_TOOL_BIN, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        return;
      }
      resolve3({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
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
import { existsSync as existsSync5 } from "node:fs";
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
  return new Promise((resolve3, reject) => {
    execFile2(SECURITY_BIN, args, { timeout: EXEC_TIMEOUT_MS2, maxBuffer: EXEC_MAX_BUFFER_BYTES2 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        return;
      }
      resolve3({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}
function runSecurityBatch(line) {
  return new Promise((resolve3, reject) => {
    const child = execFile2(SECURITY_BIN, ["-i"], { timeout: EXEC_TIMEOUT_MS2, maxBuffer: EXEC_MAX_BUFFER_BYTES2 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        return;
      }
      resolve3({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
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
    const available = existsSync5(SECURITY_BIN);
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
import { basename as basename2 } from "node:path";
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
  return new Promise((resolve3, reject) => {
    execFile3(OP_BIN, args, { timeout: EXEC_TIMEOUT_MS3, maxBuffer: EXEC_MAX_BUFFER_BYTES3 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        return;
      }
      resolve3({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}
function runOpWithStdin(args, stdinData) {
  return new Promise((resolve3, reject) => {
    const child = execFile3(OP_BIN, args, { timeout: EXEC_TIMEOUT_MS3, maxBuffer: EXEC_MAX_BUFFER_BYTES3 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") }));
        return;
      }
      resolve3({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
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
  return `${name} \xB7 ${basename2(ctx.projectPath)}`;
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

// src/storage/manager.ts
function listSecrets(opts = {}) {
  const index = readIndex();
  const currentProjectId = opts.cwd ? projectId(opts.cwd) : void 0;
  return listIndexEntries(index, { scope: opts.scope, currentProjectId });
}

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

// src/request/store.ts
import { randomBytes as randomBytes3 } from "node:crypto";
var REQUEST_TTL_MS = 15 * 60 * 1e3;
var REVEAL_TTL_MS = 5 * 60 * 1e3;
var SWEEP_INTERVAL_MS = 60 * 1e3;
var USED_GRACE_MS = 5 * 60 * 1e3;
function deferred() {
  let resolve3;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve3 = res;
    reject = rej;
  });
  return { promise, resolve: resolve3, reject };
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
  /**
   * Reads a fulfilled record's per-name results and marks its outcome as
   * consumed the first time this is called for a given id (Issue #62) — the
   * single choke point `resolveRequestOutcome` (used by enigma_await,
   * enigma_request, and enigma_import) reads through, so
   * `listUnconsumedFulfilled` can tell "the agent already learned this
   * outcome" from "it never did." Idempotent: a second `enigma_await` for
   * the same id still returns the same results (that's the whole point of
   * the idempotent-await recovery path) and leaves `outcomeConsumedAt` at
   * its first value. Returns undefined if the id is unknown or not yet
   * fulfilled — callers already treat that the same as "no results".
   */
  consumeOutcome(id) {
    const record = records.get(id);
    if (!record || record.results === void 0) return void 0;
    if (record.outcomeConsumedAt === void 0) record.outcomeConsumedAt = Date.now();
    return record.results;
  },
  /**
   * Enumerates fulfilled 'request'/'import' records (results are in) whose
   * outcome has never been read via `consumeOutcome` — Issue #62's recovery
   * signal for an `enigma_await`/`enigma_request` call that was interrupted
   * before the agent ever saw the outcome text, even though the secret was
   * stored correctly by the independent web layer. 'reveal' records are
   * excluded: `enigma_reveal` never blocks on `resolveRequestOutcome` (by
   * design — the revealed value goes only to the human), so a fulfilled
   * reveal has nothing pending for the agent to re-await.
   *
   * Returns names and ids only, never values or per-name results (ADR-001)
   * — this is purely "there is an outcome you may not have seen; call
   * enigma_await(id)", not the outcome itself. Reading this list never
   * marks anything consumed, so calling it repeatedly (e.g. from
   * enigma_doctor) cannot make the signal disappear on its own. Bounded by
   * the same in-memory TTL/used-grace sweep as every other record; no new
   * persistence.
   */
  listUnconsumedFulfilled() {
    const out = [];
    for (const record of records.values()) {
      if (record.kind === "reveal") continue;
      if (record.results === void 0) continue;
      if (record.outcomeConsumedAt !== void 0) continue;
      out.push({ id: record.id, names: [...record.names] });
    }
    return out;
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

// src/hooks/session-start.ts
function runSessionStart(input) {
  const cwd = input.cwd ?? process.cwd();
  const projectPath = findProjectPath(cwd);
  const { registeredNames: names, gaps } = computeManifestGaps(cwd);
  const config = loadConfig();
  const manifest = loadProjectManifest(projectPath);
  const stickyDefault = manifest.defaultDepository ?? config.defaultDepository;
  const lines = [
    names.length > 0 ? `Enigma: secrets available for this project (and global): ${names.join(", ")}` : "Enigma: no secrets registered for this project or globally."
  ];
  if (stickyDefault) lines.push(`Enigma: sticky default depository is "${stickyDefault}".`);
  if (gaps.length > 0) {
    lines.push(
      `Enigma: manifest (.enigma.json) declares ${gaps.join(", ")} but no value is stored yet \u2014 call enigma_request to collect them.`
    );
  }
  const pendingRequests = RequestStore.listUnconsumedFulfilled();
  if (pendingRequests.length > 0) {
    const summary = pendingRequests.map((r) => `${r.id} (names: ${r.names.join(", ")})`).join("; ");
    lines.push(
      `Enigma: pending unconfirmed request(s) whose outcome you may not have seen \u2014 ${summary} \u2014 call enigma_await(request_id) to check.`
    );
  }
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: lines.join("\n")
    }
  };
}

// src/hooks/read-guard.ts
import { basename as basename3, resolve as resolve2, sep } from "node:path";
import { existsSync as existsSync6, statSync as statSync2 } from "node:fs";
var DOTENV_EXEMPT = /* @__PURE__ */ new Set([".env.example"]);
var BARE_ENV_DUMP_COMMANDS = /* @__PURE__ */ new Set(["env", "printenv"]);
var NON_READING_BASH_VERBS = /* @__PURE__ */ new Set(["rm", "mv", "touch", "chmod", "stat", "ls", "find", "test"]);
var DOTENV_EXCLUDE_GLOB = "!.env*";
var MAX_SUBSTITUTION_DEPTH = 10;
var USE_INSTEAD = "Use `enigma_request` to collect it from the user, or `enigma run -- <command>` to inject the real value into a child process without it ever entering this session.";
function isDotEnvBasename(name) {
  if (DOTENV_EXEMPT.has(name)) return false;
  return name === ".env" || name.startsWith(".env.");
}
function targetsDotEnv(pathLike) {
  return isDotEnvBasename(basename3(pathLike.trim()));
}
function targetsEnigmaConfig(pathLike, cwd) {
  const home = resolve2(enigmaHome());
  const resolved = resolve2(cwd, pathLike.trim());
  return resolved === home || resolved.startsWith(`${home}${sep}`);
}
function decodeAnsiCEscapes(body) {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|.)/gs, (_whole, esc) => {
    if (esc.startsWith("x")) return String.fromCharCode(parseInt(esc.slice(1), 16));
    if (esc.startsWith("u") || esc.startsWith("U")) return String.fromCodePoint(parseInt(esc.slice(1), 16));
    if (/^[0-7]{1,3}$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    switch (esc) {
      case "n":
        return "\n";
      case "t":
        return "	";
      case "r":
        return "\r";
      case "a":
        return "\x07";
      case "b":
        return "\b";
      case "e":
      case "E":
        return "\x1B";
      case "f":
        return "\f";
      case "v":
        return "\v";
      default:
        return esc;
    }
  });
}
function normalizeShellEscapes(command) {
  const withIfsExpanded = command.replace(/\$\{IFS\}|\$IFS\b/g, " ");
  return withIfsExpanded.replace(/\$'((?:[^'\\]|\\.)*)'/gs, (_whole, body) => {
    const decoded = decodeAnsiCEscapes(body);
    const escaped = decoded.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  });
}
function matchQuoteSpan(text, i) {
  const c = text[i];
  if (c !== '"' && c !== "'") return void 0;
  const close = text.indexOf(c, i + 1);
  return close === -1 ? void 0 : close + 1;
}
function tokenize(segment) {
  const tokens = [];
  let current = "";
  let inWord = false;
  let i = 0;
  while (i < segment.length) {
    const c = segment[i];
    if (c === " " || c === "	" || c === "\n" || c === "\r") {
      if (inWord) {
        tokens.push(current);
        current = "";
        inWord = false;
      }
      i++;
      continue;
    }
    const spanEnd = matchQuoteSpan(segment, i);
    if (spanEnd !== void 0) {
      current += segment.slice(i + 1, spanEnd - 1);
      inWord = true;
      i = spanEnd;
      continue;
    }
    current += c;
    inWord = true;
    i++;
  }
  if (inWord) tokens.push(current);
  return tokens;
}
function matchSeparatorAt(command, i) {
  if (command[i] === "|" && command[i + 1] === "|") return "||";
  if (command[i] === "&" && command[i + 1] === "&") return "&&";
  const c = command[i];
  return c === "|" || c === ";" || c === "&" ? c : void 0;
}
function splitSegments(command) {
  const segments = [];
  let current = "";
  let i = 0;
  while (i < command.length) {
    const spanEnd = matchQuoteSpan(command, i);
    if (spanEnd !== void 0) {
      current += command.slice(i, spanEnd);
      i = spanEnd;
      continue;
    }
    const sep2 = matchSeparatorAt(command, i);
    if (sep2 !== void 0) {
      segments.push(current);
      current = "";
      i += sep2.length;
      continue;
    }
    current += command[i];
    i++;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}
function extractSubstitutions(command) {
  const results = [];
  let i = 0;
  while (i < command.length) {
    if (command[i] === "$" && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command[j] === "(") depth++;
        else if (command[j] === ")") depth--;
        j++;
      }
      if (depth === 0) results.push(command.slice(i + 2, j - 1));
      i = j;
      continue;
    }
    if (command[i] === "`") {
      const end = command.indexOf("`", i + 1);
      if (end === -1) break;
      results.push(command.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    i++;
  }
  return results;
}
function allCommandTexts(command, depth = MAX_SUBSTITUTION_DEPTH) {
  const subs = extractSubstitutions(command);
  if (subs.length === 0) return [command];
  if (depth <= 0) return void 0;
  const nested = subs.map((s) => allCommandTexts(s, depth - 1));
  if (nested.some((n) => n === void 0)) return void 0;
  return [command, ...nested.flatMap((n) => n)];
}
function commandName(token) {
  const parts = token.split("/");
  return parts[parts.length - 1] ?? token;
}
function equalsSuffixes(token) {
  const suffixes = [];
  let idx = token.indexOf("=");
  while (idx !== -1) {
    suffixes.push(token.slice(idx + 1));
    idx = token.indexOf("=", idx + 1);
  }
  return suffixes;
}
function tokenTargetsPath(token, isTarget) {
  if (equalsSuffixes(token).some((suffix) => isTarget(suffix))) return true;
  return !token.startsWith("-") && isTarget(token);
}
function segmentTargetsDotEnvByPath(segment) {
  const [head, ...rest] = tokenize(segment);
  if (head && NON_READING_BASH_VERBS.has(commandName(head))) return false;
  return rest.some((t) => tokenTargetsPath(t, targetsDotEnv));
}
function segmentTargetsEnigmaConfigByPath(segment, cwd) {
  const [head, ...rest] = tokenize(segment);
  if (!head) return false;
  return rest.some((t) => tokenTargetsPath(t, (value) => targetsEnigmaConfig(value, cwd)));
}
function segmentIsBareEnvDump(segment) {
  const [head] = tokenize(segment);
  return head !== void 0 && BARE_ENV_DUMP_COMMANDS.has(commandName(head));
}
function segmentIsEnigmaGetOrEnv(segment) {
  const [head, sub] = tokenize(segment);
  return commandName(head ?? "") === "enigma" && (sub === "get" || sub === "env");
}
function segmentIsKeychainRead(segment) {
  const [head, sub] = tokenize(segment);
  return commandName(head ?? "") === "security" && sub === "find-generic-password";
}
function segmentIsOpRead(segment) {
  const [head, sub] = tokenize(segment);
  return commandName(head ?? "") === "op" && sub === "read";
}
function knownSecretNames() {
  return new Set(readIndex().entries.map((e) => e.name));
}
function segmentEchoesKnownSecret(segment, known) {
  const [head] = tokenize(segment);
  if (commandName(head ?? "") !== "echo") return void 0;
  const matches = [...segment.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g)].map((m) => m[1]);
  return matches.find((name) => name !== void 0 && known.has(name));
}
function stringField(input, key) {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
var PATH_TOOL_FIELDS = {
  Read: ["file_path"],
  Grep: ["path", "glob"],
  Glob: ["path", "pattern"]
};
function isKnownNonDirectoryPath(pathLike, cwd) {
  if (!pathLike) return false;
  try {
    const resolved = resolve2(cwd, pathLike.trim());
    return existsSync6(resolved) && !statSync2(resolved).isDirectory();
  } catch {
    return false;
  }
}
var DOTENV_PROBE_BASENAMES = [".env", ".env.local", ".env.production", ".env.development", ".env.test", ".env.staging"];
function expandBraces(pattern) {
  const match = pattern.match(/\{([^{}]*)\}/);
  if (!match || match.index === void 0) return [pattern];
  const whole = match[0];
  const inner = match[1] ?? "";
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice(match.index + whole.length);
  return inner.split(",").flatMap((option) => expandBraces(`${prefix}${option}${suffix}`));
}
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) {
        out += "\\[";
      } else {
        const body = glob.slice(i + 1, close);
        out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = close;
      }
    } else if (c && ".+^${}()|\\".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}
function globCouldMatchDotEnv(glob) {
  const pattern = glob.startsWith("!") ? glob.slice(1) : glob;
  const hasSlash = pattern.includes("/");
  return expandBraces(pattern).some((alt) => {
    const regex = globToRegExp(alt);
    return DOTENV_PROBE_BASENAMES.some((name) => regex.test(name) || hasSlash && regex.test(`some/dir/${name}`));
  });
}
function grepDotEnvExclusion(toolInput, cwd) {
  if (isKnownNonDirectoryPath(stringField(toolInput, "path"), cwd)) return void 0;
  const existingGlob = stringField(toolInput, "glob");
  if (existingGlob) {
    if (!globCouldMatchDotEnv(existingGlob)) return void 0;
    return deny(
      `This Grep call already filters by --glob "${existingGlob}", which could still reach a .env file and can't be safely combined with an additional exclusion in the same call. Narrow --glob to exclude .env files yourself, or use \`enigma list\`/\`enigma doctor\` if you're looking for what Enigma has stored.`
    );
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "Added a glob exclusion for .env files so this search can proceed without exposing a secret value in its results.",
      updatedInput: { ...toolInput, glob: DOTENV_EXCLUDE_GLOB }
    }
  };
}
function runReadGuard(input) {
  const cwd = input.cwd ?? process.cwd();
  const toolInput = input.tool_input ?? {};
  if (input.tool_name === "Read" || input.tool_name === "Grep" || input.tool_name === "Glob") {
    const fields = PATH_TOOL_FIELDS[input.tool_name] ?? [];
    const candidates = fields.map((f) => stringField(toolInput, f)).filter((v) => v !== void 0);
    for (const candidate of candidates) {
      if (targetsDotEnv(candidate)) {
        return deny(`Reading .env files directly is blocked to keep secret values out of this session. ${USE_INSTEAD}`);
      }
      if (targetsEnigmaConfig(candidate, cwd)) {
        return deny(
          "Enigma's config directory holds the encrypted vault, index, and audit log. Use `enigma list` or `enigma doctor` instead of reading it directly."
        );
      }
    }
    if (input.tool_name === "Grep") {
      const exclusion = grepDotEnvExclusion(toolInput, cwd);
      if (exclusion) return exclusion;
    }
  }
  if (input.tool_name === "Bash") {
    const command = stringField(toolInput, "command");
    if (command) {
      const known = knownSecretNames();
      const texts = allCommandTexts(normalizeShellEscapes(command));
      if (texts === void 0) {
        return deny(
          "This command has command-substitution nesting too deep to safely inspect for a secret read. Simplify it, or use `enigma run -- <command>` if it needs a secret value injected."
        );
      }
      const segments = texts.flatMap(splitSegments);
      for (const segment of segments) {
        if (segmentTargetsDotEnvByPath(segment)) {
          return deny(`Reading .env files directly is blocked to keep secret values out of this session. ${USE_INSTEAD}`);
        }
        if (segmentTargetsEnigmaConfigByPath(segment, cwd)) {
          return deny(
            "Enigma's config directory holds the encrypted vault, index, and audit log. Use `enigma list` or `enigma doctor` instead of reading it directly."
          );
        }
        if (segmentIsBareEnvDump(segment)) {
          return deny(
            `\`env\`/\`printenv\` can dump secret values into this session. Use \`enigma list\` to see which names exist, or \`enigma run -- <command>\` to run a command with the real values injected without you seeing them.`
          );
        }
        if (segmentIsEnigmaGetOrEnv(segment)) {
          return deny(
            `\`enigma get\`/\`enigma env\` print a secret value to stdout for humans and scripts, not for the agent. ${USE_INSTEAD}`
          );
        }
        if (segmentIsKeychainRead(segment)) {
          return deny(`Reading the macOS Keychain directly via \`security find-generic-password\` is blocked. ${USE_INSTEAD}`);
        }
        if (segmentIsOpRead(segment)) {
          return deny(`Reading a 1Password item directly via \`op read\` is blocked. ${USE_INSTEAD}`);
        }
        const echoedName = segmentEchoesKnownSecret(segment, known);
        if (echoedName) {
          return deny(
            `${echoedName} is a secret Enigma tracks; echoing it would put the value in this session. Use \`enigma run -- <command>\` to inject it into a child process instead.`
          );
        }
      }
    }
  }
  return void 0;
}
function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  };
}

// src/hooks/tripwire.ts
var MAX_OUTPUT_BYTES = 1e6;
var BUDGET_MS = 5e3;
var MIN_SECRET_LENGTH = 6;
function scanSet() {
  const set = /* @__PURE__ */ new Set(["encrypted", "env"]);
  const configured = loadConfig().tripwire?.depositories ?? [];
  for (const id of configured) {
    if (id === "keychain" || id === "secret-service") set.add(id);
  }
  return set;
}
function projectPathFor(entry, cwd) {
  if (entry.scope === "project") return entry.projectPath;
  return findProjectPath(cwd);
}
function candidateEntries(cwd) {
  const scannable = scanSet();
  const pid = projectId(cwd);
  return readIndex().entries.filter(
    (e) => scannable.has(e.depository) && (e.scope === "global" || e.projectId === pid)
  );
}
function outputText(toolResponse) {
  if (toolResponse === void 0 || toolResponse === null) return void 0;
  try {
    return typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse);
  } catch {
    return void 0;
  }
}
async function scan(input) {
  const text = outputText(input.tool_response);
  if (!text || text.length === 0 || text.length > MAX_OUTPUT_BYTES) return void 0;
  const cwd = input.cwd ?? process.cwd();
  const entries = candidateEntries(cwd);
  if (entries.length === 0) return void 0;
  const deadline = Date.now() + BUDGET_MS;
  const leaked = [];
  for (const entry of entries) {
    if (Date.now() > deadline) break;
    const mod = DEPOSITORY_MODULES.find((m) => m.id === entry.depository);
    if (!mod) continue;
    try {
      const depository = mod.create({ projectPath: projectPathFor(entry, cwd) });
      const value = await depository.resolve(entry.ref);
      if (value.length >= MIN_SECRET_LENGTH && text.includes(value)) {
        leaked.push(entry.name);
        appendAuditEvent({
          op: "leak",
          name: entry.name,
          scope: entry.scope,
          depository: entry.depository,
          actor: "hook",
          ok: true,
          error: null
        });
      }
    } catch {
    }
  }
  if (leaked.length === 0) return void 0;
  const systemMessage = leaked.map((name) => `LEAK: value of ${name} appeared in tool output; rotate it via enigma_request rotate:true`).join("\n");
  return { systemMessage };
}
function timeoutAfter(ms) {
  return new Promise((resolveTimeout) => {
    const timer = setTimeout(() => resolveTimeout(void 0), ms);
    timer.unref();
  });
}
async function runTripwire(input) {
  try {
    return await Promise.race([scan(input), timeoutAfter(BUDGET_MS)]);
  } catch {
    return void 0;
  }
}

// src/hooks/index.ts
async function dispatch(event, input) {
  try {
    switch (event) {
      case "SessionStart":
        return runSessionStart(input);
      case "PreToolUse":
        return runReadGuard(input);
      case "PostToolUse":
        return await runTripwire(input);
      default:
        return void 0;
    }
  } catch {
    return void 0;
  }
}
async function main() {
  const input = await readStdinJson().catch(() => ({}));
  const output = await dispatch(process.argv[2], input);
  if (output !== void 0) {
    process.stdout.write(JSON.stringify(output));
  }
  process.exit(0);
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  void main();
}
export {
  dispatch
};
