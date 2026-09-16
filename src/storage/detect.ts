import { encryptedDepositoryModule } from './depositories/encrypted.js';
import { envDepositoryModule } from './depositories/env.js';
import { linuxSecretServiceDepositoryModule } from './depositories/linux-secret-service.js';
import { macosKeychainDepositoryModule } from './depositories/macos-keychain.js';
import type { DepositoryModule, DetectionResult } from './interfaces.js';

/** Registered depository modules. 1password lands in Issue #6. */
export const DEPOSITORY_MODULES: DepositoryModule[] = [
  encryptedDepositoryModule,
  envDepositoryModule,
  macosKeychainDepositoryModule,
  linuxSecretServiceDepositoryModule,
];

export async function detectAll(): Promise<DetectionResult[]> {
  return Promise.all(DEPOSITORY_MODULES.map((mod) => mod.detect()));
}
