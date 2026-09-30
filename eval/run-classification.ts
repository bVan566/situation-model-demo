// Runs the labeled evaluation cases through the real intake path (classifier +
// deterministic policy) and reports classification performance.
//
//   node eval/run-classification.ts [--set dev|holdout|all] [--classifier rules|llm] [--force]
//
// LLM runs are single-shot: the script refuses to overwrite an existing LLM result
// unless --force is passed, so a result cannot be quietly rerun until it looks better.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { LLM_MODEL, llmAvailable } from '../src/classifier/llm.ts';
import { SITUATION_STATES, type ActionType, type SituationState } from '../src/domain.ts';
import { Engine } from '../src/engine.ts';
import { DispatchService } from '../src/external/dispatch-service.ts';
import { policyFor } from '../src/policy.ts';
import { Store } from '../src/store.ts';

interface Case { id: string; text: string; expected_state: SituationState; expected_action: ActionType }

const { values } = parseArgs({ options: {
  set: { type: 'string', default: 'holdout' },
  classifier: { type: 'string', default: 'rules' },
  force: { type: 'boolean', default: false },
} });
const set = values.set as string;
const classifier = values.classifier === 'llm' ? 'llm' : 'rules';
const dir = import.meta.dirname;
const outBase = join(dir, 'results', `classification-${set}-${classifier}`);

if (classifier === 'llm' && !llmAvailable()) {
  console.error('LLM classifier requested but ANTHROPIC_API_KEY is not set (add it to .env; see .env.example).');
  process.exit(1);
}
if (classifier === 'llm' && existsSync(`${outBase}.md`) && !values.force) {
  console.error(`${outBase}.md already exists. LLM evaluations are single-shot; pass --force only with a documented reason.`);
  process.exit(1);
}

const caseFiles = set === 'all' ? ['dev', 'holdout'] : [set];
const raw = caseFiles.map((name) => readFileSync(join(dir, `cases.${name}.json`), 'utf8'));
const cases: Case[] = raw.flatMap((r) => JSON.parse(r));
const datasetHash = createHash('sha256').update(raw.join('')).digest('hex').slice(0, 16);

const engine = new Engine(new Store(), new DispatchService());
const rows: { c: Case; state: string; action: string; authority: string; classifier: string; rationale: string; summary: string; ms: number }[] = [];
const started = new Date();
for (const c of cases) {
  const t0 = performance.now();
  const item = await engine.intake(c.text, classifier);
  rows.push({
    c, state: item.state, action: item.action_type, authority: item.authority, classifier: item.classifier,
    rationale: item.classifier_rationale, summary: item.summary, ms: Math.round(performance.now() - t0),
  });
}

if (classifier === 'llm' && rows.every((r) => /LLM fallback, api_error:/.test(r.rationale))) {
  console.error('INVALID RUN: every case failed at the API level, so no model output was measured. Nothing written.');
  console.error(`First error: ${/LLM fallback, (.*)\)$/.exec(rows[0].rationale)?.[1] ?? 'unknown'}`);
  process.exit(1);
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
const stateHits = rows.filter((r) => r.state === r.c.expected_state).length;
const actionHits = rows.filter((r) => r.action === r.c.expected_action).length;
const authHits = rows.filter((r) => r.authority === policyFor(r.c.expected_action).authority).length;
const bothHits = rows.filter((r) => r.state === r.c.expected_state && r.action === r.c.expected_action).length;

// Safety-relevant: cases whose true action needs a human (approval or human-only) but were
// assigned autonomous authority. This is the error that would expand system authority.
const authorityUnderAssigned = rows.filter(
  (r) => policyFor(r.c.expected_action).authority !== 'autonomous' && r.authority === 'autonomous',
).length;

const fallbackRows = rows.filter((r) => r.classifier.includes('fallback'));
const fallbackReasons = new Map<string, number>();
for (const r of fallbackRows) {
  const reason = /LLM fallback, (\w+):/.exec(r.rationale)?.[1] ?? 'unknown';
  fallbackReasons.set(reason, (fallbackReasons.get(reason) ?? 0) + 1);
}

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
lines.push(`Dataset: ${caseFiles.map((f) => `cases.${f}.json`).join(' + ')}, ${rows.length} cases, sha256 prefix \`${datasetHash}\``);
if (classifier === 'llm') {
  const sdk = JSON.parse(readFileSync(join(dir, '..', 'node_modules', '@anthropic-ai', 'sdk', 'package.json'), 'utf8')).version;
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  lines.push(`Run: ${started.toISOString()}, single run, no retries of the evaluation`);
  lines.push(`Model: \`${LLM_MODEL}\`, effort \`low\`, max_tokens 1024, structured output (JSON schema), SDK @anthropic-ai/sdk ${sdk}, request timeout 20 s, 1 SDK retry, Node ${process.version}`);
  lines.push(`Scored through the full intake path: LLM output -> local validation -> deterministic policy. Cases where the app fell back to rules are scored as the app behaved (rules output), and counted below.`);
  lines.push(`Rules fallbacks: ${fallbackRows.length}/${rows.length}${fallbackRows.length ? ` (${[...fallbackReasons].map(([k, v]) => `${k}: ${v}`).join(', ')})` : ''}`);
  lines.push(`Latency per case (includes the API call): median ${ms[Math.floor(ms.length / 2)]} ms, max ${ms[ms.length - 1]} ms`);
}
lines.push('');
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
writeFileSync(`${outBase}.md`, report + '\n');
if (classifier === 'llm') {
  // Every model output, for audit: what the model said, not just whether it matched.
  const perCase = rows.map((r) => ({
    id: r.c.id, expected: `${r.c.expected_state}/${r.c.expected_action}`, got: `${r.state}/${r.action}`,
    correct: r.state === r.c.expected_state && r.action === r.c.expected_action,
    classifier: r.classifier, summary: r.summary, rationale: r.rationale, ms: r.ms,
  }));
  writeFileSync(`${outBase}.json`, JSON.stringify(perCase, null, 2) + '\n');
}
