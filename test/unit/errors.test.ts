import { describe, expect, it } from 'vitest';
import { EnigmaError } from '../../src/core/errors.js';

describe('EnigmaError', () => {
  it('carries code, message, name, and depository', () => {
    const err = new EnigmaError({
      code: 'E_NOT_FOUND',
      message: 'secret not found',
      name: 'OPENAI_API_KEY',
      depository: 'keychain',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('E_NOT_FOUND');
    expect(err.message).toBe('secret not found');
    expect(err.name).toBe('OPENAI_API_KEY');
    expect(err.depository).toBe('keychain');
  });

  it('defaults name and leaves depository undefined when omitted', () => {
    const err = new EnigmaError({ code: 'E_DEPOSITORY_UNAVAILABLE', message: 'op CLI not found' });
    expect(err.name).toBe('EnigmaError');
    expect(err.depository).toBeUndefined();
  });
});
