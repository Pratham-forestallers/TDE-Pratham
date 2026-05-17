const state = {
  processing: false,
  initialized: false,
  objectTypesByKey: new Map()
};

const elements = {
  transferForm: document.getElementById('transferForm'),
  sourceSystem: document.getElementById('sourceSystem'),
  targetSystem: document.getElementById('targetSystem'),
  objectType: document.getElementById('objectType'),
  objectId: document.getElementById('objectId'),
  objectIdLabel: document.getElementById('objectIdLabel'),
  newRunButton: document.getElementById('newRunButton'),
  previewButton: document.getElementById('previewButton'),
  synthesizeButton: document.getElementById('synthesizeButton'),
  runButton: document.getElementById('runButton'),
  runSyntheticButton: document.getElementById('runSyntheticButton'),
  confirmSyntheticButton: document.getElementById('confirmSyntheticButton'),
  downloadSyntheticButton: document.getElementById('downloadSyntheticButton'),
  historyRefreshButton: document.getElementById('historyRefreshButton'),
  historyList: document.getElementById('historyList'),
  loadingIndicator: document.getElementById('loadingIndicator'),
  statusMessage: document.getElementById('statusMessage'),
  resultSummary: document.getElementById('resultSummary'),
  resultOutput: document.getElementById('resultOutput'),
  healthBadge: document.getElementById('healthBadge'),
  themeToggle: document.getElementById('themeToggle'),
  themeToggleLabel: document.getElementById('themeToggleLabel'),
  // Synthetic options
  syntheticOptionsPanel: document.getElementById('syntheticOptionsPanel'),
  maskPhoneNumbers: document.getElementById('maskPhoneNumbers'),
  generateCount: document.getElementById('generateCount'),
  sampleMode: document.getElementById('sampleMode'),
  sampleTopOptions: document.getElementById('sampleTopOptions'),
  sampleTopCount: document.getElementById('sampleTopCount'),
  sampleRandomOptions: document.getElementById('sampleRandomOptions'),
  sampleRandomCount: document.getElementById('sampleRandomCount'),
  sampleRangeOptions: document.getElementById('sampleRangeOptions'),
  sampleRangeFrom: document.getElementById('sampleRangeFrom'),
  sampleRangeTo: document.getElementById('sampleRangeTo')
};

const themeStorageKey = 'tde-theme';

