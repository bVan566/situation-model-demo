// Thin client for the Situation Model API. All rules live on the server.

const STATES = [
  ['NOW', 'requires action now', '--col-now'],
  ['NEXT', 'future trigger', '--col-next'],
  ['WAITING', 'external dependency', '--col-waiting'],
  ['DECISIONS', 'human judgment', '--col-decisions'],
  ['WATCHING', 'monitor only', '--col-watching'],
  ['CLOSED', 'terminal', '--col-closed'],
];

const EXAMPLES = [
  'Customer was charged twice for order 4417 and is requesting a refund of the duplicate charge.',
  'Customer asks for a copy of their March invoice. Covered by the standard billing reply process.',
  'Checkout service is down and customers are blocked from paying. On-call recommends a restart.',
  'Customer requests a scope change that would add two integrations and change the price of the contract.',
  'Waiting on legal to return the redlined MSA before we can countersign.',
  'Third-party email provider reports degraded delivery times; no current customer impact.',
  'Follow-up call with Acme is due next Tuesday to review onboarding progress.',
  'Contractor is requesting admin access to the production database.',
];

const FAULT_LABELS = {
  none: 'Normal',
  external_failure: 'Inject: external failure',
  external_timeout: 'Inject: timeout',
  crash_after_success: 'Inject: crash after success (stale state)',
};

let config = { faults: ['none'], scenarios: {}, llm_available: false };
let selectedId = null;

// ---------------------------------------------------------------- helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function banner(kind, text) {
  const el = document.getElementById('banner');
  el.className = `banner ${kind}`;
  el.textContent = text;
  el.hidden = false;
}

const isStale = (i) => i.action_status === 'in_flight' || i.action_status === 'unknown';

// ---------------------------------------------------------------- rendering

async function refresh() {
  const [{ data: items }, { data: metrics }] = await Promise.all([api('GET', '/items'), api('GET', '/metrics')]);
  renderMetrics(metrics);
  renderBoard(items);
  if (selectedId) await renderDetail(selectedId);
}

function renderMetrics(m) {
  const tiles = [
    [m.unauthorized_executions_blocked, 'unauthorized blocked'],
    [m.duplicate_executions_blocked, 'duplicates blocked'],
    [m.stale_states_detected, 'stale states detected'],
    [m.reconciliations_applied, 'reconciliations'],
    [m.external_failures + m.external_timeouts, 'external failures/timeouts'],
    [m.max_side_effects_per_item, 'max side effects per item'],
  ];
  document.getElementById('metrics').replaceChildren(
    ...tiles.map(([n, label]) => h('div', { class: 'metric' }, h('b', {}, n), h('span', {}, label))),
  );
}

function renderBoard(items) {
  const board = document.getElementById('board');
  board.replaceChildren(...STATES.map(([state, hint, color]) => {
    const inState = items.filter((i) => i.state === state);
    return h('div', { class: 'column', style: `--c: var(${color})` },
      h('header', {}, h('div', {}, state, h('small', {}, hint)), h('span', { class: 'count' }, inState.length)),
      h('div', { class: 'cards' }, inState.map(card)),
    );
  }));
}

function card(i) {
  return h('button', {
    class: `card${i.id === selectedId ? ' selected' : ''}`,
    'aria-label': `${i.id}: ${i.summary}`,
    onclick: () => { selectedId = i.id; refresh(); },
  },
  h('span', { class: 'id' }, i.id),
  h('span', { class: 'sum' }, i.summary),
  h('span', { class: 'badges' },
    h('span', { class: `badge ${i.authority}` }, i.authority.replace('_', ' ')),
    i.authority === 'approval_required' ? h('span', { class: 'badge' }, `approval: ${i.approval_status}`) : null,
    i.action_status !== 'none' ? h('span', { class: `badge ${isStale(i) ? 'stale' : i.action_status === 'succeeded' ? 'ok' : ''}` }, `action: ${i.action_status}`) : null,
  ));
}

