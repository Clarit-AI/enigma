import { describe, expect, it } from 'vitest';
import { validateName } from '../../src/core/naming.js';
import { EnigmaError } from '../../src/core/errors.js';

describe('validateName', () => {
  it('accepts a canonical SCREAMING_SNAKE_CASE name', () => {
    expect(() => validateName('OPENAI_API_KEY')).not.toThrow();
  });

  it.each(['openai-key', '1KEY', ''])('rejects %j with E_NAME_INVALID', (name) => {
    try {
      validateName(name);
      expect.unreachable('validateName should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnigmaError);
      expect((err as EnigmaError).code).toBe('E_NAME_INVALID');
    }
  });
});