function getInitialTheme() {
  const savedTheme = window.localStorage.getItem(themeStorageKey);

  if (savedTheme === 'light' || savedTheme === 'dark') {
    return savedTheme;
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  elements.themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
  elements.themeToggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
  elements.themeToggleLabel.textContent = theme === 'dark' ? 'Dark' : 'Light';
}

function initializeTheme() {
  applyTheme(getInitialTheme());

  elements.themeToggle.addEventListener('click', () => {
    const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    window.localStorage.setItem(themeStorageKey, nextTheme);
    applyTheme(nextTheme);
  });
}

function setProcessing(isProcessing) {
  state.processing = isProcessing;
  elements.loadingIndicator.hidden = !isProcessing;
  updateActionState();
}

function updateActionState() {
  const disabled = state.processing || !state.initialized;
  elements.previewButton.disabled = disabled;
  elements.synthesizeButton.disabled = disabled;
  elements.runButton.disabled = disabled;
  elements.runSyntheticButton.disabled = disabled;
  elements.confirmSyntheticButton.disabled = disabled;
  elements.downloadSyntheticButton.disabled = disabled;
  elements.historyRefreshButton.disabled = disabled;
  elements.newRunButton.disabled = disabled;
}

function setStatus(message, type = 'info') {
  elements.statusMessage.textContent = message;
  elements.statusMessage.className = `status-message ${type === 'info' ? '' : type}`;
}

function getSelectedObjectType() {
  return state.objectTypesByKey.get(String(elements.objectType.value));
}

function updateObjectIdPrompt() {
  const objectType = getSelectedObjectType();

  elements.objectIdLabel.textContent = objectType?.objectIdLabel || 'Object ID';
  elements.objectId.placeholder = objectType?.objectIdPlaceholder || 'Enter object ID';
}

function clearResultSummary() {
  elements.resultSummary.hidden = true;
  elements.resultSummary.innerHTML = '';
}

function createSummaryCell(value, className) {
  const cell = document.createElement('div');
  cell.className = className || '';
  cell.textContent = value;
  return cell;
}

function createBadge(value, status) {
  const badge = document.createElement('span');
  badge.className = `status-badge ${String(status || value || '').toLowerCase()}`;
  badge.textContent = value || '';
  return badge;
}

function formatRunTime(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function getGeneratedKeyText(generatedKeys) {
  return (generatedKeys || [])
    .map((key) => `${key.field}: ${key.targetValue}`)
    .join(', ');
}

function createResultTable(columns, rows, className = 'data-table') {
  const wrapper = document.createElement('div');
  wrapper.className = 'table-shell';

  const table = document.createElement('table');
  table.className = className;

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');

  for (const column of columns) {
    const th = document.createElement('th');
    th.textContent = column.label;
    headerRow.appendChild(th);
  }

  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  rows.forEach((row, rowIndex) => {
    const tr = document.createElement('tr');

    for (const column of columns) {
      const td = document.createElement('td');
      const value = column.render ? column.render(row, rowIndex) : row[column.key];

      if (value instanceof Node) {
        td.appendChild(value);
      } else {
        td.textContent = value === undefined || value === null ? '' : String(value);
      }

      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  wrapper.appendChild(table);

  return wrapper;
}

function renderGeneratedKeys(payload) {
  const generatedKeys = Array.isArray(payload?.generatedKeys)
    ? payload.generatedKeys
    : Array.isArray(payload?.error?.details?.generatedKeys)
      ? payload.error.details.generatedKeys
      : [];

  if (generatedKeys.length === 0) {
    return;
  }

  const section = document.createElement('section');
  section.className = 'summary-section';

  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = payload.renumbered ? 'Generated Keys' : 'Keys';
  section.appendChild(heading);

  section.appendChild(createResultTable([
    { label: 'Field', key: 'field' },
    { label: 'Original', key: 'sourceValue' },
    { label: 'Generated', key: 'targetValue', render: (row) => {
      const span = document.createElement('span');
      span.className = 'generated-value';
      span.textContent = row.targetValue || '';
      return span;
    } },
    { label: 'Number Range', render: (row) => row.numberRangeObject || row.source || '' }
  ], generatedKeys));

  elements.resultSummary.appendChild(section);
}

function renderPreflight(payload) {
  const preflight = payload?.preflight || payload?.error?.details?.preflight;

  if (!preflight) {
    return;
  }

  const section = document.createElement('section');
  section.className = 'summary-section';

  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = `Preflight ${preflight.status || ''}`;
  section.appendChild(heading);

  const checks = Array.isArray(preflight.checks) ? preflight.checks : [];
  section.appendChild(createResultTable([
    { label: 'Table', render: (row, index) => row.table || `Step ${index + 1}` },
    { label: 'Status', render: (row) => createBadge(row.status, row.status) },
    { label: 'Source Rows', render: (row) => row.sourceRecordCount || 0 },
    { label: 'Target Existing', render: (row) => row.targetRecordCount || 0 },
    { label: 'Detail', render: (row) => row.reason || row.error || '' }
  ], checks));

  elements.resultSummary.appendChild(section);
}

function renderCleanupGuidance(payload) {
  const guidance = payload?.cleanupGuidance || payload?.error?.details?.cleanupGuidance;

  if (!guidance) {
    return;
  }

  const section = document.createElement('section');
  section.className = 'summary-section';

  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = guidance.status === 'PARTIAL_WRITE' ? 'Cleanup Needed' : 'Cleanup Guidance';
  section.appendChild(heading);

  const body = document.createElement('div');
  body.className = guidance.status === 'PARTIAL_WRITE' ? 'guidance-body warning-text' : 'guidance-body muted';
  body.textContent = guidance.message || guidance.suggestedAction || '';
  section.appendChild(body);

  const insertedTables = Array.isArray(guidance.insertedTables) ? guidance.insertedTables : [];

  if (insertedTables.length > 0) {
    section.appendChild(createResultTable([
      { label: 'Table', render: (row, index) => row.table || `Step ${index + 1}` },
      { label: 'Rows', key: 'insertedRows' }
    ], insertedTables));
  }

  const traceId = getTraceIdFromPayload(payload);

  if (guidance.status === 'PARTIAL_WRITE' && traceId && payload?.rollback?.status !== 'SUCCESS') {
    const actions = document.createElement('div');
    actions.className = 'summary-actions';

    const rollbackButton = document.createElement('button');
    rollbackButton.type = 'button';
    rollbackButton.className = 'danger';
    rollbackButton.textContent = 'Rollback Partial Data';
    rollbackButton.addEventListener('click', () => {
      rollbackRun(traceId).catch((error) => {
        setResult(error.payload || { success: false, error: { message: error.message } });
        setStatus(error.message, 'error');
        setProcessing(false);
      });
    });

    actions.appendChild(rollbackButton);
    section.appendChild(actions);
  }

  elements.resultSummary.appendChild(section);
}

function getVerificationText(entry) {
  const comparison = entry?.diagnostics?.verification?.comparison;

  if (!comparison) {
    return entry?.diagnostics?.verification?.error || 'No verification details';
  }

  return `${comparison.missingFieldCount || 0} missing, ${comparison.blankedFieldCount || 0} blanked, ${comparison.differentFieldCount || 0} different`;
}

function renderTableDetails(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return;
  }

  const section = document.createElement('section');
  section.className = 'summary-section';

  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = 'Processing Details';
  section.appendChild(heading);

  results.forEach((entry, index) => {
    const detail = document.createElement('details');
    detail.className = 'table-detail';

    const summary = document.createElement('summary');
    summary.textContent = `${entry.table || `Step ${index + 1}`} - ${entry.status} (${entry.succeeded || 0}/${entry.attempted || 0})`;
    detail.appendChild(summary);

    const grid = document.createElement('div');
    grid.className = 'detail-grid';
    grid.append(
      createSummaryCell('Attempted', 'detail-label'),
      createSummaryCell(String(entry.attempted || 0), 'detail-value'),
      createSummaryCell('Succeeded', 'detail-label'),
      createSummaryCell(String(entry.succeeded || 0), 'detail-value'),
      createSummaryCell('Insert Fields', 'detail-label'),
      createSummaryCell(String(entry.diagnostics?.insertFieldCount || 0), 'detail-value'),
      createSummaryCell('Verification', 'detail-label'),
      createSummaryCell(getVerificationText(entry), 'detail-value')
    );

    if (entry.error) {
      grid.append(
        createSummaryCell('Error', 'detail-label'),
        createSummaryCell(entry.error, 'detail-value error-text')
      );
    }

    detail.appendChild(grid);
    section.appendChild(detail);
  });

  elements.resultSummary.appendChild(section);
}

function renderRunHistory(payload) {
  const runs = Array.isArray(payload?.runs) ? payload.runs : [];

  if (runs.length === 0) {
    return false;
  }

  elements.resultSummary.appendChild(createResultTable([
    { label: 'Completed', render: (row) => formatRunTime(row.completedAt || row.startedAt) },
    { label: 'Status', render: (row) => createBadge(row.status, row.status) },
    { label: 'Generated Object', render: (row) => {
      const span = document.createElement('span');
      span.className = 'generated-value';
      span.textContent = row.objectId || '';
      return span;
    } },
    { label: 'Generated Keys', render: (row) => getGeneratedKeyText(row.generatedKeys) || '-' }
  ], runs));

  return true;
}

function renderSidebarHistory(runs) {
  elements.historyList.innerHTML = '';

  if (!Array.isArray(runs) || runs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No runs yet.';
    elements.historyList.appendChild(empty);
    return;
  }

  runs.slice(0, 8).forEach((run, index) => {
    const card = document.createElement('div');
    card.className = `history-card ${index === 0 ? 'current' : ''}`;
    card.setAttribute('role', 'button');
    card.tabIndex = 0;

    const title = document.createElement('span');
    title.className = 'history-card__title';
    const runLabel = index === 0 ? 'Current Run' : index === 1 ? 'Last Run' : `Run ${index + 1}`;
    title.textContent = run.synthetic ? `${runLabel} ⚗` : runLabel;

    const meta = document.createElement('span');
    meta.className = 'history-card__meta';
    meta.textContent = `${run.objectType || ''} ${run.objectId || ''}`.trim();

    const footer = document.createElement('span');
    footer.className = 'history-card__footer';
    footer.append(
      createBadge(run.status || '', run.status),
      document.createTextNode(formatRunTime(run.completedAt || run.startedAt))
    );

    const keys = document.createElement('span');
    keys.className = 'history-card__keys';
    if (run.synthetic && run.generatedIdRange) {
      keys.textContent = `${run.pkField || 'Keys'}: ${run.generatedIdRange}`;
    } else {
      keys.textContent = getGeneratedKeyText(run.generatedKeys) || 'No generated keys';
    }

    card.append(title, meta, keys, footer);

    if (canRollbackRun(run)) {
      const rollbackButton = document.createElement('button');
      rollbackButton.type = 'button';
      rollbackButton.className = 'history-card__rollback danger';
      rollbackButton.textContent = 'Rollback';
      rollbackButton.addEventListener('click', (event) => {
        event.stopPropagation();
        rollbackRun(run.traceId).catch((error) => {
          setResult(error.payload || { success: false, error: { message: error.message } });
          setStatus(error.message, 'error');
          setProcessing(false);
        });
      });
      card.appendChild(rollbackButton);
    }

    const showRun = () => {
      setResult({
        success: run.status === 'SUCCESS',
        ...run
      });
      setStatus(`Showing ${title.textContent.toLowerCase()}.`, run.status === 'SUCCESS' ? 'success' : 'error');
    };

    card.addEventListener('click', showRun);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        showRun();
      }
    });

    elements.historyList.appendChild(card);
  });
}

function canRollbackRun(run) {
  return run?.traceId &&
    run?.cleanupGuidance?.status === 'PARTIAL_WRITE' &&
    run?.rollback?.status !== 'SUCCESS';
}

function renderResultSummary(payload) {
  clearResultSummary();

  renderGeneratedKeys(payload);
  renderSyntheticInfo(payload);
  renderPreflight(payload);
  renderCleanupGuidance(payload);

  if (renderRunHistory(payload)) {
    elements.resultSummary.hidden = false;
    return;
  }

  const previewTables = payload?.summary?.tables;
  const runResults = payload?.results;
  const rows = Array.isArray(previewTables)
    ? previewTables.map((entry, index) => ({
      table: entry.table || `Step ${index + 1}`,
      status: entry.status,
      count: entry.rowCount,
      detail: entry.reason || `${entry.sampleFieldCount || 0} fields`
    }))
    : Array.isArray(runResults)
      ? runResults.map((entry, index) => ({
        table: entry.table || `Step ${index + 1}`,
        status: entry.status,
        count: entry.succeeded || entry.attempted || 0,
        detail: entry.reason || `${entry.attempted || 0} attempted`
      }))
      : [];

  if (rows.length === 0) {
    elements.resultSummary.hidden = elements.resultSummary.children.length === 0;
    return;
  }

  const section = document.createElement('section');
  section.className = 'summary-section';

  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = Array.isArray(previewTables) ? 'Preview Summary' : 'Table Results';
  section.appendChild(heading);
  section.appendChild(createResultTable([
    { label: 'Table', key: 'table' },
    { label: 'Status', render: (row) => createBadge(row.status, row.status) },
    { label: 'Rows', key: 'count' },
    { label: 'Detail', key: 'detail' }
  ], rows));

  elements.resultSummary.appendChild(section);
  renderTableDetails(runResults);
  elements.resultSummary.hidden = false;
}

function stripBackendTableNames(entries) {
  return entries;
}

function stripRollbackRows(entries) {
  if (!Array.isArray(entries)) {
    return entries;
  }

  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      return entry;
    }

    const { rollbackRows, ...rest } = entry;

    if (Array.isArray(rollbackRows)) {
      return {
        ...rest,
        rollbackRowCount: rollbackRows.length
      };
    }

    return rest;
  });
}

