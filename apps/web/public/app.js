/**
 * Workbench front end (AGENTS 16).
 *
 * Vanilla ESM, no framework, no build step. This file deliberately contains no
 * CAN or UDS logic: it renders what the backend already decoded and labels raw
 * trace data as raw (AGENTS 5, 34.3, 18).
 */

import { LineChart } from '/chart.js';

const state = {
  connected: false,
  live: false,
  samples: [],
  trace: [],
  charts: new Map(),
  selectedSignals: new Set(),
  actions: [],
};

const $ = (selector) => document.querySelector(selector);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
};

function row(cells, mono = []) {
  const tr = el('tr');
  cells.forEach((value, index) => {
    tr.append(el('td', { class: mono.includes(index) ? 'mono' : '', text: value == null ? '—' : String(value) }));
  });
  return tr;
}

function kv(target, entries) {
  const node = $(target);
  node.replaceChildren();
  for (const [label, value] of entries) {
    node.append(el('dt', { text: label }), el('dd', { text: value == null || value === '' ? '—' : String(value) }));
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${path} → ${response.status} ${text}`);
  }
  const type = response.headers.get('content-type') ?? '';
  return type.includes('json') ? response.json() : response.text();
}

function logError(error) {
  console.error(error);
  const line = $('#vehicle-line');
  line.textContent = `Fehler: ${error.message}`;
  line.classList.add('out-of-range');
}

/* ------------------------------------------------------------------ tabs */

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((other) => other.classList.toggle('active', other === tab));
    const view = tab.dataset.view;
    document.querySelectorAll('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
    if (view === 'graphs') for (const chart of state.charts.values()) chart.draw();
  });
}

/* ----------------------------------------------------------------- state */

function renderConnection(data) {
  $('#conn-state').textContent = data.connected ? (data.live ? 'live' : 'verbunden') : 'offline';
  $('#conn-state').className = `pill ${data.connected ? (data.live ? 'pill-live' : 'pill-online') : 'pill-offline'}`;
  $('#vehicle-line').classList.remove('out-of-range');
  $('#vehicle-line').textContent = data.connected ? `${data.vehicle} · ${data.vin ?? 'VIN unbekannt'}` : 'kein Fahrzeug verbunden';

  kv('#adapter-info', [
    ['Adapter', `${data.adapter.name} (${data.adapter.id})`],
    ['Typ', data.adapter.kind],
    ['Kanäle', data.adapter.channels.join(', ') || '—'],
    ['Transport', `${data.transport.kind} · ${data.transport.channel} · MTU ${data.transport.mtu}`],
  ]);
  kv('#vehicle-info', [
    ['Fahrzeug', data.vehicle],
    ['VIN', data.vin],
    ['Laufleistung', data.mileageKm != null ? `${data.mileageKm.toLocaleString('de-DE')} km` : null],
  ]);
  kv('#session-info', [
    ['Session', data.sessionId],
    ['Modus', data.demo ? 'Simulator' : 'real'],
    ['ECUs', data.ecus.length],
    ['DTCs', data.dtcs.length],
    ['Messwerte', data.samples.length],
  ]);

  $('#btn-live-start').disabled = !data.connected || data.live;
  $('#btn-live-stop').disabled = !data.live;
  $('#live-state').textContent = data.live ? 'läuft' : 'gestoppt';
}

function renderEcus(ecus) {
  const body = $('#ecu-rows');
  body.replaceChildren();
  for (const ecu of ecus) {
    const identification = ecu.identification.map((entry) => `${entry.label}: ${entry.value}`).join(' · ');
    body.append(
      row(
        [`${ecu.name}`, `${ecu.txId} → ${ecu.rxId}${ecu.extended ? ' (29-bit)' : ''}`, ecu.reachable ? 'ja' : 'nein', `0x${ecu.sessionType.toString(16)}`, `${ecu.p2Ms} ms`, ecu.services.join(' '), identification || ecu.lastError || '—'],
        [1, 3, 4, 5],
      ),
    );
  }
}

function renderDtcs(dtcs) {
  const body = $('#dtc-rows');
  body.replaceChildren();
  for (const dtc of dtcs) {
    body.append(
      row([dtc.code, dtc.description, dtc.ecu, dtc.status, dtc.severity, dtc.confirmed ? 'ja' : 'nein', dtc.pending ? 'ja' : 'nein'], [0, 3]),
    );
    const severityCell = body.lastElementChild?.children[4];
    if (severityCell) severityCell.className = `sev-${dtc.severity}`;
  }
  const counts = dtcs.reduce((acc, dtc) => {
    acc[dtc.severity] = (acc[dtc.severity] ?? 0) + 1;
    return acc;
  }, {});
  $('#dtc-summary').textContent = dtcs.length === 0
    ? 'keine Einträge'
    : `${dtcs.length} Einträge · ${Object.entries(counts).map(([severity, count]) => `${severity}: ${count}`).join(', ')}`;
}

function renderSignals(signals) {
  const picker = $('#signal-picker');
  picker.replaceChildren();
  for (const signal of signals) {
    const id = `sig-${signal.id}`;
    const checkbox = el('input', { type: 'checkbox', id, checked: signal.critical ? 'checked' : '' });
    if (signal.critical) state.selectedSignals.add(signal.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selectedSignals.add(signal.id);
      else state.selectedSignals.delete(signal.id);
    });
    picker.append(el('label', { for: id }, [checkbox, `${signal.name}${signal.unit ? ` [${signal.unit}]` : ''}`]));
  }
  ensureCharts(signals);
}

function ensureCharts(signals) {
  const host = $('#charts');
  for (const signal of signals) {
    if (state.charts.has(signal.id)) continue;
    const canvas = el('canvas', { class: 'chart' });
    host.append(el('div', { class: 'chart-card' }, [el('h4', { text: `${signal.name}${signal.unit ? ` · ${signal.unit}` : ''}` }), canvas]));
    state.charts.set(signal.id, new LineChart(canvas, { label: signal.name, unit: signal.unit ?? '' }));
  }
}

function renderLiveCards(samples) {
  const host = $('#live-cards');
  const bySignal = new Map();
  for (const sample of samples) bySignal.set(sample.signal, sample);
  const existing = new Map();
  for (const card of host.children) existing.set(card.dataset.signal, card);
  for (const [signal, sample] of bySignal) {
    let card = existing.get(signal);
    if (!card) {
      card = el('div', { class: 'card' });
      card.dataset.signal = signal;
      card.append(el('h3', { text: sample.name }), el('div', { class: 'live-value' }), el('span', { class: 'live-unit' }), el('div', { class: 'live-raw' }));
      host.append(card);
    }
    const value = card.querySelector('.live-value');
    value.textContent = sample.value;
    value.className = `live-value${sample.outOfRange ? ' out-of-range' : ''}`;
    card.querySelector('.live-unit').textContent = sample.unit ?? '';
    card.querySelector('.live-raw').textContent = `raw: ${sample.rawHex} · t=${sample.t} ms`;
  }
}

function renderStatistics(statistics, anomalies) {
  const body = $('#stat-rows');
  body.replaceChildren();
  for (const stat of statistics) {
    body.append(row([stat.name, stat.samples, stat.min, stat.max, stat.average, stat.delta, stat.unit ?? '—', stat.outOfRangeCount]));
  }
  const list = $('#anomaly-list');
  list.replaceChildren();
  if (anomalies.length === 0) list.append(el('li', { class: 'muted', text: 'keine Anomalien im aufgezeichneten Fenster' }));
  for (const anomaly of anomalies) list.append(el('li', { text: `${anomaly.signal}: ${anomaly.reason}` }));
}

function appendTrace(entry) {
  state.trace.push(entry);
  if (state.trace.length > 300) state.trace.shift();
  const body = $('#trace-rows');
  const tr = row([entry.t, entry.timestamp, entry.canId, entry.direction, entry.dlc, entry.data, entry.channel], [2, 5]);
  tr.children[3]?.classList.add(`dir-${entry.direction}`);
  body.prepend(tr);
  while (body.children.length > 300) body.lastElementChild?.remove();
}

function renderActions(actions) {
  const body = $('#log-rows');
  body.replaceChildren();
  for (const action of actions) {
    body.append(row([action.timestamp, action.kind, action.ecuId, action.description, action.result]));
  }
}

function applyState(data) {
  state.connected = data.connected;
  state.live = data.live;
  renderConnection(data);
  renderEcus(data.ecus);
  renderDtcs(data.dtcs);
  renderStatistics(data.statistics, data.anomalies);
  renderActions(data.actions);
  if (data.signals.length > 0 && $('#signal-picker').children.length === 0) renderSignals(data.signals);
  $('#trace-rows').replaceChildren();
  state.trace = [];
  for (const entry of data.trace) appendTrace(entry);
}

/* ------------------------------------------------------------------- SSE */

function connectStream() {
  const source = new EventSource('/api/stream');
  source.addEventListener('state', (event) => applyState(JSON.parse(event.data)));
  source.addEventListener('sample', (event) => {
    const sample = JSON.parse(event.data);
    state.samples.push(sample);
    if (state.samples.length > 4000) state.samples = state.samples.slice(-4000);
    renderLiveCards([sample]);
    state.charts.get(sample.signal)?.push(sample.signal, sample.t, Number(sample.value));
    state.charts.get(sample.signal)?.schedule();
  });
  source.addEventListener('trace', (event) => appendTrace(JSON.parse(event.data)));
  source.addEventListener('dtc', () => api('/api/state').then((data) => renderDtcs(data.dtcs)).catch(logError));
  source.addEventListener('ecu', (event) => {
    const ecu = JSON.parse(event.data);
    const ecus = state.ecusCache ?? [];
    const index = ecus.findIndex((candidate) => candidate.rxId === ecu.rxId);
    if (index >= 0) ecus[index] = ecu;
    else ecus.push(ecu);
    state.ecusCache = ecus;
    renderEcus(ecus);
  });
  source.addEventListener('analysis', (event) => renderAnalysis(JSON.parse(event.data)));
  source.addEventListener('error', (event) => {
    if (event.data) logError(new Error(JSON.parse(event.data).message ?? 'SSE Fehler'));
  });
  return source;
}

function renderAnalysis(result) {
  $('#analysis-source').textContent = `${result.provider} · Quelle: ${result.source} · Konfidenz ${Math.round(result.confidence * 100)} %`;
  const host = $('#analysis-out');
  host.replaceChildren(el('p', { text: result.summary }));
  for (const finding of result.findings) {
    host.append(
      el('div', { class: `finding sev-${finding.severity}` }, [
        el('h4', { text: `${finding.severity.toUpperCase()} · ${finding.title}` }),
        el('p', { text: finding.detail }),
      ]),
    );
  }
  host.append(el('h3', { text: 'Empfehlungen' }));
  const list = el('ul', { class: 'plain' });
  for (const recommendation of result.recommendations) list.append(el('li', { text: recommendation }));
  host.append(list);
  if (result.warnings?.length) {
    host.append(el('p', { class: 'muted small', text: result.warnings.join(' · ') }));
  }
}

/* ---------------------------------------------------------------- actions */

$('#btn-start').addEventListener('click', () => {
  api('/api/start', { method: 'POST' })
    .then((data) => {
      applyState(data);
      state.ecusCache = data.ecus;
    })
    .catch(logError);
});

$('#btn-identify').addEventListener('click', () => {
  api('/api/identify', { method: 'POST' })
    .then((data) => {
      state.ecusCache = data.ecus;
      renderEcus(data.ecus);
    })
    .catch(logError);
});

const scan = () => api('/api/dtc/scan', { method: 'POST' }).then((data) => renderDtcs(data.dtcs)).catch(logError);
$('#btn-scan').addEventListener('click', scan);
$('#btn-scan-2').addEventListener('click', scan);

$('#btn-live-start').addEventListener('click', () => {
  const signalIds = Array.from(state.selectedSignals);
  api('/api/live/start', { method: 'POST', body: JSON.stringify({ signalIds }) })
    .then((data) => {
      state.live = data.live;
      $('#live-state').textContent = 'läuft';
      renderConnection({ connected: state.connected, live: true, vehicle: $('#vehicle-line').textContent });
    })
    .catch(logError);
});

$('#btn-live-stop').addEventListener('click', () => {
  api('/api/live/stop', { method: 'POST' })
    .then(() => {
      state.live = false;
      $('#live-state').textContent = 'gestoppt';
    })
    .catch(logError);
});

$('#btn-marker').addEventListener('click', () => {
  const label = window.prompt('Marker-Label', 'Lastwechsel');
  if (!label) return;
  api('/api/marker', { method: 'POST', body: JSON.stringify({ label }) }).catch(logError);
});

$('#btn-analyze').addEventListener('click', () => {
  api('/api/analyze', { method: 'POST' }).then(renderAnalysis).catch(logError);
});

connectStream();
