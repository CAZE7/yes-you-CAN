/**
 * Workbench front end (AGENTS 16).
 *
 * Vanilla ESM, no framework, no build step. This file deliberately contains no
 * CAN or UDS logic: it renders what the backend already decoded and labels raw
 * trace data as raw (AGENTS 5, 34.3, 18).
 */

import { GraphBoard } from '/graphs.js';

const state = {
  connected: false,
  live: false,
  samples: [],
  trace: [],
  selectedSignals: new Set(),
  actions: [],
  dtcs: [],
  clearPrecheck: null,
};

/**
 * The graph board owns the shared chart state (window, cursor, selection).
 * It is created once and fed from three sources: the signal list, the recorded
 * history and the live SSE stream (AGENTS 16).
 */
const board = new GraphBoard();

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
    // A canvas has no layout size while its tab is hidden, so the charts have to
    // be measured and repainted the moment the tab becomes visible.
    if (view === 'graphs') {
      board.refresh();
      loadHistory();
    }
  });
}

/** Load the recorded history so the graphs can zoom into the past, not just the live window. */
async function loadHistory() {
  try {
    board.setHistory(await api('/api/history'));
  } catch (error) {
    // No session yet — the graphs simply stay empty until the first samples arrive.
    if (!/500|not started/.test(String(error.message))) console.warn('history not available', error);
  }
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
    ['Transport', data.mode === 'simulator' ? 'Simulator' : data.mode === 'replay' ? 'Replay' : 'Hardware'],
    ['Adapter-Auswahl', `${data.adapterSelection.id}${data.adapterSelection.config.device ? ` · ${data.adapterSelection.config.device}` : ''}`],
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
  state.dtcs = dtcs;
  for (const dtc of dtcs) {
    body.append(
      row(
        [
          dtc.isNew ? `${dtc.code} (neu)` : dtc.code,
          dtc.description,
          dtc.ecu,
          dtc.status,
          dtc.severity,
          dtc.confirmed ? 'ja' : 'nein',
          dtc.pending ? 'ja' : 'nein',
          dtc.hint ?? '—',
          formatSeen(dtc),
        ],
        [0, 3, 8],
      ),
    );
    const severityCell = body.lastElementChild?.children[4];
    if (severityCell) severityCell.className = `sev-${dtc.severity}`;
    if (dtc.isNew) body.lastElementChild?.classList.add('is-new');

    // Actions per row: "Details" opens the decoded entry and its freeze frame,
    // "Löschen" fills the guarded write form below. The clear itself stays behind
    // the explicit confirmation, never behind a single click (AGENTS 20, 25/26).
    const actions = el('td', { class: 'dtc-actions' }, [
      el('button', { text: 'Details', onclick: () => showDtcDetails(dtc) }),
      el('button', { class: 'danger', text: 'Löschen', onclick: () => prepareClear(dtc) }),
    ]);
    body.lastElementChild?.append(actions);
  }
  renderClearEcuOptions(dtcs);
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
  board.setSignals(signals);
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


/* ------------------------------------------------------- Freeze Frame (20) */

/**
 * Render one decoded freeze frame.
 *
 * The front end renders what it is given and never invents a field: the raw bytes
 * of the record stay visible next to the decoded values, and the notes of the
 * backend (truncated record, undocumented layout, leftover bytes) are shown as
 * notes instead of being swallowed (AGENTS 5, 18, 34.3).
 */
async function showFreezeFrame(dtc) {
  const panel = $('#dtc-detail');
  const body = $('#dtc-detail-body');
  $('#dtc-detail-title').textContent = `${dtc.code} · ${dtc.ecu}`;
  panel.hidden = false;
  body.replaceChildren(el('p', { class: 'muted small', text: 'Freeze Frame wird gelesen …' }));

  let snapshot;
  try {
    ({ snapshot } = await api('/api/dtc/snapshot', {
      method: 'POST',
      body: JSON.stringify({ rxId: dtc.rxId, code: dtc.code }),
    }));
  } catch (error) {
    body.replaceChildren(el('p', { class: 'out-of-range', text: `Freeze Frame nicht verfügbar: ${error.message}` }));
    return;
  }

  const nodes = [];
  const list = el('ul', { class: 'plain check-list' });
  const documented = snapshot.documented;
  list.append(el('li', { class: documented ? 'ok' : 'warn', text: documented ? 'Layout vollständig aus dem Definition-Paket dekodiert' : 'Layout nicht (vollständig) dokumentiert — Rohdaten bleiben erhalten' }));
  for (const note of snapshot.notes) list.append(el('li', { class: 'info', text: note }));
  if (snapshot.unassignedHex) list.append(el('li', { class: 'warn', text: `Nicht zugeordnete Bytes: ${snapshot.unassignedHex}` }));
  nodes.push(list);

  for (const field of snapshot.fields) {
    const rows = field.values.map((value) =>
      row([value.name, `${value.value}${value.unit ? ` ${value.unit}` : ''}`, value.rawHex, value.outOfRange ? 'außerhalb des definierten Bereichs' : 'in Ordnung'], [2]),
    );
    if (rows.length === 0) rows.push(row(['—', 'keine definierten Signale', field.rawHex, '—'], [2]));
    const table = el('table', { class: 'grid' }, [
      el('thead', {}, [el('tr', {}, [el('th', { text: 'Signal' }), el('th', { text: 'Wert' }), el('th', { text: 'Rohbytes' }), el('th', { text: 'Bewertung' })])]),
      el('tbody', {}, rows),
    ]);
    nodes.push(
      el('div', { class: 'freeze-field' }, [
        el('h4', { text: `${field.name} · ${field.did}` }),
        el('div', { class: 'freeze-raw', text: field.rawHex }),
        table,
      ]),
    );
  }
  if (snapshot.fields.length === 0) {
    nodes.push(el('p', { class: 'muted small', text: 'Für diesen Datensatz dokumentiert das Definition-Paket kein Layout.' }));
  }
  body.replaceChildren(...nodes);
}


/* ------------------------------------------------- DTC-Details (AGENTS 20) */

function formatSeen(dtc) {
  if (!dtc.firstSeen) return '—';
  const first = new Date(dtc.firstSeen);
  const last = new Date(dtc.lastSeen ?? dtc.firstSeen);
  const same = Math.abs(last.getTime() - first.getTime()) < 1000;
  return `${first.toLocaleTimeString('de-DE')}${same ? '' : ` → ${last.toLocaleTimeString('de-DE')}`}`;
}

/**
 * Details of one fault code: definition data, session history and the freeze
 * frame. Everything shown here comes from the backend; the front end adds no
 * interpretation of its own (AGENTS 5, 34.3).
 */
function showDtcDetails(dtc) {
  showFreezeFrame(dtc);
  const panel = $('#dtc-detail');
  panel.querySelector('h3').firstChild.textContent = `Fehlercode ${dtc.code} `;
  const extra = el('ul', { class: 'plain check-list' }, [
    el('li', { class: 'info', text: `ECU: ${dtc.ecu} · Status ${dtc.status} · Schwere ${dtc.severity}` }),
    el('li', { class: 'info', text: `Bestätigt: ${dtc.confirmed ? 'ja' : 'nein'} · Pending: ${dtc.pending ? 'ja' : 'nein'} · Test fehlgeschlagen: ${dtc.testFailed ? 'ja' : 'nein'}` }),
    el('li', { class: 'info', text: `Erstmals gesehen: ${dtc.firstSeen ? new Date(dtc.firstSeen).toLocaleString('de-DE') : 'unbekannt'}` }),
    el('li', { class: 'info', text: `Zuletzt gesehen: ${dtc.lastSeen ? new Date(dtc.lastSeen).toLocaleString('de-DE') : 'unbekannt'}` }),
    el('li', { class: dtc.hint ? 'ok' : 'warn', text: dtc.hint ? `Nächster Schritt: ${dtc.hint}` : 'Kein Hinweis im Definition-Paket dokumentiert' }),
  ]);
  const related = dtc.relatedSignals ?? [];
  if (related.length > 0) {
    extra.append(
      el('li', { class: 'info', text: `Zugehörige Signale (Definition): ${related.map((entry) => entry.name).join(', ')}` }),
    );
  }
  panel.querySelector('#dtc-detail-body').prepend(extra);
  if (dtc.isNew) panel.querySelector('#dtc-detail-body').prepend(el('p', { class: 'hint', text: 'Dieser Code ist im aktuellen Scan neu aufgetreten.' }));
}

/** Put a row's ECU into the guarded clear form; the write itself needs the confirmation. */
function prepareClear(dtc) {
  $('#dtc-detail').hidden = true;
  const select = $('#clear-ecu');
  if (!Array.from(select.options).some((option) => option.value === dtc.rxId)) {
    select.append(el('option', { value: dtc.rxId, text: `${dtc.ecu} (${dtc.rxId})` }));
  }
  select.value = dtc.rxId;
  $('#dtc-clear').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const status = $('#clear-status');
  status.replaceChildren(el('li', { class: 'info', text: `Vorbereitet: Fehlerspeicher von ${dtc.ecu} — Vorbedingungen prüfen und Löschvorgang bestätigen.` }));
  $('#clear-result').replaceChildren();
  $('#clear-confirm').checked = false;
  updateClearButton();
}

/* ------------------------------------------- Fehlerspeicher löschen (20/26) */

function currentVehicleState() {
  const voltage = Number.parseFloat($('#clear-voltage').value);
  return {
    stationary: $('#clear-stationary').checked,
    ignitionOn: $('#clear-ignition').checked,
    parkingBrake: $('#clear-parking').checked,
    ...(Number.isFinite(voltage) ? { batteryVoltage: voltage } : {}),
  };
}

/** One ECU option per ECU that currently reports a fault code. */
function renderClearEcuOptions(dtcs) {
  const select = $('#clear-ecu');
  const previous = select.value;
  const seen = new Map();
  for (const dtc of dtcs) if (dtc.rxId != null) seen.set(dtc.rxId, dtc.ecu);
  select.replaceChildren(
    ...Array.from(seen, ([rxId, name]) => el('option', { value: rxId, text: `${name} (${rxId})` })),
  );
  if (previous && seen.has(previous)) select.value = previous;
}

function renderClearChecks(target, checks) {
  target.replaceChildren();
  for (const entry of checks.failed) target.append(el('li', { class: 'fail', text: entry }));
  for (const entry of checks.warnings) target.append(el('li', { class: 'warn', text: entry }));
  if (checks.failed.length === 0) target.append(el('li', { class: 'info', text: 'Alle geprüften Vorbedingungen sind erfüllt.' }));
}

function updateClearButton() {
  const ready = state.clearPrecheck?.ok === true && $('#clear-confirm').checked;
  $('#btn-clear-execute').disabled = !ready;
}

$('#btn-clear-precheck').addEventListener('click', () => {
  const rxId = $('#clear-ecu').value;
  if (!rxId) return logError(new Error('kein Steuergerät ausgewählt'));
  api('/api/dtc/clear/precheck', { method: 'POST', body: JSON.stringify({ rxId, vehicleState: currentVehicleState() }) })
    .then(({ precheck }) => {
      state.clearPrecheck = precheck;
      const status = $('#clear-status');
      renderClearChecks(status, precheck);
      // The confirmation stays disabled until the preconditions are met: the backend
      // refuses a write anyway, and a UI that offers it would be lying (AGENTS 26).
      $('#clear-confirm').disabled = !precheck.ok;
      if (!precheck.ok) $('#clear-confirm').checked = false;
      updateClearButton();
    })
    .catch(logError);
});

$('#clear-confirm').addEventListener('change', updateClearButton);

$('#btn-clear-execute').addEventListener('click', () => {
  const rxId = $('#clear-ecu').value;
  if (!rxId || !$('#clear-confirm').checked) return;
  const result = $('#clear-result');
  result.replaceChildren(el('li', { class: 'info', text: 'Löschvorgang läuft …' }));
  api('/api/dtc/clear', { method: 'POST', body: JSON.stringify({ rxId, confirmed: true, vehicleState: currentVehicleState() }) })
    .then(({ result: cleared }) => {
      const lines = [
        el('li', { class: cleared.verified ? 'ok' : 'warn', text: `${cleared.ecu}: ${cleared.verified ? 'Löschvorgang durch erneutes Auslesen bestätigt' : 'Löschvorgang nicht bestätigt — Status unverändert'}` }),
        el('li', { class: 'info', text: `vorher: ${cleared.before.join(', ') || 'keine Einträge'}` }),
        el('li', { class: 'info', text: `nachher: ${cleared.after.join(', ') || 'keine Einträge'}` }),
        el('li', { class: 'ok', text: `entfernt: ${cleared.removed.join(', ') || '—'}` }),
      ];
      if (cleared.stillFailing.length > 0) {
        lines.push(el('li', { class: 'warn', text: `weiterhin gespeichert (Fehler liegt aktuell an): ${cleared.stillFailing.join(', ')}` }));
      }
      if (cleared.unchanged.length > 0) {
        lines.push(el('li', { class: 'fail', text: `unverändert (Steuergerät hat nicht gelöscht): ${cleared.unchanged.join(', ')}` }));
      }
      result.replaceChildren(...lines);
      state.clearPrecheck = null;
      $('#clear-confirm').checked = false;
      $('#clear-confirm').disabled = true;
      updateClearButton();
      return scan();
    })
    .catch((error) => {
      result.replaceChildren(el('li', { class: 'fail', text: `Löschen abgelehnt: ${error.message}` }));
    });
});

$('#btn-dtc-detail-close').addEventListener('click', () => {
  $('#dtc-detail').hidden = true;
});

/* ------------------------------------------------------------------- SSE */

function connectStream() {
  const source = new EventSource('/api/stream');
  source.addEventListener('state', (event) => applyState(JSON.parse(event.data)));
  source.addEventListener('sample', (event) => {
    const sample = JSON.parse(event.data);
    state.samples.push(sample);
    if (state.samples.length > 4000) state.samples = state.samples.slice(-4000);
    renderLiveCards([sample]);
    board.pushSample(sample);
  });
  source.addEventListener('trace', (event) => appendTrace(JSON.parse(event.data)));
  source.addEventListener('marker', (event) => board.addMarker(JSON.parse(event.data)));
  source.addEventListener('markers', (event) => board.setMarkers(JSON.parse(event.data)));
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

/* --------------------------------------------------------------- adapters */

/**
 * Adapter panel (AGENTS 4, 29).
 *
 * The list comes from the backend, which probes the host without opening a bus.
 * The form therefore shows exactly which settings an adapter needs and why it is
 * (not) usable — no silent fallback to the simulator if a device is missing.
 */
const adapterState = { selected: null, entries: [], describes: [] };

function renderAdapters(payload) {
  adapterState.selected = payload.selected;
  adapterState.entries = payload.adapters;
  const select = $('#adapter-select');
  select.replaceChildren();
  for (const entry of payload.adapters) {
    const option = el('option', { value: entry.id, text: entry.displayName });
    if (entry.id === payload.selected.id) option.selected = true;
    select.append(option);
  }
  const selected = payload.adapters.find((entry) => entry.id === payload.selected.id);
  const bitrates = $('#adapter-bitrate');
  bitrates.replaceChildren(el('option', { value: '', text: 'Standard' }));
  for (const bitrate of selected?.supportedBitrates ?? []) bitrates.append(el('option', { value: bitrate, text: bitrate }));
  bitrates.value = payload.selected.config.bitrate ?? '';

  $('#adapter-device').value = payload.selected.config.device ?? payload.selected.config.channel ?? '';
  $('#adapter-baud').value = payload.selected.config.baudRate ?? '';
  $('#adapter-trace').value = payload.selected.config.trace ?? '';
  $('#adapter-device').placeholder = selected?.requires.channel ? 'can0' : '/dev/ttyUSB0';

  const probe = $('#adapter-probe');
  probe.textContent = probe ? `${payload.mode} · ${selected?.probe.detail ?? ''}` : '';
  probe.classList.toggle('out-of-range', selected?.probe.available === false);
  const hints = $('#adapter-hints');
  hints.replaceChildren();
  for (const hint of selected?.probe.hints ?? []) hints.append(el('li', { text: hint }));

  const body = $('#adapter-rows');
  body.replaceChildren();
  for (const entry of payload.adapters) {
    const capabilities = Object.entries(entry.capabilities)
      .filter(([, value]) => value === true)
      .map(([key]) => key)
      .join(', ');
    const tr = row([
      entry.displayName,
      entry.kind,
      entry.probe.available ? 'ja' : 'nein',
      entry.probe.detail,
      `${capabilities}${entry.capabilities.channels > 1 ? `, ${entry.capabilities.channels} Kanäle` : ''}`,
    ]);
    if (entry.probe.available) tr.classList.add('ok-row');
    body.append(tr);
  }
}

async function loadAdapters() {
  try {
    renderAdapters(await api('/api/adapters'));
  } catch (error) {
    logError(error);
  }
}

function selectionFromForm() {
  const id = $('#adapter-select').value;
  const entry = adapterState.entries.find((candidate) => candidate.id === id);
  const config = {};
  const device = $('#adapter-device').value.trim();
  const bitrate = $('#adapter-bitrate').value;
  const baud = Number.parseInt($('#adapter-baud').value, 10);
  const trace = $('#adapter-trace').value.trim();
  if (device) {
    if (entry?.requires.channel) config.channel = device;
    else config.device = device;
  }
  if (bitrate) config.bitrate = bitrate;
  if (Number.isFinite(baud)) config.baudRate = baud;
  if (trace) config.trace = trace;
  return { id, config };
}

$('#adapter-select').addEventListener('change', () => {
  const id = $('#adapter-select').value;
  const entry = adapterState.entries.find((candidate) => candidate.id === id);
  $('#adapter-probe').textContent = entry?.description ?? '';
  if (entry?.defaults?.device) $('#adapter-device').value = entry.defaults.device;
  if (entry?.defaults?.channel && entry.requires.channel) $('#adapter-device').value = entry.defaults.channel;
});

$('#btn-adapter-apply').addEventListener('click', () => {
  api('/api/adapter/select', { method: 'POST', body: JSON.stringify(selectionFromForm()) })
    .then(async (result) => {
      await loadAdapters();
      // A selection change drops a running connection on purpose: the engine
      // must never keep talking over a transport the operator just replaced.
      if (result.reconnectRequired) await api('/api/start', { method: 'POST' }).then(applyState);
      else applyState(await api('/api/state'));
    })
    .catch(logError);
});

/* ---------------------------------------------------------------- actions */

$('#btn-start').addEventListener('click', () => {
  api('/api/start', { method: 'POST' })
    .then((data) => {
      applyState(data);
      state.ecusCache = data.ecus;
      return loadHistory();
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
void loadAdapters();
