import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ALLOWED_TRANSITIONS, canTransition } from '../src/domain.ts';
import { EVENTS, makeEngine } from './helpers.ts';

describe('state transitions', () => {
  it('encodes the lifecycle from the case study', () => {
    assert.ok(canTransition('NEXT', 'NOW'));        // trigger reached
    assert.ok(canTransition('WAITING', 'NOW'));     // dependency resolved
    assert.ok(canTransition('WAITING', 'DECISIONS'));
    assert.ok(canTransition('WATCHING', 'NOW'));    // condition triggered
    assert.ok(canTransition('DECISIONS', 'NOW'));   // decision recorded
    assert.ok(canTransition('NOW', 'WAITING'));     // blocked
    assert.ok(canTransition('NOW', 'NEXT'));        // deferred
    assert.ok(!canTransition('DECISIONS', 'WAITING'));
    assert.ok(!canTransition('NEXT', 'WATCHING'));
  });

  it('treats CLOSED as terminal', () => {
    assert.deepEqual(ALLOWED_TRANSITIONS.CLOSED, []);
  });

  it('rejects an illegal transition and records legal ones in history', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.future);
    assert.equal(item.state, 'NEXT');
    assert.throws(() => engine.transition(item.id, 'WATCHING', 'nope'), /not allowed/);

    engine.transition(item.id, 'NOW', 'follow-up date reached');
    const t = engine.store.history(item.id).find((h) => h.kind === 'transition');
    assert.deepEqual([t?.from_state, t?.to_state, t?.detail], ['NEXT', 'NOW', 'follow-up date reached']);
  });

  it('does not execute items that are not in NOW', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.future);
    const r = await engine.execute(item.id);
    assert.equal(r.outcome === 'blocked' && r.code, 'not_current');
  });

  it('refuses to reopen or move a CLOSED item', async () => {
    const engine = makeEngine();
    const item = await engine.intake(EVENTS.reply);
    await engine.execute(item.id);
    assert.throws(() => engine.transition(item.id, 'NOW', 'reopen'), /not allowed/);
  });

  it('refuses to close an item whose external result is unknown', async () => {
    const engine = makeEngine({ pendingPolls: 5 });
    const item = await engine.intake(EVENTS.reply);
    await engine.execute(item.id, 'external_timeout');
    assert.throws(() => engine.close(item.id, 'looks done'), /reconciliation/);
  });
});