function sanitizePayloadForDisplay(payload) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const sanitized = {
    ...payload,
    results: stripRollbackRows(stripBackendTableNames(payload.results))
  };

  if (payload.summary) {
    sanitized.summary = {
      ...payload.summary,
      tables: stripBackendTableNames(payload.summary.tables)
    };
  }

  if (payload.cleanupGuidance) {
    sanitized.cleanupGuidance = {
      ...payload.cleanupGuidance,
      insertedTables: stripBackendTableNames(payload.cleanupGuidance.insertedTables),
      failedTable: payload.cleanupGuidance.failedTable
    };
  }

  if (payload.preflight) {
    sanitized.preflight = {
      ...payload.preflight,
      checks: stripBackendTableNames(payload.preflight.checks)
    };
  }

  if (payload.error?.details) {
    sanitized.error = {
      ...payload.error,
      details: sanitizePayloadForDisplay(payload.error.details)
    };
  }

  return sanitized;
}

function setResult(payload) {
  renderResultSummary(payload);
  elements.resultOutput.textContent = JSON.stringify(sanitizePayloadForDisplay(payload), null, 2);
}

function getTraceIdFromPayload(payload) {
  return payload?.traceId || payload?.error?.details?.traceId || payload?.run?.traceId;
}

function startNewRun() {
  elements.objectId.value = '';
  clearResultSummary();
  elements.resultOutput.textContent = '{}';
  setStatus(`Enter ${elements.objectIdLabel.textContent.toLowerCase()} and run a preview.`);
  elements.objectId.focus();
}

