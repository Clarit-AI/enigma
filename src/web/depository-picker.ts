import { checkOnepasswordVaultMissing } from '../storage/depositories/onepassword.js';
import type { DepositoryId, DetectionResult, PromptProfile } from '../storage/interfaces.js';

const PROMPT_PROFILE_LABEL: Record<PromptProfile, string> = {
  none: 'no prompt',
  'may-prompt': 'may prompt',
  'prompts-each-read': 'prompts every read',
};

export interface DepositoryOption {
  id: DepositoryId;
  label: string;
  promptProfile: PromptProfile;
  available: boolean;
  reason?: string;
  selected: boolean;
}

export interface PickDefaultOptions {
  usage?: 'interactive' | 'unattended';
  /** config.defaultDepository (D1.9 sticky default), respected over the usage-hint heuristic when it is itself available. */
  sticky?: DepositoryId;
}

/** Chooses a preselection among available depositories: sticky default first, then an unattended-friendly (promptProfile 'none') pick, else the first available. */
export function pickDefaultDepository(detections: DetectionResult[], opts: PickDefaultOptions = {}): DepositoryId | undefined {
  const available = detections.filter((d) => d.available);
  if (opts.sticky && available.some((d) => d.id === opts.sticky)) return opts.sticky;
  if (opts.usage === 'unattended') {
    const noPrompt = available.find((d) => d.promptProfile === 'none');
    if (noPrompt) return noPrompt.id;
  }
  return available[0]?.id;
}

export interface BuildOptionsInput extends PickDefaultOptions {
  /** A depository explicitly requested (e.g. by `enigma_request` or a resubmission); wins over the heuristic when present. */
  requested?: DepositoryId;
}

/** Builds the picker's option list, each labelled with its prompt profile and one marked `selected`. */
export function buildDepositoryOptions(detections: DetectionResult[], opts: BuildOptionsInput = {}): DepositoryOption[] {
  const preselected = opts.requested ?? pickDefaultDepository(detections, opts);
  return detections.map((d) => ({
    id: d.id,
    label: `${d.id} (${PROMPT_PROFILE_LABEL[d.promptProfile]})`,
    promptProfile: d.promptProfile,
    available: d.available,
    reason: d.reason,
    selected: d.id === preselected,
  }));
}

/** True when `id` is not a known-available depository — the trigger for the "vault missing" confirmation re-render (AC5). */
export function needsAvailabilityConfirmation(detections: DetectionResult[], id: string | undefined): boolean {
  if (!id) return false;
  const match = detections.find((d) => d.id === id);
  return !match || !match.available;
}

/**
 * True when the user must confirm before `id` can accept a write: either
 * it's not a known-available depository (`needsAvailabilityConfirmation`
 * above), or — specifically for `1password` — it's available (signed in)
 * but its `Enigma` vault doesn't exist yet (Issue #28). `detect()`
 * deliberately never checks vault existence (see its own comment), so
 * `needsAvailabilityConfirmation` alone stops catching this case the moment
 * `op whoami` succeeds; this closes that gap for the one depository that has
 * a vault to create, without paying the extra `op` call for the rest.
 */
export async function needsCreateVaultConfirmation(detections: DetectionResult[], id: string | undefined): Promise<boolean> {
  if (needsAvailabilityConfirmation(detections, id)) return true;
  if (id === '1password') return checkOnepasswordVaultMissing();
  return false;
}
