// Core vocabulary of the Situation Model. Everything here is deterministic data;
// nothing in this file depends on a language model.

export const SITUATION_STATES = ['NOW', 'NEXT', 'WAITING', 'DECISIONS', 'WATCHING'] as const;
export type SituationState = (typeof SITUATION_STATES)[number];

/** CLOSED is the single terminal state. Nothing transitions out of it. */
export type ItemState = SituationState | 'CLOSED';

export const AUTHORITY_LEVELS = ['autonomous', 'approval_required', 'human_only'] as const;
export type Authority = (typeof AUTHORITY_LEVELS)[number];

export const ACTION_TYPES = [
  'send_customer_reply',
  'send_status_update',
  'schedule_followup',
  'issue_refund',
  'publish_announcement',
  'restart_service',
  'change_commercial_terms',
  'grant_access',
  'none',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export type ApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';

/**
 * What the Situation Model believes about the downstream action.
 * `in_flight` = we started it and never recorded a result.
 * `unknown`   = we asked, the external system did not answer in time.
 */
export type ActionStatus = 'none' | 'in_flight' | 'succeeded' | 'failed' | 'unknown';

export interface Item {
  id: string;
  summary: string;
  source_event: string;
  state: ItemState;
  owner: string;
  next_action: string;
  trigger: string;
  action_type: ActionType;
  authority: Authority;
  approval_status: ApprovalStatus;
  approved_by: string | null;
  approved_action_type: ActionType | null;
  action_status: ActionStatus;
  terminal_condition: string;
  closed_reason: string | null;
  classifier: string;
  classifier_rationale: string;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
}

export interface HistoryEntry {
  id: number;
  item_id: string;
  kind: string;
  from_state: ItemState | null;
  to_state: ItemState | null;
  actor: string;
  detail: string;
  at: string;
}

export type AttemptStatus = 'in_flight' | 'succeeded' | 'failed' | 'unknown';

export interface ActionAttempt {
  id: number;
  item_id: string;
  idempotency_key: string;
  action_type: ActionType;
  status: AttemptStatus;
  detail: string;
  started_at: string;
  finished_at: string | null;
}

/**
 * Allowed state transitions, taken from the lifecycle diagram in the source
 * case study. Anything not listed here is rejected.
 */
export const ALLOWED_TRANSITIONS: Record<ItemState, readonly ItemState[]> = {
  NOW: ['NEXT', 'WAITING', 'DECISIONS', 'CLOSED'],
  NEXT: ['NOW', 'DECISIONS', 'CLOSED'],
  WAITING: ['NOW', 'DECISIONS', 'CLOSED'],
  DECISIONS: ['NOW', 'CLOSED'],
  WATCHING: ['NOW', 'DECISIONS', 'CLOSED'],
  CLOSED: [],
};

export function canTransition(from: ItemState, to: ItemState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Output contract for any classifier (rules or LLM). Authority is deliberately absent. */
export interface Classification {
  state: SituationState;
  action_type: ActionType;
  summary: string;
  next_action: string;
  trigger: string;
  rationale: string;
}
