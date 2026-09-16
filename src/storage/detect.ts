import { encryptedDepositoryModule } from './depositories/encrypted.js';
import { envDepositoryModule } from './depositories/env.js';
import type { DepositoryModule, DetectionResult } from './interfaces.js';

/** Registered depository modules. keychain/secret-service/1password land in Issues #5/#6. */
export const DEPOSITORY_MODULES: DepositoryModule[] = [encryptedDepositoryModule, envDepositoryModule];

export async function detectAll(): Promise<DetectionResult[]> {
  return Promise.all(DEPOSITORY_MODULES.map((mod) => mod.detect()));
}
