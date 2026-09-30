import { mkdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import { llmAvailable, LLM_MODEL } from './classifier/llm.ts';
import { SITUATION_STATES } from './domain.ts';
import { Engine, EngineError, SimulatedCrash, type Fault } from './engine.ts';
import { DispatchService } from './external/dispatch-service.ts';
import { SCENARIOS } from './scenarios.ts';
import { Store } from './store.ts';

const ROOT = join(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'public');
const DATA = process.env.SITUATION_DATA_DIR ?? join(ROOT, 'data');
const PORT = Number(process.env.PORT ?? 3000);
const FAULTS: Fault[] = ['none', 'external_failure', 'external_timeout', 'crash_after_success'];

export function createApp(engine: Engine) {
  return createServer(async (req, res) => {
    try {
      await route(engine, req, res);
    } catch (err) {
      if (err instanceof EngineError) {
        const status = { not_found: 404, invalid_request: 400, invalid_transition: 409, conflict: 409 }[err.code];
        return send(res, status, { error: err.message, code: err.code });
      }
      if (err instanceof SimulatedCrash) {
        return send(res, 500, { error: err.message, code: 'simulated_crash' });
      }
      console.error(err);
      send(res, 500, { error: 'internal error' });
    }
  });
}

async function route(engine: Engine, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method ?? 'GET';

  if (parts[0] !== 'api') return serveStatic(url.pathname, res);

  const body = method === 'POST' ? await readJson(req) : {};
  const [, resource, id, action] = parts;

  if (method === 'GET' && resource === 'config') {
    return send(res, 200, { llm_available: llmAvailable(), llm_model: LLM_MODEL, faults: FAULTS, states: [...SITUATION_STATES, 'CLOSED'], scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, v.title])) });
  }
  if (method === 'GET' && resource === 'items' && !id) return send(res, 200, engine.list());
  if (method === 'GET' && resource === 'items' && id) return send(res, 200, engine.detail(id));
  if (method === 'GET' && resource === 'metrics') return send(res, 200, engine.metrics());
  if (method === 'GET' && resource === 'external') return send(res, 200, engine.external.list());

  if (method === 'POST' && resource === 'events') {
    const item = await engine.intake(str(body.text), body.classifier === 'llm' ? 'llm' : 'rules');
    return send(res, 201, engine.detail(item.id));
  }
  if (method === 'POST' && resource === 'items' && id) {
    switch (action) {
      case 'approve': return send(res, 200, engine.approve(id, str(body.by)));
      case 'reject': return send(res, 200, engine.reject(id, str(body.by), str(body.reason)));
      case 'decide': {
        const outcome = body.outcome === 'retry' ? 'retry' : body.outcome === 'close' ? 'close' : null;
        if (!outcome) throw new EngineError('invalid_request', 'outcome must be "close" or "retry"');
        return send(res, 200, engine.decide(id, outcome, str(body.by), str(body.note)));
      }
      case 'transition':
        return send(res, 200, engine.transition(id, str(body.to) as never, str(body.reason) || 'manual transition'));
      case 'execute': {
        const fault = (FAULTS.includes(body.fault as Fault) ? body.fault : 'none') as Fault;
        const result = await engine.execute(id, fault, 'operator');
        return send(res, result.outcome === 'blocked' ? 409 : 200, result);
      }
    }
  }
  if (method === 'POST' && resource === 'reconcile') {
    return send(res, 200, await engine.reconcile(typeof body.item_id === 'string' ? body.item_id : undefined));
  }
  if (method === 'POST' && resource === 'scenarios' && id && SCENARIOS[id]) {
    return send(res, 201, await SCENARIOS[id].run(engine));
  }
  if (method === 'POST' && resource === 'reset') {
    engine.reset();
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: 'not found' });
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function serveStatic(pathname: string, res: ServerResponse): void {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (file.includes('..') || !/^[\w.-]+$/.test(file)) return send(res, 404, { error: 'not found' });
  try {
    const content = readFileSync(join(PUBLIC, file));
    res.writeHead(200, { 'content-type': `${MIME[extname(file)] ?? 'application/octet-stream'}; charset=utf-8` });
    res.end(content);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    throw new EngineError('invalid_request', 'body must be JSON');
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

if (import.meta.main) {
  mkdirSync(DATA, { recursive: true });
  const engine = new Engine(new Store(join(DATA, 'situation.db')), new DispatchService(join(DATA, 'dispatch.db')));
  // Local demo with an unauthenticated reset endpoint: bind to loopback unless HOST says otherwise.
  createApp(engine).listen(PORT, process.env.HOST ?? '127.0.0.1', () => {
    console.log(`Situation Model running at http://localhost:${PORT}`);
    console.log(`Classifier: rules${llmAvailable() ? ` + LLM (${LLM_MODEL})` : ' only (optional: add ANTHROPIC_API_KEY to .env to enable the Claude classifier)'}`);
  });
}
