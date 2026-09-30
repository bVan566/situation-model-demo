import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/server.ts';
import { EVENTS, makeEngine } from './helpers.ts';

describe('HTTP API: the demo sequence end to end', () => {
  const server = createApp(makeEngine());
  let base = '';
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  });
  after(() => server.close());

  const post = async (path: string, body: object = {}) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };

  it('classifies, gates, approves, survives a crash, reconciles and blocks the duplicate', async () => {
    const created = await post('/events', { text: EVENTS.refund });
    assert.equal(created.status, 201);
    const id = created.data.item.id;
    assert.equal(created.data.item.authority, 'approval_required');

    const blocked = await post(`/items/${id}/execute`);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, 'authority');

    assert.equal((await post(`/items/${id}/approve`, { by: 'dana' })).status, 200);

    const crash = await post(`/items/${id}/execute`, { fault: 'crash_after_success' });
    assert.equal(crash.data.code, 'simulated_crash');

    const rec = await post('/reconcile');
    assert.equal(rec.data.stale_corrected, 1);

    const dup = await post(`/items/${id}/execute`);
    assert.equal(dup.status, 409);
    assert.equal(dup.data.code, 'duplicate');

    const metrics = await (await fetch(`${base}/metrics`)).json();
    assert.equal(metrics.max_side_effects_per_item, 1);
  });

  it('returns 409 for an illegal transition and 400 for a bad event', async () => {
    const created = await post('/events', { text: EVENTS.future });
    const bad = await post(`/items/${created.data.item.id}/transition`, { to: 'WATCHING' });
    assert.equal(bad.status, 409);
    assert.equal((await post('/events', { text: '' })).status, 400);
  });
});
