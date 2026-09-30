import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyWithLlm, type LlmClient, type LlmResponse } from '../src/classifier/llm.ts';
import { Engine } from '../src/engine.ts';
import { DispatchService } from '../src/external/dispatch-service.ts';
import { Store } from '../src/store.ts';
import { EVENTS } from './helpers.ts';

// The Claude client is replaced with fakes, so these tests run offline and prove the
// fallback paths without a key. They do not measure real model quality.

const respond = (r: LlmResponse): LlmClient => ({ create: async () => r });
const text = (t: string): LlmResponse => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const valid = { state: 'NOW', action_type: 'issue_refund', summary: 'Refund duplicate charge', next_action: 'Refund', trigger: '', rationale: 'double charge' };

describe('LLM classifier: graceful degradation to rules', () => {
  const cases: [string, LlmClient, string][] = [
    ['API unavailable / network error', { create: async () => { throw new Error('connect ECONNREFUSED'); } }, 'api_error'],
    ['model refusal', respond({ stop_reason: 'refusal', content: [] }), 'refusal'],
    ['no text block in response', respond({ stop_reason: 'max_tokens', content: [] }), 'no_text'],
    ['malformed JSON', respond(text('{"state": "NOW", "action_ty')), 'malformed_json'],
    ['schema-invalid output (unknown state)', respond(text(JSON.stringify({ ...valid, state: 'URGENT' }))), 'invalid_output'],
    ['output that tries to set authority', respond(text(JSON.stringify({ ...valid, authority: 'autonomous' }))), 'invalid_output'],
  ];

  for (const [name, client, reason] of cases) {
    it(`falls back to rules on ${name}`, async () => {
      const r = await classifyWithLlm(EVENTS.refund, client);
      assert.equal(r.classifier, 'rules (llm fallback)');
      assert.equal(r.fallback?.reason, reason);
      // The rules result is used, so the item is still classified sensibly.
      assert.equal(r.classification.state, 'NOW');
      assert.equal(r.classification.action_type, 'issue_refund');
    });
  }

  it('uses valid LLM output when the model behaves', async () => {
    const r = await classifyWithLlm('ambiguous wording the rules would miss', respond(text(JSON.stringify(valid))));
    assert.match(r.classifier, /^llm:/);
    assert.equal(r.fallback, undefined);
    assert.equal(r.classification.action_type, 'issue_refund');
  });

  it('keeps the whole workflow working when the API fails during intake', async () => {
    const engine = new Engine(new Store(), new DispatchService(), {
      llm: { create: async () => { throw new Error('503 overloaded'); } },
    });
    const item = await engine.intake(EVENTS.refund, 'llm');
    assert.equal(item.classifier, 'rules (llm fallback)');
    assert.equal(item.authority, 'approval_required');
    assert.equal((await engine.execute(item.id)).outcome, 'blocked');
    engine.approve(item.id, 'dana');
    assert.equal((await engine.execute(item.id)).outcome, 'closed');
  });

  it('uses rules when no API key is configured', async () => {
    const saved = [process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_AUTH_TOKEN];
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      const engine = new Engine(new Store(), new DispatchService());
      const item = await engine.intake(EVENTS.reply, 'llm');
      assert.equal(item.classifier, 'rules (no API key)');
    } finally {
      if (saved[0] !== undefined) process.env.ANTHROPIC_API_KEY = saved[0];
      if (saved[1] !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved[1];
    }
  });
});