async function renderDetail(id) {
  const { status, data } = await api('GET', `/items/${id}`);
  const panel = document.getElementById('detail');
  if (status !== 200) { selectedId = null; panel.replaceChildren(h('p', { class: 'empty' }, 'Item not found.')); return; }
  const { item, history, attempts, external } = data;
  const closed = item.state === 'CLOSED';

  const field = (label, value, tag) => [h('dt', {}, label), h('dd', {}, value || '—', tag ? ' ' : '', tag ? h('span', { class: `tag ${tag}` }, tag === 'ai' ? 'classifier' : 'policy') : '')];

  const approver = h('input', { placeholder: 'Your name', value: 'ops lead', 'aria-label': 'Approver name' });
  const fault = h('select', { 'aria-label': 'Fault injection' }, config.faults.map((f) => h('option', { value: f }, FAULT_LABELS[f] ?? f)));
  const moveTo = h('select', { 'aria-label': 'Move to state' }, STATES.map(([s]) => s).filter((s) => s !== item.state).map((s) => h('option', { value: s }, s)));

  const controls = h('div', { class: 'controls' },
    h('div', { class: 'row' },
      fault,
      h('button', { class: 'primary', style: 'margin:0;width:auto', disabled: closed && item.action_status !== 'succeeded' ? true : null, onclick: () => act(`/items/${id}/execute`, { fault: fault.value }) }, 'Execute'),
    ),
    item.authority === 'approval_required' && item.approval_status === 'pending' ? h('div', { class: 'row' },
      approver,
      h('button', { onclick: () => act(`/items/${id}/approve`, { by: approver.value }) }, 'Approve'),
      h('button', { class: 'danger', onclick: () => act(`/items/${id}/reject`, { by: approver.value, reason: 'rejected in UI' }) }, 'Reject'),
    ) : null,
    item.state === 'DECISIONS' ? h('div', { class: 'row' },
      h('button', { onclick: () => act(`/items/${id}/decide`, { outcome: 'close', by: approver.value || 'ops lead', note: 'decision recorded in UI' }) }, 'Record decision & close'),
      item.action_status === 'failed' ? h('button', { onclick: () => act(`/items/${id}/decide`, { outcome: 'retry', by: approver.value || 'ops lead' }) }, 'Decide: retry') : null,
    ) : null,
    h('div', { class: 'row' },
      h('button', { onclick: () => reconcile(id) }, 'Reconcile this item'),
      closed ? null : moveTo,
      closed ? null : h('button', { onclick: () => act(`/items/${id}/transition`, { to: moveTo.value, reason: 'moved in UI' }) }, 'Move'),
    ),
  );

  const extByKey = Object.fromEntries(external.map((e) => [e.idempotency_key, e]));
  const ledger = attempts.length === 0 ? h('p', { class: 'hint' }, 'No external action attempted yet.') : h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Idempotency key'), h('th', {}, 'Situation Model'), h('th', {}, 'Dispatch service'), h('th', {}, 'Side effects'))),
    h('tbody', {}, attempts.map((a) => {
      const e = extByKey[a.idempotency_key];
      const ext = e ? e.status : 'no record';
      const mismatch = a.status !== ext && !(a.status === 'failed' && ext === 'no record');
      return h('tr', {},
        h('td', {}, h('code', {}, a.idempotency_key)),
        h('td', { class: mismatch ? 'mismatch' : '' }, a.status),
        h('td', { class: mismatch ? 'mismatch' : '' }, ext),
        h('td', {}, e ? e.side_effects : 0));
    })));

  panel.replaceChildren(
    h('div', { class: 'id mono' }, item.id),
    h('h3', {}, item.summary),
    h('dl', { class: 'fields' },
      field('State', item.state),
      field('Action type', item.action_type, 'ai'),
      field('Authority', item.authority, 'det'),
      field('Approval', item.approval_status + (item.approved_by ? ` by ${item.approved_by}` : ''), 'det'),
      field('Owner', item.owner, 'det'),
      field('Next action', item.next_action),
      field('Trigger', item.trigger),
      field('Action status', item.action_status),
      field('Terminal condition', item.terminal_condition, 'det'),
      field('Closed reason', item.closed_reason),
      field('Classifier', `${item.classifier}: ${item.classifier_rationale}`),
      field('Last verified', item.last_verified_at),
    ),
    h('h2', {}, 'Controls'),
    controls,
    h('h2', {}, 'Internal vs external state'),
    ledger,
    h('h2', {}, 'History'),
    h('ol', { class: 'timeline' }, [...history].reverse().map((e) => h('li', {},
      h('span', { class: `k ${e.kind.endsWith('_blocked') || e.kind.includes('failed') || e.kind === 'stale_detected' || e.kind === 'anomaly_detected' ? 'blocked' : e.kind === 'reconciled' || e.kind === 'execution_succeeded' || e.kind === 'approval_granted' ? 'good' : ''}` },
        e.kind, e.from_state || e.to_state ? ` ${e.from_state ?? '·'} → ${e.to_state ?? '·'}` : ''),
      h('div', {}, e.detail),
      h('div', { class: 'meta' }, `${e.actor} · ${new Date(e.at).toLocaleTimeString()}`)))),
  );
}

