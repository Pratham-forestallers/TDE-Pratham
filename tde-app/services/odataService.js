const http = require('http');
const axios = require('axios');
const objectConfig = require('../config/objectConfig');
const {
  resolveDestination,
  getDestinationConfig,
  getAuthHeaders,
  getConnectivityOptions
} = require('./destinationService');
const { AppError } = require('../utils/errorHandler');
const logger = require('../utils/logger');

// New generated TDE service metadata:
//   /sap/opu/odata/FDE/TDE_GEN_SRV/
//   FetchDataSet(RequestId, Payload)
//   InsertDataSet(RequestId, Payload)
//   DeleteDataSet(RequestId, Payload)
// Fetch and insert can expose different payload property casing. Keep those
// request field names separate so each entity set can match SAP metadata.
const ODATA_MAPPING = {
  servicePath: process.env.TDE_ODATA_SERVICE_PATH || '/sap/opu/odata/FDE/TDE_GEN_SRV/',
  fetchEntitySet: process.env.TDE_ODATA_FETCH_ENTITY_SET || 'FetchDataSet',
  insertEntitySet: process.env.TDE_ODATA_INSERT_ENTITY_SET || 'InsertDataSet',
  deleteEntitySet: process.env.TDE_ODATA_DELETE_ENTITY_SET || 'DeleteDataSet',
  numberRangeEntitySet: process.env.TDE_ODATA_NUMBER_RANGE_ENTITY_SET || 'NumberRangeSet',
  requestIdField: process.env.TDE_ODATA_REQUEST_ID_FIELD || 'RequestId',
  fetchRequestPayloadField: process.env.TDE_ODATA_FETCH_REQUEST_PAYLOAD_FIELD ||
    process.env.TDE_ODATA_REQUEST_PAYLOAD_FIELD ||
    'Payload',
  insertRequestPayloadField: process.env.TDE_ODATA_INSERT_REQUEST_PAYLOAD_FIELD ||
    process.env.TDE_ODATA_REQUEST_PAYLOAD_FIELD ||
    'Payload',
  deleteRequestPayloadField: process.env.TDE_ODATA_DELETE_REQUEST_PAYLOAD_FIELD ||
    process.env.TDE_ODATA_REQUEST_PAYLOAD_FIELD ||
    'Payload',
  responsePayloadField: process.env.TDE_ODATA_RESPONSE_PAYLOAD_FIELD ||
    process.env.TDE_ODATA_PAYLOAD_FIELD ||
    'Payload',
  csrfMode: process.env.TDE_ODATA_CSRF_MODE || 'required',
  csrfTokenPaths: (process.env.TDE_ODATA_CSRF_TOKEN_PATHS || 'FetchDataSet, InsertDataSet, DeleteDataSet, NumberRangeSet, , $metadata')
    .split(',')
    .map((path) => path.trim())
    .filter((path, index, paths) => index === paths.findIndex((candidate) => candidate === path)),
  csrfTokenHeader: 'x-csrf-token'
};

const INSERT_PAYLOAD_FIELD_CANDIDATES = Array.from(new Set([
  ODATA_MAPPING.insertRequestPayloadField,
  'Payload',
  'payload'
]));
const DELETE_PAYLOAD_FIELD_CANDIDATES = Array.from(new Set([
  ODATA_MAPPING.deleteRequestPayloadField,
  'Payload',
  'payload'
]));
const csrfTokenPathCache = new Map();
const csrfSessionCache = new Map();

const PAYLOAD_KEYS = {
  tableName: process.env.TDE_PAYLOAD_TABLE_FIELD || 'table',
  objectKey: process.env.TDE_PAYLOAD_OBJECT_KEY_FIELD || 'objectKey',
  objectId: process.env.TDE_PAYLOAD_OBJECT_ID_FIELD || 'objectId',
  whereClause: process.env.TDE_PAYLOAD_WHERE_CLAUSE_FIELD || 'where',
  rows: process.env.TDE_PAYLOAD_ROWS_FIELD || 'rows'
};