function populateSelect(select, options, labelFactory, valueFactory = (option) => option.key || option) {
  select.innerHTML = '';

  for (const option of options) {
    const node = document.createElement('option');
    node.value = valueFactory(option);
    node.textContent = labelFactory(option);
    select.appendChild(node);
  }
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || 60000;
  const { timeoutMs: ignoredTimeoutMs, ...fetchOptions } = options;
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(fetchOptions.headers || {})
    },
    signal: controller.signal,
    ...fetchOptions
  }).finally(() => window.clearTimeout(timeout));

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = payload.error?.message || `Request failed with status ${response.status}`;
    const error = new Error(message);
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function rollbackRun(traceId) {
  if (!traceId) {
    throw new Error('A run trace ID is required for rollback.');
  }

  setProcessing(true);
  setStatus('Rollback in progress...');

  try {
    const result = await requestJson(`/api/runs/${encodeURIComponent(traceId)}/rollback`, {
      method: 'POST',
      body: JSON.stringify({}),
      timeoutMs: 180000
    });

    setResult(result);
    setStatus('Rollback completed.', 'success');
    loadRunHistory({ silent: true }).catch(() => {});
  } catch (error) {
    setResult(error.payload || { success: false, error: { message: error.message } });
    setStatus(error.message, 'error');
  } finally {
    setProcessing(false);
  }
}