// ---------------------------------------------------------------- actions

async function act(path, body) {
  const { status, data } = await api('POST', path, body);
  if (data.outcome) {
    const kind = { closed: 'ok', blocked: 'bad', failed: 'warn', pending: 'warn' }[data.outcome];
    banner(kind, `${data.outcome.toUpperCase()}${data.code ? ` (${data.code})` : ''}: ${data.detail}`);
  } else if (status >= 400) {
    banner(data.code === 'simulated_crash' ? 'bad' : 'warn', data.error ?? `HTTP ${status}`);
  } else {
    banner('info', `${data.id}: ${data.state} · authority ${data.authority} · approval ${data.approval_status}`);
  }
  await refresh();
}

async function reconcile(itemId) {
  const { data: r } = await api('POST', '/reconcile', itemId ? { item_id: itemId } : {});
  const changed = r.stale_corrected + r.failure_routed + r.not_delivered + r.anomalies;
  banner(changed ? 'ok' : 'info',
    `Reconciliation checked ${r.checked} attempt(s): ${r.stale_corrected} stale corrected, ${r.failure_routed} failures routed, ` +
    `${r.still_pending} still pending, ${r.anomalies} anomalies, ${r.consistent} consistent.` +
    (r.findings.filter((f) => f.result !== 'consistent').map((f) => ` [${f.item_id}] ${f.detail}.`).join('')));
  await refresh();
}

// ---------------------------------------------------------------- setup

async function init() {
  config = (await api('GET', '/config')).data;
  const example = document.getElementById('example');
  EXAMPLES.forEach((t) => example.append(h('option', { value: t }, t.length > 70 ? t.slice(0, 67) + '…' : t)));
  example.addEventListener('change', () => { document.getElementById('text').value = example.value; });

  const classifier = document.getElementById('classifier');
  if (!config.llm_available) {
    classifier.querySelector('option[value="llm"]').textContent = 'Claude (set ANTHROPIC_API_KEY to enable)';
    classifier.querySelector('option[value="llm"]').disabled = true;
  }

  document.getElementById('submit').addEventListener('click', async () => {
    const text = document.getElementById('text').value;
    const { status, data } = await api('POST', '/events', { text, classifier: classifier.value });
    if (status === 201) {
      selectedId = data.item.id;
      const i = data.item;
      banner('info', `${i.id} classified as ${i.state} (action: ${i.action_type}) → authority ${i.authority}` +
        (i.authority === 'approval_required' ? ', approval pending' : i.authority === 'human_only' ? ', system may never execute' : ''));
    } else banner('warn', data.error);
    await refresh();
  });

  document.getElementById('scenarios').replaceChildren(...Object.entries(config.scenarios).map(([key, title]) =>
    h('button', { onclick: async () => {
      const { data } = await api('POST', `/scenarios/${key}`);
      selectedId = data.item.id;
      banner('info', `${title}: ${data.next_step}`);
      await refresh();
    } }, title)));

  document.getElementById('reconcile-all').addEventListener('click', () => reconcile());
  document.getElementById('reset').addEventListener('click', async () => {
    await api('POST', '/reset');
    selectedId = null;
    document.getElementById('banner').hidden = true;
    document.getElementById('detail').replaceChildren(h('p', { class: 'empty' }, 'Select an item.'));
    await refresh();
  });
  await refresh();
}

init();
