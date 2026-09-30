import { SimulatedCrash, type Engine } from './engine.ts';
import type { Item } from './domain.ts';

// Prepares each demonstrable failure case up to the moment of failure, so the
// user can trigger the final step (reconcile / execute) themselves in the UI.

export interface ScenarioSetup {
  item: Item;
  next_step: string;
}

export const SCENARIOS: Record<string, { title: string; run: (e: Engine) => Promise<ScenarioSetup> }> = {
  stale_state: {
    title: 'Stale state',
    async run(e) {
      const item = await e.intake('Customer asks for a copy of their March invoice. This is covered by the standard billing reply process.');
      try {
        await e.execute(item.id, 'crash_after_success');
      } catch (err) {
        if (!(err instanceof SimulatedCrash)) throw err;
      }
      return {
        item: e.get(item.id),
        next_step: 'The dispatch service delivered the reply, but the process crashed before recording it. The item still looks in-flight in NOW. Click "Reconcile this item" to detect and correct the stale state.',
      };
    },
  },
  duplicate_action: {
    title: 'Duplicate action',
    async run(e) {
      const item = await e.intake('Customer asks where to download the updated W-9 form. Covered by the approved response template.');
      await e.execute(item.id);
      return {
        item: e.get(item.id),
        next_step: 'The reply was sent, verified, and the item is CLOSED. Click "Execute" again: the duplicate is blocked and the dispatch service records no second side effect.',
      };
    },
  },
  authority_violation: {
    title: 'Authority violation',
    async run(e) {
      const item = await e.intake('Customer was charged twice for order 4417 and is requesting a refund of the duplicate charge right away.');
      return {
        item,
        next_step: 'The refund is urgent (NOW) but requires approval. Click "Execute" without approving: execution is blocked and the item stays gated. Then approve and execute.',
      };
    },
  },
  external_failure: {
    title: 'External failure',
    async run(e) {
      const item = await e.intake('API outage in progress. Notify the affected customer with an incident update.');
      await e.execute(item.id, 'external_failure');
      return {
        item: e.get(item.id),
        next_step: 'The dispatch service returned a failure. The item was NOT marked complete; it moved to DECISIONS for a human to retry or close.',
      };
    },
  },
};