function getSyntheticSamplingPayload() {
  const mode = elements.sampleMode.value;
  const generateCount = parseInt(elements.generateCount.value, 10) || 100;
  const sampling = { mode, generateCount };

  if (mode === 'top') {
    sampling.sampleCount = parseInt(elements.sampleTopCount.value, 10) || 500;
  } else if (mode === 'random') {
    sampling.sampleCount = parseInt(elements.sampleRandomCount.value, 10) || 200;
  } else if (mode === 'range') {
    sampling.sampleFrom = parseInt(elements.sampleRangeFrom.value, 10) || 0;
    sampling.sampleTo   = parseInt(elements.sampleRangeTo.value, 10) || 200;
  }
  return sampling;
}

function getFormPayload(synthesize = false) {
  const base = {
    sourceSystem: elements.sourceSystem.value,
    targetSystem: elements.targetSystem.value,
    objectKey: elements.objectType.value,
    objectId: elements.objectId.value.trim(),
    synthesize: synthesize,
    maskPhoneNumbers: elements.maskPhoneNumbers.checked
  };
  if (synthesize) {
    Object.assign(base, getSyntheticSamplingPayload());
  }
  return base;
}

function validatePayload(payload) {
  if (!payload.sourceSystem || !payload.targetSystem || !payload.objectKey || !payload.objectId) {
    throw new Error('Select systems, choose an object type, and enter an object ID.');
  }
}

function handleMissingObjectId() {
  elements.objectId.focus();
  setStatus('Fill the object ID before running the transfer.', 'error');
  setResult({
    success: false,
    error: {
      message: 'Object ID is required'
    }
  });
}

function getSuccessStatusMessage(result, label) {
  const recordsProcessed = result?.summary?.recordsProcessed;

  if (label === 'Transfer' && recordsProcessed === 0) {
    return 'Transfer finished, but no records were written.';
  }

  if (label === 'Transfer' && result?.renumbered && result?.objectId) {
    return `Transfer completed with generated object ${result.objectId}.`;
  }

  if (label === 'Transfer' && result?.synthetic && result?.generatedIdRange) {
    return `Synthetic Transfer completed. Range: ${result.generatedIdRange}`;
  }

  return `${label} completed.`;
}

