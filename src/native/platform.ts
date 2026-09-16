import { EnigmaError } from '../core/errors.js';

/** Native macOS adapters (osascript, pbcopy) have no equivalent on other platforms in v1 (PRD D2.5). */
export function assertDarwin(): void {
  if (process.platform !== 'darwin') {
    throw new EnigmaError({
      code: 'E_UI_UNAVAILABLE',
      message: 'native UI adapters are only available on macOS',
    });
  }
}
