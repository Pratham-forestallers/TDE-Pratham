const config = require('./config');
const { sapPost } = require('./sapClient');

function requestId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

function parsePayload(data, entitySet) {
  const payload = data?.d?.Payload;

  if (payload === undefined || payload === null || payload === '') {
    return entitySet === 'FetchDataSet' ? [] : {};
  }

  if (typeof payload !== 'string') {
    return payload;
  }

  return JSON.parse(payload);
}

function clampRows(rows) {
  const requested = Number(rows || config.defaultBatchSize);
  return Math.min(requested, config.maxRows);
}

/**
 * Fetches rows from any SAP table using FetchDataSet.
 * @param {string} table UPPERCASE SAP table name.
 * @param {string} where SAP WHERE clause.
 * @param {number} rows Maximum rows to fetch.
 * @returns {Promise<object[]>} Parsed table rows.
 */
async function fetchTable(table, where = '', rows = config.defaultBatchSize) {
  const response = await sapPost('FetchDataSet', {
    RequestId: requestId('FETCH'),
    Payload: JSON.stringify({
      table: String(table).toUpperCase(),
      where,
      rows: clampRows(rows)
    })
  });

  const result = parsePayload(response, 'FetchDataSet');
  return Array.isArray(result) ? result : [];
}

/**
 * Inserts rows into any SAP table using InsertDataSet.
 * @param {string} table UPPERCASE SAP target table name.
 * @param {object[]} rows Rows with UPPERCASE SAP field names.
 * @returns {Promise<object>} Parsed SAP insert result.
 */
async function insertRows(table, rows) {
  if (!Array.isArray(rows)) {
    throw new Error('insertRows expects rows to be an array');
  }

  const response = await sapPost('InsertDataSet', {
    RequestId: requestId('INSERT'),
    Payload: JSON.stringify({
      table: String(table).toUpperCase(),
      rows
    })
  });

  return parsePayload(response, 'InsertDataSet');
}

/**
 * Gets the next value from a SAP number range object using NumberRangeSet.
 * @param {string} object SAP number range object.
 * @param {string} subObject SAP number range subobject.
 * @returns {Promise<string>} Next number as returned by SAP.
 */
async function getNextNumber(object, subObject = '') {
  const response = await sapPost('NumberRangeSet', {
    RequestId: requestId('NR'),
    Object: object,
    SubObject: subObject,
    Quantity: 1
  });

  return response?.d?.Result;
}

module.exports = {
  fetchTable,
  insertRows,
  getNextNumber
};