async function submitTransfer(endpoint, label, synthesize = false) {
  setProcessing(true);
  setStatus(`${label} in progress...`);

  try {
    const payload = getFormPayload(synthesize);
    validatePayload(payload);

    const result = await requestJson(endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
      timeoutMs: label === 'Transfer' ? 180000 : 120000
    });

    setResult(result);
    setStatus(getSuccessStatusMessage(result, label), 'success');
    if (label === 'Transfer') {
      loadRunHistory({ silent: true }).catch(() => {});
    }
  } catch (error) {
    setResult(error.payload || { success: false, error: { message: error.message } });
    setStatus(error.message, 'error');
  } finally {
    setProcessing(false);
  }
}

async function loadRunHistory(options = {}) {
  if (!options.silent) {
    setProcessing(true);
    setStatus('Loading run history...');
  }

  try {
    const result = await requestJson('/api/runs', { timeoutMs: 30000 });
    renderSidebarHistory(result.runs);

    if (!options.silent) {
      setResult(result);
      setStatus(`Loaded ${result.runs?.length || 0} recent runs.`, 'success');
    }
  } catch (error) {
    if (!options.silent) {
      setResult(error.payload || { success: false, error: { message: error.message } });
      setStatus(error.message, 'error');
    }
  } finally {
    if (!options.silent) {
      setProcessing(false);
    }
  }
}

async function initialize() {
  setProcessing(true);
  setStatus('Loading BTP destinations...');

  try {
    const [systemsResponse, objectTypesResponse] = await Promise.all([
      requestJson('/api/systems', { timeoutMs: 30000 }),
      requestJson('/api/object-types', { timeoutMs: 30000 })
    ]);

    if (!Array.isArray(systemsResponse.systems) || systemsResponse.systems.length === 0) {
      throw new Error('No SAP BTP destinations were found for this app.');
    }

    populateSelect(
      elements.sourceSystem,
      systemsResponse.systems,
      (system) => `${system.key} - ${system.name}`
    );
    populateSelect(
      elements.targetSystem,
      systemsResponse.systems,
      (system) => `${system.key} - ${system.name}`
    );
    populateSelect(
      elements.objectType,
      objectTypesResponse.objectTypes,
      (objectType) => objectType.description || objectType,
      (objectType) => objectType.objectKey || objectType
    );
    state.objectTypesByKey = new Map(
      (objectTypesResponse.objectTypes || []).map((objectType) => [
        String(objectType.objectKey || objectType),
        objectType
      ])
    );
    updateObjectIdPrompt();

    state.initialized = true;

    if (elements.targetSystem.options.length > 1) {
      elements.targetSystem.selectedIndex = 1;
    }

    elements.healthBadge.textContent = 'Online';
    setStatus(`Enter ${elements.objectIdLabel.textContent.toLowerCase()} and run a preview.`);
    loadRunHistory({ silent: true }).catch(() => {});
  } catch (error) {
    state.initialized = false;
    elements.healthBadge.textContent = 'Error';
    setStatus(error.name === 'AbortError' ? 'Loading destinations timed out.' : error.message, 'error');
    setResult(error.payload || { success: false, error: { message: error.message } });
  } finally {
    setProcessing(false);
  }
}

elements.previewButton.addEventListener('click', () => {
  submitTransfer('/api/preview', 'Preview', false).catch((error) => {
    setResult({ success: false, error: { message: error.message } });
    setStatus(error.message, 'error');
    setProcessing(false);
  });
});

elements.synthesizeButton.addEventListener('click', () => {
  submitTransfer('/api/preview', 'Synthesis', true).catch((error) => {
    setResult({ success: false, error: { message: error.message } });
    setStatus(error.message, 'error');
    setProcessing(false);
  });
});

elements.runButton.addEventListener('click', () => {
  submitTransfer('/api/run', 'Transfer', false).catch((error) => {
    setResult({ success: false, error: { message: error.message } });
    setStatus(error.message, 'error');
    setProcessing(false);
  });
});

