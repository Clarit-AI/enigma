import { encryptedDepositoryModule } from './depositories/encrypted.js';
import { envDepositoryModule } from './depositories/env.js';
import { linuxSecretServiceDepositoryModule } from './depositories/linux-secret-service.js';
import { macosKeychainDepositoryModule } from './depositories/macos-keychain.js';
import { onepasswordDepositoryModule } from './depositories/onepassword.js';
import type { DepositoryModule, DetectionResult } from './interfaces.js';

/** Registered depository modules. */
export const DEPOSITORY_MODULES: DepositoryModule[] = [
  encryptedDepositoryModule,
  envDepositoryModule,
  macosKeychainDepositoryModule,
  linuxSecretServiceDepositoryModule,
  onepasswordDepositoryModule,
];

export async function detectAll(): Promise<DetectionResult[]> {
  return Promise.all(DEPOSITORY_MODULES.map((mod) => mod.detect()));
}
