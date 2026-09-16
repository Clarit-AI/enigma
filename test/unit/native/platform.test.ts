import { afterEach, describe, expect, it } from 'vitest';
import { assertDarwin } from '../../../src/native/platform.js';

describe('assertDarwin', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('throws E_UI_UNAVAILABLE on a non-darwin platform', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(() => assertDarwin()).toThrow(expect.objectContaining({ code: 'E_UI_UNAVAILABLE' }));
  });

  it('throws E_UI_UNAVAILABLE on win32 too', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(() => assertDarwin()).toThrow(expect.objectContaining({ code: 'E_UI_UNAVAILABLE' }));
  });

  it('does not throw on darwin', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(() => assertDarwin()).not.toThrow();
  });
});
