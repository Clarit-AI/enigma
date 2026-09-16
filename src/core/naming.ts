import { EnigmaError } from './errors.js';

/** Canonical secret name shape (ADR-003): SCREAMING_SNAKE_CASE, starting with a letter. */
export const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new EnigmaError({
      code: 'E_NAME_INVALID',
      message: `invalid secret name: expected ${NAME_PATTERN}`,
      secretName: name,
    });
  }
}
