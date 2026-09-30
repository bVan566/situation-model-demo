import { Engine } from '../src/engine.ts';
import { DispatchService, type DispatchOptions } from '../src/external/dispatch-service.ts';
import { Store } from '../src/store.ts';

export const EVENTS = {
  reply: 'Customer asks for a copy of their March invoice. Covered by the standard billing reply process.',
  refund: 'Customer was charged twice for order 4417 and is requesting a refund of the duplicate charge.',
  pricing: 'Customer requests a scope change that would change the price of their contract.',
  waiting: 'Waiting on legal to return the redlined MSA before we can countersign.',
  watching: 'Third-party email provider reports degraded delivery times; no current customer impact.',
  future: 'Follow-up call with Acme is due next Tuesday to review onboarding progress.',
};

export function makeEngine(opts: DispatchOptions = {}): Engine {
  let tick = Date.parse('2026-09-01T09:00:00Z');
  const now = () => new Date((tick += 1000));
  return new Engine(new Store(), new DispatchService(':memory:', { now, ...opts }), { now });
}

export function kinds(engine: Engine, id: string): string[] {
  return engine.store.history(id).map((h) => h.kind);
}
