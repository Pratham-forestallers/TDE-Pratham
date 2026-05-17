const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const RUN_HISTORY_LIMIT = Number(process.env.TDE_RUN_HISTORY_LIMIT || 20);
const DEFAULT_HISTORY_FILE = path.join(process.cwd(), 'data', 'run-history.json');
const HISTORY_FILE = process.env.TDE_RUN_HISTORY_FILE || DEFAULT_HISTORY_FILE;

let runHistory = [];
let loaded = false;

function ensureLoaded() {
  if (loaded) {
    return;
  }

  loaded = true;

  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      runHistory = [];
      return;
    }

    const contents = fs.readFileSync(HISTORY_FILE, 'utf8').trim();

    if (!contents) {
      runHistory = [];
      return;
    }

    const parsed = JSON.parse(contents);
    runHistory = Array.isArray(parsed) ? parsed.slice(0, RUN_HISTORY_LIMIT) : [];
  } catch (error) {
    runHistory = [];
    logger.warn('Unable to load persistent run history', {
      file: HISTORY_FILE,
      error: error.message
    });
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, `${JSON.stringify(runHistory, null, 2)}\n`, 'utf8');
  } catch (error) {
    logger.warn('Unable to persist run history', {
      file: HISTORY_FILE,
      error: error.message
    });
  }
}

function recordRunHistory(entry) {
  ensureLoaded();
  runHistory.unshift(entry);

  if (runHistory.length > RUN_HISTORY_LIMIT) {
    runHistory = runHistory.slice(0, RUN_HISTORY_LIMIT);
  }

  persist();
}

function getRunHistory(traceId) {
  ensureLoaded();
  return runHistory.find((entry) => entry.traceId === traceId) || null;
}

function updateRunHistory(traceId, updater) {
  ensureLoaded();

  const index = runHistory.findIndex((entry) => entry.traceId === traceId);

  if (index === -1) {
    return null;
  }

  const updatedEntry = updater(runHistory[index]);
  runHistory[index] = updatedEntry;
  persist();

  return updatedEntry;
}

function listRunHistory() {
  ensureLoaded();
  return runHistory;
}

module.exports = {
  recordRunHistory,
  getRunHistory,
  updateRunHistory,
  listRunHistory
};
