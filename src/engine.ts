import { classifyWithLlm, llmAvailable, type LlmClient } from './classifier/llm.ts';
import { classifyWithRules } from './classifier/rules.ts';
import { canTransition, type Classification, type Item, type ItemState } from './domain.ts';
import { DispatchService, ExternalTimeoutError, type ExternalFault, type ExternalRecord } from './external/dispatch-service.ts';
import { policyFor } from './policy.ts';
import { Store } from './store.ts';

// The deterministic control path. Every rule about permission, approval, state
// transitions, duplicate protection and reconciliation lives here, in plain code.
// The classifier (rules or LLM) only proposes a state and an action type at intake.

export type Fault = ExternalFault | 'crash_after_success';
export type ClassifierChoice = 'rules' | 'llm';

export class EngineError extends Error {
  readonly code: 'not_found' | 'invalid_transition' | 'invalid_request' | 'conflict';
  constructor(code: EngineError['code'], message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

/** Simulates the process dying after the external call succeeded but before the result was persisted. */
export class SimulatedCrash extends Error {
  constructor(key: string) {
    super(`simulated crash: dispatch service confirmed ${key}, but the result was never written to the Situation Model`);
    this.name = 'SimulatedCrash';
  }
}

export type BlockCode = 'authority' | 'duplicate' | 'not_current' | 'in_progress' | 'no_action';

export type ExecuteResult =
  | { outcome: 'closed'; item: Item; detail: string }
  | { outcome: 'blocked'; code: BlockCode; item: Item; detail: string }
  | { outcome: 'failed'; item: Item; detail: string }
  | { outcome: 'pending'; item: Item; detail: string };

export interface ReconcileFinding {
  item_id: string;
  idempotency_key: string;
  internal: string;
  external: string;
  result: 'consistent' | 'stale_corrected' | 'failure_routed' | 'still_pending' | 'not_delivered' | 'anomaly';
  detail: string;
}

export interface ReconcileReport {
  checked: number;
  consistent: number;
  stale_corrected: number;
  failure_routed: number;
  still_pending: number;
  not_delivered: number;
  anomalies: number;
  findings: ReconcileFinding[];
}

export interface EngineOptions {
  now?: () => Date;
  /** LLM client override (tests). Defaults to the Anthropic SDK when an API key is configured. */
  llm?: LlmClient;
  /**
   * How long an in-flight attempt with no external record is treated as "possibly in transit"
   * before reconciliation may declare it undelivered and allow a retry.
   */
  undeliveredAfterMs?: number;
}

export class Engine {
  readonly store: Store;
  readonly external: DispatchService;
  private readonly now: () => Date;
  private readonly llm?: LlmClient;
  private readonly undeliveredAfterMs: number;

  constructor(store: Store, external: DispatchService, opts: EngineOptions = {}) {
    this.store = store;
    this.external = external;
    this.now = opts.now ?? (() => new Date());
    this.llm = opts.llm;
    this.undeliveredAfterMs = opts.undeliveredAfterMs ?? 60_000;
  }

  private ts(): string {
    return this.now().toISOString();
  }

  // ---------------------------------------------------------------- intake

  async intake(text: string, classifier: ClassifierChoice = 'rules'): Promise<Item> {
    if (typeof text !== 'string' || text.trim().length < 5) {
      throw new EngineError('invalid_request', 'event text must be at least 5 characters');
    }
    let classification: Classification;
    let classifierName: string;
    if (classifier === 'llm' && (this.llm || llmAvailable())) {
      const r = await classifyWithLlm(text, this.llm);
      classification = r.classification;
      classifierName = r.classifier;
    } else {
      classification = classifyWithRules(text);
      classifierName = classifier === 'llm' ? 'rules (no API key)' : 'rules';
    }
    return this.createItem(text, classification, classifierName);
  }

  /** Applies the deterministic action policy to a classifier proposal and persists the item. */
  createItem(text: string, c: Classification, classifierName: string): Item {
    const policy = policyFor(c.action_type);
    const ts = this.ts();
    // Conservative override: a human-only action is always a DECISIONS item,
    // whatever state the classifier proposed.
    const state: ItemState = policy.authority === 'human_only' ? 'DECISIONS' : c.state;
    const nextAction = policy.authority === 'autonomous' && c.next_action ? c.next_action : policy.default_next_action;

    const item: Item = {
      id: this.store.nextItemId(),
      summary: c.summary,
      source_event: text.trim(),
      state,
      owner: policy.owner,
      next_action: nextAction,
      trigger: c.trigger,
      action_type: c.action_type,
      authority: policy.authority,
      approval_status: policy.authority === 'approval_required' ? 'pending' : 'not_required',
      approved_by: null,
      approved_action_type: null,
      action_status: 'none',
      terminal_condition: policy.terminal_condition,
      closed_reason: null,
      classifier: classifierName,
      classifier_rationale: c.rationale,
      created_at: ts,
      updated_at: ts,
      last_verified_at: null,
    };

    this.store.tx(() => {
      this.store.insertItem(item);
      this.log(item.id, 'created', null, state, 'intake', `classified by ${classifierName}: ${c.rationale}`);
      this.log(item.id, 'authority_assigned', null, null, 'policy',
        `action "${c.action_type}" -> authority ${policy.authority}, owner ${policy.owner}`);
      if (state !== c.state) {
        this.log(item.id, 'policy_override', null, null, 'policy',
          `classifier proposed ${c.state}; human-only action forces DECISIONS`);
      }
    });
    return this.get(item.id);
  }

  // ---------------------------------------------------------------- queries

  get(id: string): Item {
    const item = this.store.getItem(id);
    if (!item) throw new EngineError('not_found', `item ${id} not found`);
    return item;
  }

  list(): Item[] {
    return this.store.listItems();
  }

  detail(id: string) {
    const item = this.get(id);
    return {
      item,
      history: this.store.history(id),
      attempts: this.store.attempts(id),
      external: this.external.list(id),
    };
  }

  // ---------------------------------------------------------------- transitions

  transition(id: string, to: ItemState, reason: string, actor = 'human'): Item {
    const item = this.get(id);
    this.assertTransition(item, to);
    if (to === 'CLOSED') {
      return this.close(id, reason, actor);
    }
    this.store.tx(() => this.move(item, to, actor, reason));
    return this.get(id);
  }

  /**
   * Closes an item only if its terminal condition is actually met, or a human is
   * closing an item whose external action is not in an unresolved state.
   */
  close(id: string, reason: string, actor = 'human'): Item {
    const item = this.get(id);
    this.assertTransition(item, 'CLOSED');
    if (item.action_status === 'in_flight' || item.action_status === 'unknown') {
      throw new EngineError('conflict',
        `cannot close ${id}: external action result is ${item.action_status}; run reconciliation first`);
    }
    this.store.tx(() => this.move(item, 'CLOSED', actor, reason, { closed_reason: reason }));
    return this.get(id);
  }

  private assertTransition(item: Item, to: ItemState): void {
    if (!canTransition(item.state, to)) {
      throw new EngineError('invalid_transition', `transition ${item.state} -> ${to} is not allowed for ${item.id}`);
    }
  }

  private move(item: Item, to: ItemState, actor: string, reason: string, patch: Partial<Item> = {}): void {
    if (item.state !== to) {
      if (!canTransition(item.state, to)) {
        throw new EngineError('invalid_transition', `transition ${item.state} -> ${to} is not allowed for ${item.id}`);
      }
      this.log(item.id, 'transition', item.state, to, actor, reason);
    }
    this.store.updateItem(item.id, { ...patch, state: to, updated_at: this.ts() });
  }

  // ---------------------------------------------------------------- approvals

  approve(id: string, by: string): Item {
    const item = this.get(id);
    if (!by?.trim()) throw new EngineError('invalid_request', 'approver name is required');
    if (item.state === 'CLOSED') throw new EngineError('conflict', `${id} is closed`);
    if (item.authority === 'human_only') {
      throw new EngineError('conflict',
        `${id} is human-only: there is no system action to approve. Record a decision instead.`);
    }
    if (item.authority === 'autonomous') {
      throw new EngineError('conflict', `${id} is autonomous and does not need approval`);
    }
    if (item.approval_status === 'approved') {
      throw new EngineError('conflict', `${id} is already approved by ${item.approved_by}`);
    }
    this.store.tx(() => {
      // The approval is bound to this item AND this action type. It is never copied to other items.
      this.store.updateItem(id, {
        approval_status: 'approved',
        approved_by: by.trim(),
        approved_action_type: item.action_type,
        next_action: policyFor(item.action_type).default_next_action.replace('Obtain approval, then ', 'Approved: '),
        updated_at: this.ts(),
      });
      this.log(id, 'approval_granted', null, null, by.trim(), `approved "${item.action_type}" for ${id} only`);
    });
    return this.get(id);
  }

  reject(id: string, by: string, reason: string): Item {
    const item = this.get(id);
    if (!by?.trim()) throw new EngineError('invalid_request', 'approver name is required');
    if (item.authority !== 'approval_required' || item.approval_status !== 'pending') {
      throw new EngineError('conflict', `${id} has no pending approval`);
    }
    this.store.tx(() => {
      this.log(id, 'approval_rejected', null, null, by.trim(), reason || 'rejected');
      this.move(item, 'DECISIONS', by.trim(), 'approval rejected; choose an alternative or close', {
        approval_status: 'rejected',
        owner: 'authorized-human',
        next_action: 'Approval rejected: decide on an alternative or close',
      });
    });
    return this.get(id);
  }

  /**
   * Records a human decision on a DECISIONS item.
   *  - "close": terminal. For human-only items this IS the terminal condition.
   *  - "retry": only after a failed external action; returns the item to NOW.
   */
  decide(id: string, outcome: 'close' | 'retry', by: string, note = ''): Item {
    const item = this.get(id);
    if (!by?.trim()) throw new EngineError('invalid_request', 'decision maker is required');
    if (item.state !== 'DECISIONS') throw new EngineError('conflict', `${id} is in ${item.state}, not DECISIONS`);
    const who = by.trim();

    if (outcome === 'close') {
      const reason = `human decision recorded by ${who}${note ? `: ${note}` : ''}`;
      const closed = this.close(id, reason, who);
      this.log(id, 'decision_recorded', null, null, who, note || 'close');
      return closed;
    }
    if (outcome === 'retry') {
      if (item.action_status !== 'failed') {
        throw new EngineError('conflict', `retry is only valid after a failed action (current: ${item.action_status})`);
      }
      this.store.tx(() => {
        this.log(id, 'decision_recorded', null, null, who, `retry${note ? `: ${note}` : ''}`);
        this.move(item, 'NOW', who, 'human decided to retry the failed action', {
          action_status: 'none',
          owner: policyFor(item.action_type).owner,
          next_action: 'Retry the action',
        });
      });
      return this.get(id);
    }
    throw new EngineError('invalid_request', `unknown decision outcome "${outcome}"`);
  }

  // ---------------------------------------------------------------- execution

  /**
   * Executes the item's downstream action, subject to (in order):
   *  1. duplicate protection  2. authority  3. state  4. the external ledger.
   * The item is closed only after the external result is verified.
   */
  async execute(id: string, fault: Fault = 'none', actor = 'system'): Promise<ExecuteResult> {
    let item = this.get(id);
    const policy = policyFor(item.action_type);

    // 1. Duplicate protection on internal state.
    if (item.action_status === 'succeeded') {
      return this.blocked(item, 'duplicate', actor,
        `action "${item.action_type}" already completed for ${id}; refusing to execute again`);
    }
    if (item.state === 'CLOSED') {
      return this.blocked(item, 'not_current', actor, `${id} is closed (${item.closed_reason})`);
    }
    if (!policy.external) {
      if (item.authority === 'human_only') {
        return this.blockAuthority(item, actor);
      }
      return this.blocked(item, 'no_action', actor, `${id} has no external action to execute ("${item.action_type}")`);
    }

    // 2. Authority. Classification is not authority.
    if (item.authority === 'human_only') return this.blockAuthority(item, actor);
    if (item.authority === 'approval_required') {
      const valid = item.approval_status === 'approved' && item.approved_action_type === item.action_type;
      if (!valid) return this.blockAuthority(item, actor);
    }

    // 3. External ledger: if an earlier attempt's result was never recorded, ask the
    //    authoritative system before doing anything that could duplicate a side effect.
    const unresolved = this.store.attempts(id).filter((a) => a.status === 'in_flight' || a.status === 'unknown');
    for (const attempt of unresolved) {
      const ext = await this.external.status(attempt.idempotency_key);
      if (ext?.status === 'succeeded') {
        this.log(id, 'stale_detected', null, null, 'system',
          `execute requested, but dispatch service already completed ${attempt.idempotency_key}; internal state was stale`);
        this.reconcileAttempt(this.get(id), attempt.idempotency_key, ext);
        return this.blocked(this.get(id), 'duplicate', actor,
          `external action ${attempt.idempotency_key} had already succeeded; state reconciled and duplicate execution prevented`);
      }
      if (ext?.status === 'pending') {
        return this.blocked(item, 'in_progress', actor,
          `external action ${attempt.idempotency_key} is still pending; waiting rather than re-submitting`);
      }
      const finding = this.reconcileAttempt(item, attempt.idempotency_key, ext);
      if (finding.result === 'still_pending') {
        return this.blocked(item, 'in_progress', actor,
          `external action ${attempt.idempotency_key} has no confirmed result yet; waiting rather than re-submitting`);
      }
    }
    item = this.get(id);
    if (item.state === 'CLOSED' || item.action_status === 'succeeded') {
      return this.blocked(item, 'duplicate', actor, `action already completed for ${id}`);
    }

    // 4. State. Only NOW items act; NEXT/WAITING/WATCHING/DECISIONS do not execute.
    if (item.state !== 'NOW') {
      return this.blocked(item, 'not_current', actor, `${id} is in ${item.state}; only NOW items execute`);
    }

    // Write-ahead: record the attempt BEFORE calling out, so a crash leaves evidence.
    const attemptNo = this.store.attempts(id).length + 1;
    const key = `${id}:${item.action_type}:${attemptNo}`;
    const started = this.ts();
    this.store.tx(() => {
      this.store.insertAttempt({ item_id: id, idempotency_key: key, action_type: item.action_type, status: 'in_flight', detail: '', started_at: started, finished_at: null });
      this.store.updateItem(id, { action_status: 'in_flight', updated_at: started });
      this.log(id, 'execution_started', null, null, actor, `submitting ${key} to dispatch service`);
    });

    let ext: ExternalRecord;
    try {
      ext = await this.external.submit(key, id, item.action_type, fault === 'crash_after_success' ? 'none' : fault);
    } catch (err) {
      if (err instanceof ExternalTimeoutError) {
        this.store.tx(() => {
          this.store.updateAttempt(key, 'unknown', err.message, null);
          this.log(id, 'execution_timeout', null, null, 'system', err.message);
          this.move(this.get(id), 'WAITING', 'system', 'no response from dispatch service; result unknown', {
            action_status: 'unknown',
            owner: 'system',
            next_action: 'Reconcile with dispatch service before any retry',
            trigger: `dispatch service result for ${key}`,
          });
        });
        return { outcome: 'pending', item: this.get(id), detail: 'dispatch service timed out; item moved to WAITING. Completion is NOT assumed.' };
      }
      throw err;
    }

    if (fault === 'crash_after_success') {
      // The external side effect happened; we "die" before persisting it.
      throw new SimulatedCrash(key);
    }

    if (ext.status === 'failed') {
      this.store.tx(() => {
        this.store.updateAttempt(key, 'failed', ext.error ?? 'failed', this.ts());
        this.log(id, 'execution_failed', null, null, 'system', ext.error ?? 'failed');
        this.move(this.get(id), 'DECISIONS', 'system', 'external action failed; human decides retry or close', {
          action_status: 'failed',
          owner: 'authorized-human',
          next_action: `External action failed (${ext.error}). Decide: retry or close.`,
        });
      });
      return { outcome: 'failed', item: this.get(id), detail: ext.error ?? 'failed' };
    }

    // Success reported. Record it, then verify against the authoritative read before closing.
    this.store.tx(() => {
      this.store.updateAttempt(key, 'succeeded', 'dispatch service reported success', this.ts());
      this.store.updateItem(id, { action_status: 'succeeded', updated_at: this.ts() });
      this.log(id, 'execution_succeeded', null, null, 'system', `dispatch service reported success for ${key}`);
    });
    return this.verifyAndClose(id, key);
  }

  private async verifyAndClose(id: string, key: string): Promise<ExecuteResult> {
    const verified = await this.external.status(key);
    const item = this.get(id);
    if (verified?.status !== 'succeeded') {
      this.store.tx(() => {
        this.log(id, 'verification_mismatch', null, null, 'system', `status read for ${key} returned ${verified?.status ?? 'not_found'}`);
        this.move(item, 'DECISIONS', 'system', 'success was reported but could not be verified', {
          owner: 'authorized-human',
          next_action: 'Investigate unverified completion',
        });
      });
      return { outcome: 'failed', item: this.get(id), detail: 'success could not be verified' };
    }
    this.store.tx(() => {
      this.move(item, 'CLOSED', 'system', `terminal condition met: ${item.terminal_condition}`, {
        closed_reason: `terminal condition verified: ${item.terminal_condition}`,
        last_verified_at: this.ts(),
      });
    });
    return { outcome: 'closed', item: this.get(id), detail: `verified ${key} and closed` };
  }

  private blockAuthority(item: Item, actor: string): ExecuteResult {
    const detail = item.authority === 'human_only'
      ? `${item.id} is human-only ("${item.action_type}"); the system may not execute it`
      : `${item.id} requires approval for "${item.action_type}" (approval: ${item.approval_status}); execution blocked`;
    if (item.authority === 'human_only' && item.state !== 'DECISIONS' && canTransition(item.state, 'DECISIONS')) {
      this.store.tx(() => {
        this.log(item.id, 'authority_blocked', null, null, actor, detail);
        this.move(item, 'DECISIONS', 'system', 'rerouted: human-only action attempted by the system');
      });
      return { outcome: 'blocked', code: 'authority', item: this.get(item.id), detail };
    }
    return this.blocked(item, 'authority', actor, detail);
  }

  private blocked(item: Item, code: BlockCode, actor: string, detail: string): ExecuteResult {
    this.log(item.id, `${code}_blocked`, null, null, actor, detail);
    return { outcome: 'blocked', code, item: this.get(item.id), detail };
  }

  // ---------------------------------------------------------------- reconciliation

  /**
   * Compares the Situation Model with the dispatch service (the authority on side effects)
   * and corrects internal state. Never invents completion: uncertainty is surfaced.
   */
  async reconcile(itemId?: string): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      checked: 0, consistent: 0, stale_corrected: 0, failure_routed: 0,
      still_pending: 0, not_delivered: 0, anomalies: 0, findings: [],
    };
    const items = itemId ? [this.get(itemId)] : this.list();

    for (const item of items) {
      const attempts = this.store.attempts(item.id);
      if (attempts.length === 0) continue;

      for (const attempt of attempts) {
        const ext = await this.external.status(attempt.idempotency_key);
        report.checked++;
        const current = this.get(item.id);
        const finding = this.reconcileAttempt(current, attempt.idempotency_key, ext, attempt.status);
        report[finding.result === 'consistent' ? 'consistent'
          : finding.result === 'anomaly' ? 'anomalies'
          : finding.result]++;
        report.findings.push(finding);
      }
      this.store.updateItem(item.id, { last_verified_at: this.ts() });
    }
    return report;
  }

