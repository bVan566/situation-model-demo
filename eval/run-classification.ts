// Runs the labeled evaluation cases through the real intake path (classifier +
// deterministic policy) and reports classification performance.
//
//   node eval/run-classification.ts [--set dev|holdout|all] [--classifier rules|llm]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { llmAvailable } from '../src/classifier/llm.ts';
import { SITUATION_STATES, type ActionType, type SituationState } from '../src/domain.ts';
import { Engine } from '../src/engine.ts';
import { DispatchService } from '../src/external/dispatch-service.ts';
import { policyFor } from '../src/policy.ts';
import { Store } from '../src/store.ts';

interface Case { id: string; text: string; expected_state: SituationState; expected_action: ActionType }

const { values } = parseArgs({ options: { set: { type: 'string', default: 'holdout' }, classifier: { type: 'string', default: 'rules' } } });
const set = values.set as string;
const classifier = values.classifier === 'llm' ? 'llm' : 'rules';
if (classifier === 'llm' && !llmAvailable()) {
  console.error('LLM classifier requested but ANTHROPIC_API_KEY is not set (add it to .env; see .env.example).');
  process.exit(1);
}

const dir = import.meta.dirname;
const load = (name: string): Case[] => JSON.parse(readFileSync(join(dir, `cases.${name}.json`), 'utf8'));
const cases = set === 'all' ? [...load('dev'), ...load('holdout')] : load(set);

const engine = new Engine(new Store(), new DispatchService());
const rows: { c: Case; state: string; action: string; authority: string; classifier: string }[] = [];
for (const c of cases) {
  const item = await engine.intake(c.text, classifier);
  rows.push({ c, state: item.state, action: item.action_type, authority: item.authority, classifier: item.classifier });
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
const stateHits = rows.filter((r) => r.state === r.c.expected_state).length;
const actionHits = rows.filter((r) => r.action === r.c.expected_action).length;
const authHits = rows.filter((r) => r.authority === policyFor(r.c.expected_action).authority).length;
const bothHits = rows.filter((r) => r.state === r.c.expected_state && r.action === r.c.expected_action).length;
const fallbacks = rows.filter((r) => r.classifier.includes('fallback')).length;

// Safety-relevant: cases whose true action needs a human (approval or human-only) but were
// assigned autonomous authority. This is the error that would expand system authority.
const authorityUnderAssigned = rows.filter(
  (r) => policyFor(r.c.expected_action).authority !== 'autonomous' && r.authority === 'autonomous',
).length;

const labels = [...SITUATION_STATES];
const confusion = labels.map((exp) => labels.map((got) => rows.filter((r) => r.c.expected_state === exp && r.state === got).length));
const perClass = labels.map((s, i) => {
  const tp = confusion[i][i];
  const fp = labels.reduce((sum, _, j) => sum + (j === i ? 0 : confusion[j][i]), 0);
  const fn = confusion[i].reduce((a, b) => a + b, 0) - tp;
  return { state: s, support: tp + fn, precision: pct(tp, tp + fp), recall: pct(tp, tp + fn) };
});

const misses = rows.filter((r) => r.state !== r.c.expected_state || r.action !== r.c.expected_action);

const lines: string[] = [];
lines.push(`# Classification eval: set=${set}, classifier=${classifier}`, '');
lines.push(`Cases: ${rows.length}${classifier === 'llm' ? ` (rules fallbacks: ${fallbacks})` : ''}`, '');
lines.push('| Metric | Result |', '| --- | --- |');
lines.push(`| Situation state accuracy | ${stateHits}/${rows.length} (${pct(stateHits, rows.length)}) |`);
lines.push(`| Action type accuracy | ${actionHits}/${rows.length} (${pct(actionHits, rows.length)}) |`);
lines.push(`| State + action both correct | ${bothHits}/${rows.length} (${pct(bothHits, rows.length)}) |`);
lines.push(`| Authority level correct | ${authHits}/${rows.length} (${pct(authHits, rows.length)}) |`);
lines.push(`| Gated actions wrongly assigned autonomous authority | ${authorityUnderAssigned} |`, '');
lines.push('| State | Support | Precision | Recall |', '| --- | --- | --- | --- |');
for (const p of perClass) lines.push(`| ${p.state} | ${p.support} | ${p.precision} | ${p.recall} |`);
lines.push('', 'Confusion matrix (rows = expected, columns = predicted):', '');
lines.push(`| | ${labels.join(' | ')} |`, `| --- |${labels.map(() => ' --- |').join('')}`);
labels.forEach((l, i) => lines.push(`| **${l}** | ${confusion[i].join(' | ')} |`));
lines.push('', `Misses (${misses.length}):`, '');
for (const m of misses) {
  lines.push(`- \`${m.c.id}\` expected ${m.c.expected_state}/${m.c.expected_action}, got ${m.state}/${m.action}: "${m.c.text}"`);
}

const report = lines.join('\n');
console.log(report);
mkdirSync(join(dir, 'results'), { recursive: true });
writeFileSync(join(dir, 'results', `classification-${set}-${classifier}.md`), report + '\n');
