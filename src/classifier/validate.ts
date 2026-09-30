import { ACTION_TYPES, SITUATION_STATES, type Classification } from '../domain.ts';

export type ValidationResult =
  | { ok: true; value: Classification }
  | { ok: false; errors: string[] };

const MAX_TEXT = 300;

/**
 * Validates untrusted classifier output (typically parsed LLM JSON).
 * Anything outside the closed vocabularies is rejected, not coerced.
 */
export function validateClassification(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['output is not a JSON object'] };
  }
  const r = raw as Record<string, unknown>;

  if (!SITUATION_STATES.includes(r.state as never)) errors.push(`invalid state: ${JSON.stringify(r.state)}`);
  if (!ACTION_TYPES.includes(r.action_type as never)) errors.push(`invalid action_type: ${JSON.stringify(r.action_type)}`);

  for (const field of ['summary', 'next_action', 'rationale'] as const) {
    const v = r[field];
    if (typeof v !== 'string' || v.trim() === '') errors.push(`${field} must be a non-empty string`);
    else if (v.length > MAX_TEXT) errors.push(`${field} exceeds ${MAX_TEXT} chars`);
  }
  if (r.trigger !== undefined && typeof r.trigger !== 'string') errors.push('trigger must be a string');

  // A classifier must not try to set authority or approval. Reject rather than ignore,
  // so attempts to smuggle authority through the model are visible.
  for (const forbidden of ['authority', 'approval_status', 'approved', 'owner']) {
    if (forbidden in r) errors.push(`classifier may not set "${forbidden}"`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      state: r.state as Classification['state'],
      action_type: r.action_type as Classification['action_type'],
      summary: (r.summary as string).trim(),
      next_action: (r.next_action as string).trim(),
      trigger: typeof r.trigger === 'string' ? r.trigger.trim() : '',
      rationale: (r.rationale as string).trim(),
    },
  };
}