  private reconcileAttempt(item: Item, key: string, ext: ExternalRecord | null, attemptStatus?: string): ReconcileFinding {
    const internal = attemptStatus ?? this.store.attempts(item.id).find((a) => a.idempotency_key === key)?.status ?? 'unknown';
    const extStatus = ext?.status ?? 'not_found';
    const base = { item_id: item.id, idempotency_key: key, internal: `${internal} (item ${item.state}/${item.action_status})`, external: extStatus };
    const ts = this.ts();

    // Internal says succeeded; external agrees.
    if (internal === 'succeeded' && extStatus === 'succeeded') {
      if (item.state !== 'CLOSED') {
        this.store.tx(() => {
          this.log(item.id, 'stale_detected', null, null, 'reconciler', `${key} succeeded but item still ${item.state}`);
          this.move(item, 'CLOSED', 'reconciler', 'reconciled: terminal condition verified', {
            action_status: 'succeeded', closed_reason: `terminal condition verified by reconciliation: ${item.terminal_condition}`, last_verified_at: ts,
          });
          this.log(item.id, 'reconciled', null, null, 'reconciler', `closed from verified external success of ${key}`);
        });
        return { ...base, result: 'stale_corrected', detail: 'item was open although action had succeeded; closed' };
      }
      return { ...base, result: 'consistent', detail: 'internal and external agree: succeeded' };
    }
    if (internal === 'failed' && (extStatus === 'failed' || extStatus === 'not_found')) {
      return { ...base, result: 'consistent', detail: `internal and external agree: ${extStatus}` };
    }

    // Internal claims success the authoritative system has no record of: do not invent completion.
    if (internal === 'succeeded') {
      this.store.tx(() => {
        this.log(item.id, 'anomaly_detected', null, null, 'reconciler', `internal success for ${key} but external reports ${extStatus}`);
        if (item.state !== 'CLOSED' && item.state !== 'DECISIONS') {
          this.move(item, 'DECISIONS', 'reconciler', 'unverifiable completion routed to a human', {
            owner: 'authorized-human', next_action: 'Investigate: internal success without external record',
          });
        }
      });
      return { ...base, result: 'anomaly', detail: 'internal success is not backed by the dispatch service; routed to DECISIONS' };
    }

    // Internal is in_flight / unknown: the result was never recorded.
    if (extStatus === 'succeeded') {
      this.store.tx(() => {
        this.store.updateAttempt(key, 'succeeded', 'recovered by reconciliation', ts);
        this.log(item.id, 'stale_detected', null, null, 'reconciler',
          `internal attempt ${key} was ${internal}; dispatch service reports succeeded`);
        const fresh = this.get(item.id);
        this.move(fresh, 'CLOSED', 'reconciler', 'reconciled: external success recovered', {
          action_status: 'succeeded',
          closed_reason: `terminal condition verified by reconciliation: ${item.terminal_condition}`,
          last_verified_at: ts,
        });
        this.log(item.id, 'reconciled', null, null, 'reconciler', `corrected ${fresh.state} -> CLOSED from ${key}`);
      });
      return { ...base, result: 'stale_corrected', detail: 'stale in-flight state corrected to CLOSED' };
    }
    if (extStatus === 'failed') {
      this.store.tx(() => {
        this.store.updateAttempt(key, 'failed', ext?.error ?? 'failed', ts);
        this.log(item.id, 'reconciled', null, null, 'reconciler', `${key} actually failed: ${ext?.error}`);
        this.move(this.get(item.id), 'DECISIONS', 'reconciler', 'external action failed; human decides retry or close', {
          action_status: 'failed', owner: 'authorized-human', next_action: 'External action failed. Decide: retry or close.',
        });
      });
      return { ...base, result: 'failure_routed', detail: 'external failure discovered; routed to DECISIONS' };
    }
    if (extStatus === 'pending') {
      if (item.state === 'NOW') {
        this.store.tx(() => {
          this.move(item, 'WAITING', 'reconciler', 'external action still pending', {
            action_status: 'unknown', owner: 'system', next_action: 'Reconcile with dispatch service before any retry',
          });
        });
      }
      return { ...base, result: 'still_pending', detail: 'dispatch service still processing; item stays WAITING' };
    }
    // not_found. A recent attempt may still be in transit, so it is not safe to retry yet.
    const startedAt = Date.parse(this.store.attempts(item.id).find((a) => a.idempotency_key === key)?.started_at ?? '');
    const ageMs = this.now().getTime() - startedAt;
    if (!(ageMs >= this.undeliveredAfterMs)) {
      return { ...base, result: 'still_pending', detail: 'no external record yet, but the attempt is recent and may still be in transit' };
    }
    // Old enough: the request never reached the external system. Safe to retry.
    this.store.tx(() => {
      this.store.updateAttempt(key, 'failed', 'never reached dispatch service', ts);
      this.log(item.id, 'reconciled', null, null, 'reconciler', `${key} was never delivered; action may be retried`);
      const fresh = this.get(item.id);
      this.move(fresh, fresh.state === 'WAITING' ? 'NOW' : fresh.state, 'reconciler', 'undelivered attempt cleared', { action_status: 'none' });
    });
    return { ...base, result: 'not_delivered', detail: 'attempt never reached the dispatch service; cleared for retry' };
  }

  // ---------------------------------------------------------------- metrics

  metrics() {
    const c = (k: string) => this.store.countHistory(k);
    return {
      items_by_state: this.store.countByState(),
      unauthorized_executions_blocked: c('authority_blocked'),
      duplicate_executions_blocked: c('duplicate_blocked'),
      stale_states_detected: c('stale_detected'),
      reconciliations_applied: c('reconciled'),
      external_failures: c('execution_failed'),
      external_timeouts: c('execution_timeout'),
      anomalies_flagged: c('anomaly_detected'),
      max_side_effects_per_item: Math.max(0, ...this.external.sideEffectsByItem().values()),
    };
  }

  reset(): void {
    this.store.reset();
    this.external.reset();
  }

  private log(itemId: string, kind: string, from: ItemState | null, to: ItemState | null, actor: string, detail: string): void {
    this.store.addHistory({ item_id: itemId, kind, from_state: from, to_state: to, actor, detail, at: this.ts() });
  }
}