elements.runSyntheticButton.addEventListener('click', () => {
  // Step 1: just reveal the options panel — do NOT start the transfer yet
  elements.syntheticOptionsPanel.hidden = false;
  elements.confirmSyntheticButton.focus();
});

elements.confirmSyntheticButton.addEventListener('click', () => {
  // Step 2: user has configured options and is ready to run
  if (!elements.objectId.value.trim()) {
    handleMissingObjectId();
    return;
  }
  submitTransfer('/api/run', 'Synthetic Transfer', true).catch((error) => {
    setResult({ success: false, error: { message: error.message } });
    setStatus(error.message, 'error');
    setProcessing(false);
  });
});

elements.downloadSyntheticButton.addEventListener('click', async () => {
  if (state.processing) return;
  // Show options panel
  elements.syntheticOptionsPanel.hidden = false;
  setProcessing(true);
  setStatus('Generating synthetic data, please wait...', 'info');
  try {
    const payload = getFormPayload(true); // include sampling opts
    const response = await fetch('/api/download-synthetic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: { message: response.statusText } }));
      throw new Error(err.error?.message || response.statusText);
    }
    const contentDisposition = response.headers.get('Content-Disposition') || '';
    const filenameMatch = contentDisposition.match(/filename="(.+?)"/);
    const filename = filenameMatch ? filenameMatch[1] : 'synthetic_data.csv';
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus(`Downloaded ${filename} successfully.`, 'success');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    setProcessing(false);
  }
});

elements.objectType.addEventListener('change', () => {
  updateObjectIdPrompt();
  elements.objectId.value = '';
  clearResultSummary();
  elements.resultOutput.textContent = '{}';
  setStatus(`Enter ${elements.objectIdLabel.textContent.toLowerCase()} and run a preview.`);
});

elements.transferForm.addEventListener('submit', (event) => {
  event.preventDefault();

  if (!elements.objectId.value.trim()) {
    handleMissingObjectId();
    return;
  }

  submitTransfer('/api/run', 'Transfer').catch((error) => {
    setResult({ success: false, error: { message: error.message } });
    setStatus(error.message, 'error');
    setProcessing(false);
  });
});

elements.objectId.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') {
    return;
  }

  event.preventDefault();

  if (!elements.objectId.value.trim()) {
    handleMissingObjectId();
    return;
  }

  submitTransfer('/api/run', 'Transfer').catch((error) => {
    setResult({ success: false, error: { message: error.message } });
    setStatus(error.message, 'error');
    setProcessing(false);
  });
});

elements.historyRefreshButton.addEventListener('click', () => {
  loadRunHistory().catch((error) => {
    setResult({ success: false, error: { message: error.message } });
    setStatus(error.message, 'error');
    setProcessing(false);
  });
});

elements.newRunButton.addEventListener('click', () => {
  startNewRun();
  // Hide synthetic options panel on new run
  elements.syntheticOptionsPanel.hidden = true;
});

// Toggle sampling sub-option panels based on selected mode
elements.sampleMode.addEventListener('change', () => {
  const mode = elements.sampleMode.value;
  elements.sampleTopOptions.hidden    = mode !== 'top';
  elements.sampleRandomOptions.hidden = mode !== 'random';
  elements.sampleRangeOptions.hidden  = mode !== 'range';
});

function renderSyntheticInfo(payload) {
  if (!payload?.synthetic || !payload?.generatedIdRange) return;

  const section = document.createElement('section');
  section.className = 'summary-section synthetic-section';

  const heading = document.createElement('div');
  heading.className = 'section-heading';
  heading.textContent = 'Synthetic Generation Range';
  section.appendChild(heading);

  const rangeDisplay = document.createElement('div');
  rangeDisplay.className = 'synthetic-range';
  rangeDisplay.style.padding = '1rem';
  rangeDisplay.style.background = 'rgba(255, 255, 255, 0.05)';
  rangeDisplay.style.borderRadius = '8px';
  rangeDisplay.style.marginTop = '0.5rem';
  rangeDisplay.style.fontSize = '1.1rem';
  rangeDisplay.style.color = '#4ade80';
  const fieldName = payload.pkField || 'Keys';
  rangeDisplay.innerHTML = `<strong>${fieldName} Generated:</strong> ${payload.generatedIdRange}`;
  
  section.appendChild(rangeDisplay);
  elements.resultSummary.appendChild(section);
}

initializeTheme();
initialize();
