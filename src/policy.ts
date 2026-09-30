import type { ActionType, Authority } from './domain.ts';

// The action contract. Authority is a property of the ACTION, looked up here,
// never produced by a classifier and never inferred from earlier approvals.

export interface ActionPolicy {
  authority: Authority;
  /** true if executing this action calls the external dispatch service */
  external: boolean;
  owner: string;
  default_next_action: string;
  terminal_condition: string;
}

export const ACTION_POLICY: Record<ActionType, ActionPolicy> = {
  send_customer_reply: {
    authority: 'autonomous',
    external: true,
    owner: 'operations',
    default_next_action: 'Send reply using the approved response process',
    terminal_condition: 'Dispatch service confirms the reply was delivered',
  },
  send_status_update: {
    authority: 'autonomous',
    external: true,
    owner: 'operations',
    default_next_action: 'Send status update to affected stakeholders',
    terminal_condition: 'Dispatch service confirms the update was delivered',
  },
  schedule_followup: {
    authority: 'autonomous',
    external: true,
    owner: 'operations',
    default_next_action: 'Schedule the follow-up',
    terminal_condition: 'Dispatch service confirms the follow-up is scheduled',
  },
  issue_refund: {
    authority: 'approval_required',
    external: true,
    owner: 'billing',
    default_next_action: 'Obtain approval, then issue refund',
    terminal_condition: 'Dispatch service confirms the refund was issued',
  },
  publish_announcement: {
    authority: 'approval_required',
    external: true,
    owner: 'communications',
    default_next_action: 'Obtain approval, then publish announcement',
    terminal_condition: 'Dispatch service confirms the announcement is live',
  },
  restart_service: {
    authority: 'approval_required',
    external: true,
    owner: 'on-call engineer',
    default_next_action: 'Obtain approval, then restart the service',
    terminal_condition: 'Dispatch service confirms the restart completed',
  },
  change_commercial_terms: {
    authority: 'human_only',
    external: false,
    owner: 'authorized-human',
    default_next_action: 'Review commercial impact and record a decision',
    terminal_condition: 'Human decision recorded',
  },
  grant_access: {
    authority: 'human_only',
    external: false,
    owner: 'authorized-human',
    default_next_action: 'Review access request and record a decision',
    terminal_condition: 'Human decision recorded',
  },
  none: {
    authority: 'autonomous',
    external: false,
    owner: 'operations',
    default_next_action: 'Monitor until the trigger condition is met',
    terminal_condition: 'Condition resolves or item is promoted and handled',
  },
};

export function policyFor(action: ActionType): ActionPolicy {
  return ACTION_POLICY[action];
}
