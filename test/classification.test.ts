import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyWithRules } from '../src/classifier/rules.ts';
import { validateClassification } from '../src/classifier/validate.ts';
import { EVENTS, makeEngine } from './helpers.ts';

describe('situation classification', () => {
  it('routes each canonical event to its Situation Model state', () => {
    assert.equal(classifyWithRules(EVENTS.reply).state, 'NOW');
    assert.equal(classifyWithRules(EVENTS.future).state, 'NEXT');
    assert.equal(classifyWithRules(EVENTS.waiting).state, 'WAITING');
    assert.equal(classifyWithRules(EVENTS.pricing).state, 'DECISIONS');
    assert.equal(classifyWithRules(EVENTS.watching).state, 'WATCHING');
  });

  it('follows the routing priority: urgency overrides a monitoring cue', () => {
    const c = classifyWithRules('Checkout latency is elevated and customers are impacted. Restart the service.');
    assert.equal(c.state, 'NOW');
    assert.equal(c.action_type, 'restart_service');
  });

  it('produces structured output that passes its own validator', () => {
    const c = classifyWithRules(EVENTS.refund);
    assert.deepEqual(validateClassification(c), { ok: true, value: c });
  });
});

describe('classifier output validation (untrusted LLM output)', () => {
  const good = { state: 'NOW', action_type: 'send_customer_reply', summary: 's', next_action: 'n', trigger: '', rationale: 'r' };

  it('rejects states and actions outside the closed vocabulary', () => {
    const r = validateClassification({ ...good, state: 'URGENT', action_type: 'wire_money' });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.errors.length, 2);
  });

  it('rejects any attempt by the classifier to set authority or approval', () => {
    const r = validateClassification({ ...good, authority: 'autonomous', approval_status: 'approved' });
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.errors.join() : '', /may not set "authority"/);
  });

  it('rejects non-objects and empty required text', () => {
    assert.equal(validateClassification('NOW').ok, false);
    assert.equal(validateClassification({ ...good, next_action: '  ' }).ok, false);
  });
});

describe('intake applies deterministic policy after classification', () => {
  it('assigns authority from the action contract, not the classifier', async () => {
    const engine = makeEngine();
    const refund = await engine.intake(EVENTS.refund);
    assert.equal(refund.action_type, 'issue_refund');
    assert.equal(refund.authority, 'approval_required');
    assert.equal(refund.approval_status, 'pending');
    assert.ok(refund.owner && refund.next_action, 'active items always have owner and next action');
  });

  it('forces human-only actions into DECISIONS even if the classifier proposed another state', () => {
    const engine = makeEngine();
    const item = engine.createItem('grant admin access', {
      state: 'NOW', action_type: 'grant_access', summary: 'grant admin', next_action: 'do it', trigger: '', rationale: 'test',
    }, 'test');
    assert.equal(item.state, 'DECISIONS');
    assert.equal(item.authority, 'human_only');
    assert.ok(engine.store.history(item.id).some((h) => h.kind === 'policy_override'));
  });

  it('persists items so they survive beyond one process interaction', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.reply);
    const reread = engine.store.getItem(item.id);
    assert.equal(reread?.summary, item.summary);
    assert.equal(engine.store.history(item.id)[0].kind, 'created');
  });
});
