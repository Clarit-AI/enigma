import { z } from 'zod';

/** Matches DepositoryId (docs/api-contracts.md §1). */
export const DEPOSITORY_ID_SCHEMA = z.enum(['env', 'encrypted', 'keychain', 'secret-service', '1password']);

/** Matches Scope (docs/glossary.md). */
export const SCOPE_SCHEMA = z.enum(['project', 'global']);