const DEFAULT_FETCH_ROWS = Number(process.env.TDE_ODATA_DEFAULT_ROWS || 5000);
const INSERT_ROWS_AS_STRING = String(process.env.TDE_INSERT_ROWS_AS_STRING || 'true').toLowerCase() !== 'false';
const INSERT_BATCH_SIZE = normalizePositiveInteger(process.env.TDE_INSERT_BATCH_SIZE, 1);
const INSERT_REQUEST_ID = process.env.TDE_INSERT_REQUEST_ID || 'INSERT_001';

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function sanitizeUrlForLog(value) {
  try {
    const parsedUrl = new URL(value);
    return `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
  } catch (error) {
    return value ? '[invalid-url]' : undefined;
  }
}

function describeAxiosError(error) {
  return {
    message: error.message,
    code: error.code,
    status: error.response?.status,
    statusText: error.response?.statusText
  };
}

function describePostBody(body) {
  const payloadField = [
    ODATA_MAPPING.fetchRequestPayloadField,
    ODATA_MAPPING.insertRequestPayloadField,
    'Payload',
    'payload'
  ].find((fieldName) => Object.prototype.hasOwnProperty.call(body, fieldName));

  let payloadKeys = [];
  let rowCount;
  let rowsType;
  let sampleRow;
  let payloadLength;

  if (payloadField) {
    try {
      payloadLength = typeof body[payloadField] === 'string' ? body[payloadField].length : undefined;
      const parsedPayload = JSON.parse(body[payloadField]);
      payloadKeys = Object.keys(parsedPayload || {});
      const rows = parsedPayload?.[PAYLOAD_KEYS.rows];
      rowsType = Array.isArray(rows) ? 'array' : typeof rows;
      rowCount = getRowsCount(rows);
      const parsedRows = parseRowsForDiagnostics(rows);
      sampleRow = Array.isArray(parsedRows) ? parsedRows[0] : undefined;
    } catch (error) {
      payloadKeys = ['[unparseable]'];
    }
  }

  return {
    bodyFields: Object.keys(body),
    requestId: body?.[ODATA_MAPPING.requestIdField],
    requestIdField: ODATA_MAPPING.requestIdField,
    payloadField,
    payloadKeys,
    payloadLength,
    rowsType,
    rowCount,
    sampleRow
  };
}

function getRowsCount(rows) {
  if (Array.isArray(rows)) {
    return rows.length;
  }

  if (typeof rows === 'string') {
    try {
      const parsedRows = JSON.parse(rows);
      return Array.isArray(parsedRows) ? parsedRows.length : undefined;
    } catch (error) {
      return undefined;
    }
  }

  return undefined;
}

function getCsrfCacheKey(client) {
  return sanitizeUrlForLog(client.defaults.baseURL) || client.defaults.baseURL;
}

function getOrderedCsrfTokenPaths(client) {
  const cachedPath = csrfTokenPathCache.get(getCsrfCacheKey(client));

  if (!cachedPath && cachedPath !== '') {
    return ODATA_MAPPING.csrfTokenPaths;
  }

  return [
    cachedPath,
    ...ODATA_MAPPING.csrfTokenPaths.filter((path) => path !== cachedPath)
  ];
}

async function getSystemClient(systemKey) {
  const destination = await resolveDestination(systemKey);
  const config = getDestinationConfig(destination);
  const connectivityOptions = await getConnectivityOptions(destination);
  const baseURL = `${normalizeBaseUrl(config.URL)}${ODATA_MAPPING.servicePath}`;

  logger.info('Created SAP OData client', {
    system: systemKey,
    servicePath: ODATA_MAPPING.servicePath,
    proxyType: config.ProxyType,
    baseURL: sanitizeUrlForLog(baseURL),
    usesConnectivityProxy: Boolean(connectivityOptions.proxy),
    hasConnectivityLocationId: Boolean(connectivityOptions.headers?.['SAP-Connectivity-SCC-Location_ID'])
  });

  return axios.create({
    baseURL,
    proxy: connectivityOptions.proxy,
    httpAgent: new http.Agent({ keepAlive: false }),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...getAuthHeaders(destination),
      ...(connectivityOptions.headers || {})
    },
    timeout: 60000
  });
}

/**
 * Creates a raw SAP client without the default TDE service path, 
 * useful for calling standard SAP APIs (e.g., API_SALES_ORDER_SRV).
 */
async function getRawClient(systemKey) {
  const destination = await resolveDestination(systemKey);
  const config = getDestinationConfig(destination);
  const connectivityOptions = await getConnectivityOptions(destination);
  const baseURL = normalizeBaseUrl(config.URL);

  return axios.create({
    baseURL,
    proxy: connectivityOptions.proxy,
    httpAgent: new http.Agent({ keepAlive: false }),
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...getAuthHeaders(destination),
      ...(connectivityOptions.headers || {})
    },
    timeout: 60000
  });
}

function escapeODataString(value) {
  return String(value).replace(/'/g, "''");
}

function parseSapError(error) {
  const responseData = error.response?.data;

  if (responseData?.error?.message?.value) {
    return responseData.error.message.value;
  }

  if (responseData?.error?.message) {
    return typeof responseData.error.message === 'string'
      ? responseData.error.message
      : JSON.stringify(responseData.error.message);
  }

  if (typeof responseData === 'string') {
    return responseData;
  }

  return error.message;
}

function parseODataResponse(response) {
  const data = response.data;

  if (!data) {
    return [];
  }

  if (Array.isArray(data.value)) {
    return data.value;
  }

  if (Array.isArray(data.d?.results)) {
    return data.d.results;
  }

  if (data.d) {
    return Array.isArray(data.d) ? data.d : [data.d];
  }

  if (Array.isArray(data)) {
    return data;
  }

  return [data];
}

function applyWhereClauseTemplate(template, context) {
  return template.replace(/\{([A-Z0-9_]+)\}/gi, (match, fieldName) => {
    const value = context[fieldName];

    if (value === undefined || value === null || value === '') {
      throw new AppError(
        `Unable to build WhereClause because dependency field ${fieldName} is missing`,
        500,
        {
          missingField: fieldName,
          availableFields: Object.keys(context)
        }
      );
    }

    return escapeODataString(value);
  });
}

function buildWhereClause(tableName, objectId, objectDefinition, context = {}) {
  const whereClauseByTable = objectDefinition.whereClauseByTable || {};
  const template = whereClauseByTable[tableName];

  if (template) {
    return applyWhereClauseTemplate(template, {
      ...context,
      OBJECT_ID: objectId
    });
  }

  const keyFieldByTable = objectDefinition.keyFieldByTable || {};
  const keyField = keyFieldByTable[tableName] || objectDefinition.keyField;

  return `${keyField} = '${escapeODataString(objectId)}'`;
}

function resolveObjectDefinition(objectTypeOrKey) {
  if (objectConfig[objectTypeOrKey]) {
    return objectConfig[objectTypeOrKey];
  }

  const objectKey = Number(objectTypeOrKey);

  if (!Number.isInteger(objectKey)) {
    return null;
  }

  return Object.values(objectConfig).find((definition) => definition.objectKey === objectKey) || null;
}

function createRequestId(prefix) {
  const suffix = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `${prefix}_${Date.now()}_${suffix}`;
}

function buildPayloadEnvelope(prefix, payload, payloadField) {
  return {
    [ODATA_MAPPING.requestIdField]: createRequestId(prefix),
    [payloadField]: JSON.stringify(payload)
  };
}

function buildInsertPayloadEnvelope(payload, payloadField) {
  // The working diagnostic/trial insert body uses this fixed RequestId.
  // Keep the automated insert body identical unless TDE_INSERT_REQUEST_ID overrides it.
  return {
    [ODATA_MAPPING.requestIdField]: INSERT_REQUEST_ID,
    [payloadField]: JSON.stringify(payload)
  };
}

function buildFetchPayload(tableName, objectId, objectType, objectDefinition, context) {
  return {
    [PAYLOAD_KEYS.tableName]: tableName,
    [PAYLOAD_KEYS.objectKey]: objectDefinition.objectKey,
    [PAYLOAD_KEYS.objectId]: objectId,
    [PAYLOAD_KEYS.whereClause]: buildWhereClause(tableName, objectId, objectDefinition, context),
    [PAYLOAD_KEYS.rows]: DEFAULT_FETCH_ROWS
  };
}

function buildFetchErrorMessage(tableName, systemKey, sapError) {
  if (sapError) {
    return sapError;
  }

  return `Failed to fetch ${tableName} from ${systemKey}. Confirm ${ODATA_MAPPING.fetchEntitySet} accepts RequestId/${ODATA_MAPPING.fetchRequestPayloadField} with payload keys ${PAYLOAD_KEYS.tableName}, ${PAYLOAD_KEYS.whereClause}, and ${PAYLOAD_KEYS.rows}.`;
}

function buildPushErrorMessage(tableName, systemKey, sapError) {
  if (sapError) {
    return sapError;
  }

  return `Failed to push ${tableName} to ${systemKey}. Confirm ${ODATA_MAPPING.insertEntitySet} accepts RequestId/${ODATA_MAPPING.insertRequestPayloadField} with payload keys ${PAYLOAD_KEYS.tableName} and ${PAYLOAD_KEYS.rows}.`;
}

function shouldRetryInsertWithAlternatePayloadField(error) {
  const sapError = parseSapError(error);

  return /invalid property|property .* invalid|csrf token|csrf/i.test(sapError || '') ||
    /CSRF token/i.test(error.message || '');
}

async function fetchServiceMetadata(systemKey) {
  const client = await getSystemClient(systemKey);

  try {
    const response = await client.get('$metadata', {
      headers: {
        Accept: 'application/xml,text/xml'
      },
      responseType: 'text',
      transformResponse: [(data) => data]
    });

    return response.data;
  } catch (error) {
    const sapError = parseSapError(error);

    throw new AppError(
      `Failed to fetch OData metadata from ${systemKey}`,
      error.response?.status || 502,
      {
        system: systemKey,
        sapError
      }
    );
  }
}

function parseJsonPayload(payload, systemKey, entitySet) {
  if (payload === undefined || payload === null || payload === '') {
    return [];
  }

  if (typeof payload !== 'string') {
    return payload;
  }

  const trimmedPayload = payload.trim();

  if (!trimmedPayload) {
    return [];
  }

  let currentValue = trimmedPayload;

  for (let parseAttempt = 0; parseAttempt < 2; parseAttempt += 1) {
    if (typeof currentValue !== 'string') {
      return currentValue;
    }

    try {
      currentValue = JSON.parse(currentValue);
    } catch (error) {
      const sanitizedValue = currentValue
        .replace(/\u0000/g, '')
        .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, '');

      if (sanitizedValue !== currentValue) {
        try {
          currentValue = JSON.parse(sanitizedValue);
          continue;
        } catch (sanitizedError) {
          currentValue = sanitizedValue;
        }
      }

      const repairedValue = fillMissingJsonValues(currentValue);

      if (repairedValue !== currentValue) {
        try {
          const repairedPreview = repairedValue.slice(0, 200);
          currentValue = JSON.parse(repairedValue);
          logger.warn('SAP returned JSON with missing values; repaired missing values as null', {
            system: systemKey,
            entitySet,
            parseError: error.message,
            payloadPreview: repairedPreview
          });
          continue;
        } catch (repairedError) {
          currentValue = repairedValue;
        }
      }

      const arrayStart = currentValue.indexOf('[');
      const arrayEnd = currentValue.lastIndexOf(']');
      const objectStart = currentValue.indexOf('{');
      const objectEnd = currentValue.lastIndexOf('}');
      const candidateJson = arrayStart !== -1 && arrayEnd > arrayStart
        ? currentValue.slice(arrayStart, arrayEnd + 1)
        : objectStart !== -1 && objectEnd > objectStart
          ? currentValue.slice(objectStart, objectEnd + 1)
          : '';

      if (candidateJson && candidateJson !== currentValue) {
        try {
          currentValue = JSON.parse(candidateJson);
          continue;
        } catch (candidateError) {
          currentValue = candidateJson;
        }
      }

      if (
        entitySet === ODATA_MAPPING.fetchEntitySet ||
        !/^[\[{"]/u.test(currentValue)
      ) {
        logger.warn('SAP returned a non-JSON payload; treating it as an empty result set', {
          system: systemKey,
          entitySet,
          parseError: error.message,
          payloadPreview: currentValue.slice(0, 200)
        });
        return [];
      }

      throw new AppError(
        `Unable to parse Payload returned by ${entitySet} from ${systemKey}`,
        502,
        {
          system: systemKey,
          entitySet,
          parseError: error.message,
          payloadPreview: trimmedPayload.slice(0, 500)
        }
      );
    }
  }

  return currentValue;
}

function fillMissingJsonValues(value) {
  let output = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    output += char;

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString || char !== ':') {
      continue;
    }

    let lookahead = index + 1;

    while (/\s/.test(value[lookahead] || '')) {
      output += value[lookahead];
      lookahead += 1;
    }

    if (value[lookahead] === ',' || value[lookahead] === '}') {
      output += 'null';
    }

    index = lookahead - 1;
  }

  return output;
}

function extractPayloadFromResponse(response, systemKey, entitySet) {
  const entities = parseODataResponse(response);
  const firstEntity = entities[0];
  const payloadField = [
    ODATA_MAPPING.responsePayloadField,
    ODATA_MAPPING.fetchRequestPayloadField,
    ODATA_MAPPING.insertRequestPayloadField,
    'Payload',
    'payload'
  ].find((fieldName) => (
    firstEntity &&
    Object.prototype.hasOwnProperty.call(firstEntity, fieldName)
  ));

  if (!payloadField) {
    return entities;
  }

  return parseJsonPayload(firstEntity[payloadField], systemKey, entitySet);
}

function normalizePayloadRecords(payload) {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  const candidateArrays = [
    payload[PAYLOAD_KEYS.rows],
    payload.records,
    payload.Rows,
    payload.ROWS,
    payload.Results,
    payload.results,
    payload.DATA,
    payload.data,
    payload.value
  ];

  const records = candidateArrays.find(Array.isArray);

  if (records) {
    return records;
  }

  return [payload];
}

async function fetchTableData(systemKey, tableName, objectId, objectType, context = {}) {
  const objectDefinition = resolveObjectDefinition(objectType);

  if (!objectDefinition) {
    throw new AppError(`Unsupported object type: ${objectType}`, 400);
  }

  const client = await getSystemClient(systemKey);

  return fetchTableDataWithClient(client, systemKey, tableName, objectId, objectType, context);
}

async function fetchTableDataWithClient(client, systemKey, tableName, objectId, objectType, context = {}) {
  const objectDefinition = resolveObjectDefinition(objectType);

  if (!objectDefinition) {
    throw new AppError(`Unsupported object type: ${objectType}`, 400);
  }

  const payload = buildFetchPayload(tableName, objectId, objectType, objectDefinition, context);

  logger.info('Fetching SAP table data', {
    system: systemKey,
    table: tableName,
    objectType,
    objectId,
    entitySet: ODATA_MAPPING.fetchEntitySet,
    requestPayload: payload
  });

  try {
    const { response } = await postWithCsrfRetry(
      client,
      ODATA_MAPPING.fetchEntitySet,
      buildPayloadEnvelope('FETCH', payload, ODATA_MAPPING.fetchRequestPayloadField)
    );
    const responsePayload = extractPayloadFromResponse(response, systemKey, ODATA_MAPPING.fetchEntitySet);

    return normalizePayloadRecords(responsePayload);
  } catch (error) {
    const sapError = parseSapError(error);

    logger.error('SAP table fetch failed', {
      system: systemKey,
      table: tableName,
      objectType,
      objectId,
      entitySet: ODATA_MAPPING.fetchEntitySet,
      requestPayload: payload,
      sapError,
      axiosError: describeAxiosError(error)
    });

    throw new AppError(
      buildFetchErrorMessage(tableName, systemKey, sapError),
      error.response?.status || 502,
      {
        table: tableName,
        system: systemKey,
        objectType,
        objectId,
        requestPayload: payload,
        sapError
      }
    );
  }
}

async function warmCsrfToken(client, options = {}) {
  return getOptionalCsrfToken(client, options);
}

async function fetchCsrfTokenFromPath(client, tokenPath) {
  logger.info('Fetching SAP CSRF token', {
    baseURL: sanitizeUrlForLog(client.defaults.baseURL),
    tokenPath: tokenPath || '[service-root]',
    targetURL: sanitizeUrlForLog(client.getUri({ url: tokenPath })),
    csrfMode: ODATA_MAPPING.csrfMode
  });

  const response = await client.get(tokenPath, {
    headers: {
      [ODATA_MAPPING.csrfTokenHeader]: 'Fetch',
      Accept: 'application/json,application/xml,text/xml'
    },
    transformResponse: [(data) => data]
  });

  const token = response.headers[ODATA_MAPPING.csrfTokenHeader];

  if (!token) {
    throw new AppError(
      `SAP did not return an x-csrf-token header from ${tokenPath || '[service-root]'}`,
      502,
      {
        tokenPath: tokenPath || '[service-root]',
        status: response.status,
        contentType: response.headers['content-type'],
        setCookieCount: Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'].length : 0
      }
    );
  }

  return {
    token: response.headers[ODATA_MAPPING.csrfTokenHeader],
    cookies: response.headers['set-cookie']
  };
}

async function fetchCsrfToken(client) {
  const errors = [];

  for (const tokenPath of getOrderedCsrfTokenPaths(client)) {
    try {
      const csrf = await fetchCsrfTokenFromPath(client, tokenPath);
      csrfTokenPathCache.set(getCsrfCacheKey(client), tokenPath);
      return csrf;
    } catch (error) {
      errors.push({
        tokenPath: tokenPath || '[service-root]',
        sapError: parseSapError(error),
        axiosError: describeAxiosError(error)
      });
    }
  }

  const sapError = errors.find((entry) => entry.sapError)?.sapError;

  throw new AppError(
    sapError || 'SAP did not return a CSRF token from any configured token path',
    errors.at(-1)?.axiosError?.status || 502,
    {
      csrfTokenPaths: getOrderedCsrfTokenPaths(client),
      attempts: errors
    }
  );
}

async function getCachedCsrfToken(client, { forceRefresh = false } = {}) {
  const cacheKey = getCsrfCacheKey(client);

  if (!forceRefresh) {
    const cachedCsrf = csrfSessionCache.get(cacheKey);

    if (cachedCsrf?.token) {
      logger.info('Reusing cached SAP CSRF token', {
        baseURL: sanitizeUrlForLog(client.defaults.baseURL),
        csrfCookieCount: Array.isArray(cachedCsrf.cookies) ? cachedCsrf.cookies.length : 0
      });

      return cachedCsrf;
    }
  }

  const csrf = await fetchCsrfToken(client);
  csrfSessionCache.set(cacheKey, csrf);
  return csrf;
}

async function getOptionalCsrfToken(client, options = {}) {
  if (ODATA_MAPPING.csrfMode === 'skip') {
    return {
      token: undefined,
      cookies: undefined,
      skipped: true,
      reason: 'TDE_ODATA_CSRF_MODE=skip'
    };
  }

  try {
    return await getCachedCsrfToken(client, options);
  } catch (error) {
    const sapError = parseSapError(error);

    if (ODATA_MAPPING.csrfMode === 'optional') {
      return {
        token: undefined,
        cookies: undefined,
        skipped: true,
        reason: sapError
      };
    }

    throw error;
  }
}

async function postWithCsrfRetry(client, entitySet, body) {
  let csrf = await getOptionalCsrfToken(client);
  const postDiagnostics = {
    baseURL: sanitizeUrlForLog(client.defaults.baseURL),
    entitySet,
    method: 'POST',
    targetURL: sanitizeUrlForLog(client.getUri({ url: entitySet })),
    csrfTokenPresent: Boolean(csrf.token),
    csrfCookieCount: Array.isArray(csrf.cookies) ? csrf.cookies.length : 0,
    csrfSkipped: Boolean(csrf.skipped),
    csrfSkipReason: csrf.reason,
    ...describePostBody(body)
  };

  logger.info('Posting SAP OData entity set', postDiagnostics);

  try {
    const response = await client.post(entitySet, body, {
      headers: buildPostHeaders(csrf)
    });

    logger.info('SAP OData post succeeded', {
      ...postDiagnostics,
      status: response.status,
      statusText: response.statusText,
      retriedAfterCsrfFailure: false
    });

    return {
      response,
      csrf
    };
  } catch (error) {
    const status = error.response?.status;
    const sapError = parseSapError(error);

    logger.error('SAP OData post failed', {
      ...postDiagnostics,
      status,
      sapError,
      axiosError: describeAxiosError(error)
    });

    if (status !== 403 || !/csrf/i.test(sapError)) {
      throw error;
    }

    csrf = await getOptionalCsrfToken(client, { forceRefresh: true });
    logger.info('Retrying SAP OData post after CSRF failure', {
      baseURL: sanitizeUrlForLog(client.defaults.baseURL),
      entitySet,
      method: 'POST',
      targetURL: sanitizeUrlForLog(client.getUri({ url: entitySet })),
      csrfTokenPresent: Boolean(csrf.token),
      csrfCookieCount: Array.isArray(csrf.cookies) ? csrf.cookies.length : 0
    });

    const response = await client.post(entitySet, body, {
      headers: buildPostHeaders(csrf)
    });

    logger.info('SAP OData post succeeded', {
      ...postDiagnostics,
      status: response.status,
      statusText: response.statusText,
      csrfTokenPresent: Boolean(csrf.token),
      csrfCookieCount: Array.isArray(csrf.cookies) ? csrf.cookies.length : 0,
      retriedAfterCsrfFailure: true
    });

    return {
      response,
      csrf,
      retriedAfterCsrfFailure: true
    };
  }
}

function buildPostHeaders(csrf) {
  const headers = {};

  if (csrf?.token) {
    headers[ODATA_MAPPING.csrfTokenHeader] = csrf.token;
  }

  if (Array.isArray(csrf?.cookies)) {
    headers.Cookie = csrf.cookies.join('; ');
  }

  return headers;
}

function stripMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const { __metadata, ...rest } = value;
  return rest;
}

function normalizeRecordForInsert(record, tableName) {
  let normalizedRecord;

  // Preserve the source row structure and values as closely as possible. The only
  // normalization here is unwrapping RecordData when SAP returns it that way and
  // removing OData metadata fields that cannot be posted back to the target.
  if (record?.RecordData && typeof record.RecordData === 'string') {
    try {
      normalizedRecord = stripMetadata(JSON.parse(record.RecordData));
    } catch (error) {
      throw new AppError(
        'Unable to parse RecordData before insert',
        500,
        {
          parseError: error.message
        }
      );
    }
  } else {
    normalizedRecord = stripMetadata(record);
  }

  return normalizedRecord;
}

function getMeaningfulValueKeys(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return [];
  }

  return Object.entries(record)
    .filter(([key]) => key !== '__metadata')
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key]) => key);
}

function validateRecordsForInsert(tableName, records) {
  const invalidRecords = records
    .map((record, index) => ({
      index,
      valueKeys: getMeaningfulValueKeys(record)
    }))
    .filter((entry) => entry.valueKeys.length <= 1);

  if (invalidRecords.length > 0) {
    throw new AppError(
      `Refusing to insert ${tableName} because fetched source rows do not contain enough field data`,
      422,
      {
        table: tableName,
        invalidRecordCount: invalidRecords.length,
        examples: invalidRecords.slice(0, 3),
        reason: 'Rows with only a key field would create incomplete records in the target system'
      }
    );
  }
}

function buildInsertPayload(tableName, records) {
  const normalizedRecords = records.map((record) => normalizeRecordForInsert(record, tableName));

  validateRecordsForInsert(tableName, normalizedRecords);

  // InsertDataSet expects one Payload string. Inside that Payload, rows can be either
  // an array or a stringified array; our default matches the working manual body.
  return {
    [PAYLOAD_KEYS.tableName]: tableName,
    [PAYLOAD_KEYS.rows]: INSERT_ROWS_AS_STRING ? JSON.stringify(normalizedRecords) : normalizedRecords
  };
}

function chunkRecords(records, batchSize) {
  const chunks = [];

  for (let index = 0; index < records.length; index += batchSize) {
    chunks.push({
      startIndex: index,
      records: records.slice(index, index + batchSize)
    });
  }

  return chunks;
}

function parseRowsForDiagnostics(rows) {
  if (Array.isArray(rows)) {
    return rows;
  }

  if (typeof rows !== 'string') {
    return undefined;
  }

  try {
    const parsedRows = JSON.parse(rows);
    return Array.isArray(parsedRows) ? parsedRows : undefined;
  } catch (error) {
    return undefined;
  }
}

function summarizeInsertBody(body) {
  const safeBody = body || {};
  const payloadField = [
    ODATA_MAPPING.insertRequestPayloadField,
    'Payload',
    'payload'
  ].find((fieldName) => Object.prototype.hasOwnProperty.call(safeBody, fieldName));
  const summary = {
    bodyFields: Object.keys(safeBody),
    requestId: safeBody?.[ODATA_MAPPING.requestIdField],
    payloadField
  };

  if (!payloadField) {
    return summary;
  }

  try {
    const parsedPayload = JSON.parse(safeBody[payloadField]);
    const rows = parsedPayload?.[PAYLOAD_KEYS.rows];
    const parsedRows = parseRowsForDiagnostics(rows);

    return {
      ...summary,
      payloadKeys: Object.keys(parsedPayload || {}),
      table: parsedPayload?.[PAYLOAD_KEYS.tableName],
      rowsType: Array.isArray(rows) ? 'array' : typeof rows,
      rowCount: Array.isArray(parsedRows) ? parsedRows.length : undefined,
      sampleFields: parsedRows?.[0] && typeof parsedRows[0] === 'object'
        ? Object.keys(parsedRows[0])
        : [],
      sampleRow: parsedRows?.[0],
      body: safeBody
    };
  } catch (error) {
    return {
      ...summary,
      parseError: error.message,
      body: safeBody
    };
  }
}

function buildInsertBodyDiagnostics(tableName, records) {
  const diagnosticRecords = records.slice(0, INSERT_BATCH_SIZE);
  const body = buildInsertBodyForRecords(tableName, diagnosticRecords);

  return {
    ...summarizeInsertBody(body),
    insertBatchSize: INSERT_BATCH_SIZE,
    recordOffset: 0,
    totalRecordCount: records.length
  };
}

function buildInsertBodyForRecords(tableName, records, payloadField = ODATA_MAPPING.insertRequestPayloadField) {
  const payload = buildInsertPayload(tableName, records);
  return buildInsertPayloadEnvelope(payload, payloadField);
}

function buildDeletePayload(tableName, records) {
  const normalizedRecords = records.map((record) => normalizeRecordForInsert(record, tableName));

  return {
    [PAYLOAD_KEYS.tableName]: tableName,
    [PAYLOAD_KEYS.rows]: INSERT_ROWS_AS_STRING ? JSON.stringify(normalizedRecords) : normalizedRecords
  };
}

function buildDeleteBodyForRecords(tableName, records, payloadField = ODATA_MAPPING.deleteRequestPayloadField) {
  const payload = buildDeletePayload(tableName, records);
  return buildPayloadEnvelope('DELETE', payload, payloadField);
}

async function pushTableData(systemKey, tableName, records) {
  if (!Array.isArray(records)) {
    throw new AppError(`Records for ${tableName} must be an array`, 500);
  }

  if (records.length === 0) {
    return {
      table: tableName,
      attempted: 0,
      succeeded: 0,
      responses: []
    };
  }

  const client = await getSystemClient(systemKey);

  return pushTableDataWithClient(client, systemKey, tableName, records);
}

async function pushTableDataWithClient(client, systemKey, tableName, records) {
  if (!Array.isArray(records)) {
    throw new AppError(`Records for ${tableName} must be an array`, 500);
  }

  if (records.length === 0) {
    return {
      table: tableName,
      attempted: 0,
      succeeded: 0,
      responses: []
    };
  }

  const responses = [];
  let succeeded = 0;
  let lastPayloadField = ODATA_MAPPING.insertRequestPayloadField;
  let csrfTokenSkipped = false;
  let retriedAfterCsrfFailure = false;

  // Default batch size is 1 so automated transfer posts the same single-row shape
  // that already works from the diagnostic/manual test.
  for (const chunk of chunkRecords(records, INSERT_BATCH_SIZE)) {
    let payload;
    let lastError;

    try {
      payload = buildInsertPayload(tableName, chunk.records);
    } catch (error) {
      if (error instanceof AppError) {
        throw new AppError(
          error.message,
          error.statusCode,
          {
            ...error.details,
            failedRecordOffset: chunk.startIndex,
            failedRecordCount: chunk.records.length,
            totalRecordCount: records.length,
            insertBatchSize: INSERT_BATCH_SIZE,
            succeeded
          }
        );
      }

      throw error;
    }

    for (const payloadField of INSERT_PAYLOAD_FIELD_CANDIDATES) {
      try {
        const insertBody = buildInsertPayloadEnvelope(payload, payloadField);
        const insertBodySummary = summarizeInsertBody(insertBody);

        logger.info('Pushing SAP table data', {
          system: systemKey,
          table: tableName,
          entitySet: ODATA_MAPPING.insertEntitySet,
          requestPayloadField: payloadField,
          recordOffset: chunk.startIndex,
          recordCount: chunk.records.length,
          totalRecordCount: records.length,
          insertBatchSize: INSERT_BATCH_SIZE,
          rowsSerializedAsString: INSERT_ROWS_AS_STRING,
          sourcePayloadPreserved: true,
          sampleFields: Object.keys(normalizeRecordForInsert(chunk.records[0] || {}, tableName)).slice(0, 12),
          insertBody: {
            requestId: insertBodySummary.requestId,
            payloadField: insertBodySummary.payloadField,
            table: insertBodySummary.table,
            rowsType: insertBodySummary.rowsType,
            rowCount: insertBodySummary.rowCount,
            sampleRow: insertBodySummary.sampleRow
          }
        });

        const { response, csrf, retriedAfterCsrfFailure: retried } = await postWithCsrfRetry(
          client,
          ODATA_MAPPING.insertEntitySet,
          insertBody
        );
        const responsePayload = extractPayloadFromResponse(response, systemKey, ODATA_MAPPING.insertEntitySet);
        const results = normalizePayloadRecords(responsePayload);

        responses.push(...results);
        succeeded += chunk.records.length;
        lastPayloadField = payloadField;
        csrfTokenSkipped = csrfTokenSkipped || Boolean(csrf.skipped);
        retriedAfterCsrfFailure = retriedAfterCsrfFailure || Boolean(retried);
        lastError = undefined;

        logger.info('SAP table data push succeeded', {
          system: systemKey,
          table: tableName,
          entitySet: ODATA_MAPPING.insertEntitySet,
          status: response.status,
          statusText: response.statusText,
          requestPayloadField: payloadField,
          recordOffset: chunk.startIndex,
          recordCount: chunk.records.length,
          totalRecordCount: records.length,
          succeeded,
          responseRecordCount: results.length,
          retriedAfterCsrfFailure: Boolean(retried)
        });

        break;
      } catch (error) {
        lastError = error;

        if (
          payloadField === INSERT_PAYLOAD_FIELD_CANDIDATES.at(-1) ||
          !shouldRetryInsertWithAlternatePayloadField(error)
        ) {
          break;
        }

        logger.info('Retrying insert with alternate payload field', {
          system: systemKey,
          table: tableName,
          failedPayloadField: payloadField,
          recordOffset: chunk.startIndex,
          recordCount: chunk.records.length,
          sapError: parseSapError(error)
        });
      }
    }

    if (lastError) {
      const sapError = parseSapError(lastError);
      const failedInsertBody = buildInsertPayloadEnvelope(payload, ODATA_MAPPING.insertRequestPayloadField);
      const failedInsertBodySummary = summarizeInsertBody(failedInsertBody);

      throw new AppError(
        buildPushErrorMessage(tableName, systemKey, sapError),
        lastError.response?.status || lastError.statusCode || 502,
        {
          table: tableName,
          system: systemKey,
          entitySet: ODATA_MAPPING.insertEntitySet,
          requestPayloadField: ODATA_MAPPING.insertRequestPayloadField,
          attemptedPayloadFields: INSERT_PAYLOAD_FIELD_CANDIDATES,
          failedRecordOffset: chunk.startIndex,
          failedRecordCount: chunk.records.length,
          succeeded,
          requestPayload: {
            [PAYLOAD_KEYS.tableName]: payload[PAYLOAD_KEYS.tableName],
            recordCount: chunk.records.length,
            totalRecordCount: records.length,
            insertBatchSize: INSERT_BATCH_SIZE,
            rowsSerializedAsString: INSERT_ROWS_AS_STRING,
            sourcePayloadPreserved: true,
            sampleFields: Object.keys(normalizeRecordForInsert(chunk.records[0] || {}, tableName)).slice(0, 12),
            insertBody: {
              requestId: failedInsertBodySummary.requestId,
              payloadField: failedInsertBodySummary.payloadField,
              table: failedInsertBodySummary.table,
              rowsType: failedInsertBodySummary.rowsType,
              rowCount: failedInsertBodySummary.rowCount,
              sampleRow: failedInsertBodySummary.sampleRow
            }
          },
          sapError
        }
      );
    }
  }

  return {
    table: tableName,
    attempted: records.length,
    succeeded,
    requestPayloadField: lastPayloadField,
    insertBatchSize: INSERT_BATCH_SIZE,
    csrfTokenSkipped,
    retriedAfterCsrfFailure,
    responses
  };
}

async function deleteTableDataWithClient(client, systemKey, tableName, records) {
  if (!Array.isArray(records)) {
    throw new AppError(`Records for ${tableName} must be an array`, 500);
  }

  if (records.length === 0) {
    return {
      table: tableName,
      attempted: 0,
      deleted: 0,
      responses: []
    };
  }

  const responses = [];
  let deleted = 0;
  let lastPayloadField = ODATA_MAPPING.deleteRequestPayloadField;
  let csrfTokenSkipped = false;
  let retriedAfterCsrfFailure = false;

  for (const chunk of chunkRecords(records, INSERT_BATCH_SIZE)) {
    let payload;
    let lastError;

    try {
      payload = buildDeletePayload(tableName, chunk.records);
    } catch (error) {
      throw error;
    }

    for (const payloadField of DELETE_PAYLOAD_FIELD_CANDIDATES) {
      try {
        const deleteBody = buildPayloadEnvelope('DELETE', payload, payloadField);
        const deleteBodySummary = summarizeInsertBody(deleteBody);

        logger.info('Deleting SAP table data', {
          system: systemKey,
          table: tableName,
          entitySet: ODATA_MAPPING.deleteEntitySet,
          requestPayloadField: payloadField,
          recordOffset: chunk.startIndex,
          recordCount: chunk.records.length,
          totalRecordCount: records.length,
          deleteBatchSize: INSERT_BATCH_SIZE,
          rowsSerializedAsString: INSERT_ROWS_AS_STRING,
          deleteBody: {
            requestId: deleteBodySummary.requestId,
            payloadField: deleteBodySummary.payloadField,
            table: deleteBodySummary.table,
            rowsType: deleteBodySummary.rowsType,
            rowCount: deleteBodySummary.rowCount,
            sampleRow: deleteBodySummary.sampleRow
          }
        });

        const { response, csrf, retriedAfterCsrfFailure: retried } = await postWithCsrfRetry(
          client,
          ODATA_MAPPING.deleteEntitySet,
          deleteBody
        );
        const responsePayload = extractPayloadFromResponse(response, systemKey, ODATA_MAPPING.deleteEntitySet);
        const results = normalizePayloadRecords(responsePayload);

        responses.push(...results);
        deleted += chunk.records.length;
        lastPayloadField = payloadField;
        csrfTokenSkipped = csrfTokenSkipped || Boolean(csrf.skipped);
        retriedAfterCsrfFailure = retriedAfterCsrfFailure || Boolean(retried);
        lastError = undefined;

        logger.info('SAP table data delete succeeded', {
          system: systemKey,
          table: tableName,
          entitySet: ODATA_MAPPING.deleteEntitySet,
          status: response.status,
          statusText: response.statusText,
          requestPayloadField: payloadField,
          recordOffset: chunk.startIndex,
          recordCount: chunk.records.length,
          totalRecordCount: records.length,
          deleted,
          responseRecordCount: results.length,
          retriedAfterCsrfFailure: Boolean(retried)
        });

        break;
      } catch (error) {
        lastError = error;

        if (
          payloadField === DELETE_PAYLOAD_FIELD_CANDIDATES.at(-1) ||
          !shouldRetryInsertWithAlternatePayloadField(error)
        ) {
          break;
        }
      }
    }

    if (lastError) {
      const sapError = parseSapError(lastError);

      throw new AppError(
        `Failed to delete ${tableName} in ${systemKey}: ${sapError}`,
        lastError.response?.status || lastError.statusCode || 502,
        {
          table: tableName,
          system: systemKey,
          entitySet: ODATA_MAPPING.deleteEntitySet,
          requestPayloadField: ODATA_MAPPING.deleteRequestPayloadField,
          attemptedPayloadFields: DELETE_PAYLOAD_FIELD_CANDIDATES,
          failedRecordOffset: chunk.startIndex,
          failedRecordCount: chunk.records.length,
          deleted,
          sapError
        }
      );
    }
  }

  return {
    table: tableName,
    attempted: records.length,
    deleted,
    requestPayloadField: lastPayloadField,
    deleteBatchSize: INSERT_BATCH_SIZE,
    csrfTokenSkipped,
    retriedAfterCsrfFailure,
    responses
  };
}

async function getNextNumber(systemKey, numberRangeObject, subObject = '') {
  if (!numberRangeObject) {
    throw new AppError('A number range object is required to get the next number', 500);
  }

  const client = await getSystemClient(systemKey);

  return getNextNumberWithClient(client, systemKey, numberRangeObject, subObject);
}

async function getNextNumberWithClient(client, systemKey, numberRangeObject, subObject = '') {
  if (!numberRangeObject) {
    throw new AppError('A number range object is required to get the next number', 500);
  }

  const body = {
    [ODATA_MAPPING.requestIdField]: createRequestId('NR'),
    Object: numberRangeObject,
    SubObject: subObject,
    Quantity: 1
  };

  try {
    const { response } = await postWithCsrfRetry(
      client,
      ODATA_MAPPING.numberRangeEntitySet,
      body
    );
    const entities = parseODataResponse(response);
    const firstEntity = entities[0] || {};
    const result = firstEntity.Result ||
      firstEntity.RESULT ||
      firstEntity.Number ||
      firstEntity.NUMBER ||
      response.data?.d?.Result ||
      response.data?.Result;

    if (!result) {
      throw new AppError(
        `SAP ${ODATA_MAPPING.numberRangeEntitySet} did not return a number`,
        502,
        {
          system: systemKey,
          numberRangeObject,
          responseShape: Object.keys(firstEntity)
        }
      );
    }

    return String(result);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      `Failed to get next number from ${ODATA_MAPPING.numberRangeEntitySet} for ${numberRangeObject} in ${systemKey}`,
      error.response?.status || 502,
      {
        system: systemKey,
        numberRangeObject,
        sapError: parseSapError(error)
      }
    );
  }
}

module.exports = {
  ODATA_MAPPING,
  getSystemClient,
  fetchServiceMetadata,
  fetchTableData,
  fetchTableDataWithClient,
  pushTableData,
  pushTableDataWithClient,
  deleteTableDataWithClient,
  getNextNumber,
  getNextNumberWithClient,
  postWithCsrfRetry,
  buildInsertBodyForRecords,
  buildDeleteBodyForRecords,
  buildInsertBodyDiagnostics,
  warmCsrfToken,
  parseODataResponse,
  getRawClient
};
