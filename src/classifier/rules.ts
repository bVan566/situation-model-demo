import type { ActionType, Classification, SituationState } from '../domain.ts';
import { policyFor } from '../policy.ts';

// Deterministic baseline classifier. It is intentionally simple and transparent:
// keyword cues -> action type, then the routing order from the case study:
//   DECISIONS > WAITING > WATCHING > NEXT > NOW
// It is the fallback whenever the LLM classifier is unavailable or returns invalid output.

const ACTION_CUES: [ActionType, RegExp][] = [
  ['grant_access', /\b(grant|give|provision|add|elevate|upgrade)\b[^.]*\b(access|admin|permissions?|role|privileges?)\b|\b(access|admin|permissions?) (request|to the)\b/],
  ['change_commercial_terms', /\b(pric(e|es|ing)|discount|contract|scope change|change (the|their) scope|renegotiat\w*|payment terms|waive|increase (the|their) (budget|limit)|rate card)\b/],
  ['issue_refund', /\b(refund\w*|reimburs\w*|chargeback|money back|double[- ]charged|charged twice)\b/],
  ['publish_announcement', /\b(publish|announce\w*|press release|blog post|release notes|post (it )?(to|on) (the )?(website|social|linkedin))\b/],
  ['restart_service', /\b(restart|reboot|roll ?back|failover|redeploy|bounce)\b/],
  ['schedule_followup', /\b(follow[- ]?up|check[- ]in|touch base|reminder)\b/],
  ['send_status_update', /\b(status update|incident update|notify|update (the )?(customer|client|stakeholders|team|account)s? on)\b/],
  ['send_customer_reply', /\b(repl(y|ied)|respond|answer|asks?|asking|question|wants to know|how (do|can) (i|we)|where (is|can)|requested (a|an|the|information|copies?)|send (them|the customer|a copy))\b/],
];

const DECISION_CUES = /\b(should we|decide|decision|make an exception|exception to (the )?policy|judgment call|trade-?off|outside (of )?(the )?policy|not covered by (any|the|our) (policy|process))\b/;

const WAITING_CUES = /\b(waiting (on|for)|awaiting|pending (their|a|the|customer|vendor|legal)|blocked (by|on)|no response yet|haven'?t heard|depends on|until (they|the \w+) (reply|replies|respond|responds|confirm|confirms|send|sends)|once (they|the \w+) (send|sends|provide|provides|confirm|confirms|sign|signs)|on hold (until|pending))\b/;

const WATCHING_CUES = /\b(degraded|intermittent\w*|elevated|trending|creeping|monitor\w*|keep an eye|no (current |customer |user )?impact|within (sla|threshold|limits|tolerance)|slightly (above|higher|below)|watch\w*|not (yet )?(affecting|impacting))\b/;

const URGENT_CUES = /\b(outage|is down|are down|failing|urgent|asap|immediately|right now|customers? (are )?(affected|impacted|blocked)|impacting customers|breach|sev ?1|p1)\b/;

const FUTURE_CUES = /\b(tomorrow|next (week|month|quarter|monday|tuesday|wednesday|thursday|friday)|on (monday|tuesday|wednesday|thursday|friday)|in \d+ (days|weeks)|in (two|three|four|five) (days|weeks)|due (on|by|next)|scheduled for|later this (week|month)|end of (the )?(week|month|quarter)|before (the )?renewal)\b/;

function detectAction(t: string): ActionType {
  for (const [action, re] of ACTION_CUES) if (re.test(t)) return action;
  return 'none';
}

function firstMatch(re: RegExp, t: string): string {
  return re.exec(t)?.[0] ?? '';
}

function summarize(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const first = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  return first.length > 120 ? first.slice(0, 117) + '...' : first;
}

export function classifyWithRules(text: string): Classification {
  const t = text.toLowerCase();
  const action = detectAction(t);
  const policy = policyFor(action);
  const urgent = URGENT_CUES.test(t);

  let state: SituationState;
  let why: string;
  let trigger = '';

  if (policy.authority === 'human_only' || DECISION_CUES.test(t)) {
    state = 'DECISIONS';
    why = policy.authority === 'human_only'
      ? `action "${action}" is human-only`
      : `decision cue "${firstMatch(DECISION_CUES, t)}"`;
  } else if (WAITING_CUES.test(t)) {
    state = 'WAITING';
    trigger = firstMatch(WAITING_CUES, t);
    why = `external dependency cue "${trigger}"`;
  } else if (WATCHING_CUES.test(t) && !urgent) {
    state = 'WATCHING';
    trigger = firstMatch(WATCHING_CUES, t);
    why = `monitoring cue "${trigger}" with no urgency cue`;
  } else if (FUTURE_CUES.test(t) && !urgent) {
    state = 'NEXT';
    trigger = firstMatch(FUTURE_CUES, t);
    why = `future trigger "${trigger}"`;
  } else {
    state = 'NOW';
    why = urgent ? `urgency cue "${firstMatch(URGENT_CUES, t)}"` : 'actionable with no blocking, future or monitoring cue';
  }

  return {
    state,
    action_type: action,
    summary: summarize(text),
    next_action: policy.default_next_action,
    trigger,
    rationale: `${why}; action cue -> ${action}`,
  };
}
