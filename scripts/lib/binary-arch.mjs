// Tiny shared header-arch reader for scripts/build-native.mjs and
// scripts/check-native.mjs: proves the BINARY's machine type matches its
// <os>-<arch> target directory. Guards against the failure mode where a
// cross-build silently emits the host's architecture (e.g. Docker on an
// Apple Silicon host defaulting to arm64 containers while the target
// directory says linux-x64).

/** @returns {'x64'|'arm64'|'unknown'} */
export function binaryArch(buf) {
  if (buf.length >= 20 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    // ELF: e_machine at offset 18, little-endian u16.
    const machine = buf.readUInt16LE(18);
    if (machine === 0x3e) return 'x64'; // EM_X86_64
    if (machine === 0xb7) return 'arm64'; // EM_AARCH64
    return 'unknown';
  }
  if (buf.length >= 8) {
    const magicLE = buf.readUInt32LE(0);
    const magicBE = buf.readUInt32BE(0);
    // Mach-O 64 thin: 0xfeedfacf (LE bytes cf fa ed fe) or byte-swapped.
    if (magicLE === 0xfeedfacf || magicBE === 0xfeedfacf || magicLE === 0xcffaedfe) {
      const cpuType = magicLE === 0xcffaedfe ? buf.readUInt32BE(4) : buf.readUInt32LE(4);
      // CPU_TYPE_X86_64 = 0x01000007, CPU_TYPE_ARM64 = 0x0100000c.
      if (cpuType === 0x01000007) return 'x64';
      if (cpuType === 0x0100000c) return 'arm64';
      return 'unknown';
    }
  }
  return 'unknown';
}

export const TARGET_ARCH = {
  'darwin-arm64': 'arm64',
  'darwin-x64': 'x64',
  'linux-x64': 'x64',
};
