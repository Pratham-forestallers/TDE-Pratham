const objectConfig = require('../config/objectConfig');
const crypto = require('crypto');
const { resolveDestination } = require('./destinationService');
const {
  getSystemClient,
  fetchTableData,
  fetchTableDataWithClient,
  pushTableDataWithClient,
  deleteTableDataWithClient,
  getNextNumberWithClient,
  buildInsertBodyDiagnostics,
  warmCsrfToken,
  getRawClient
} = require('./odataService');
const {
  recordRunHistory,
  getRunHistory,
  updateRunHistory,
  listRunHistory
} = require('./runHistoryStore');
const { AppError } = require('../utils/errorHandler');
const logger = require('../utils/logger');
const syntheticDataClient = require('./syntheticDataClient');
const objectKeyFieldMetadata = require('../config/objectKeyFieldMetadata');

function findObjectConfigByKey(objectKey) {
  const normalizedObjectKey = Number(objectKey);

  if (!Number.isInteger(normalizedObjectKey)) {
    return null;
  }

  const configKey = Object.keys(objectConfig).find(
    (candidate) => objectConfig[candidate].objectKey === normalizedObjectKey
  );

  if (!configKey) {
    return null;
  }

  return {
    configKey,
    definition: objectConfig[configKey]
  };
}

function resolveObjectDefinition(objectTypeOrKey) {
  if (objectConfig[objectTypeOrKey]) {
    return {
      configKey: objectTypeOrKey,
      definition: objectConfig[objectTypeOrKey]
    };
  }

  return findObjectConfigByKey(objectTypeOrKey);
}

async function validateTransferInput({ sourceSystem, targetSystem, objectType, objectId }) {
  if (!sourceSystem || typeof sourceSystem !== 'string') {
    throw new AppError('A valid sourceSystem destination is required', 400);
  }

  if (!targetSystem || typeof targetSystem !== 'string') {
    throw new AppError('A valid targetSystem destination is required', 400);
  }

  if (!objectType || !resolveObjectDefinition(objectType)) {
    throw new AppError('A supported object key is required', 400);
  }

  if (!objectId || typeof objectId !== 'string' || objectId.trim().length === 0) {
    throw new AppError('objectId is required', 400);
  }

  await Promise.all([
    resolveDestination(sourceSystem),
    resolveDestination(targetSystem)
  ]);
}

function normalizeObjectId(objectType, objectId) {
  const value = String(objectId).trim();
  const { definition } = resolveObjectDefinition(objectType) || {};

  if (!definition?.idLength || value.length >= definition.idLength) {
    return value;
  }

  return value.padStart(definition.idLength, definition.idPadChar || '0');
}

function normalizeNumberRangeId(objectType, value) {
  const rawValue = String(value || '').trim();
  const { definition } = resolveObjectDefinition(objectType) || {};

  if (!definition?.idLength || rawValue.length >= definition.idLength) {
    return rawValue;
  }

  return rawValue.padStart(definition.idLength, definition.idPadChar || '0');
}

function getTargetExistenceCheckMode() {
  const mode = String(process.env.TDE_TARGET_EXISTENCE_CHECK || 'optional').toLowerCase();

  return ['skip', 'optional', 'required'].includes(mode) ? mode : 'optional';
}

function createTransferTraceId() {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `TRANSFER_${Date.now()}_${suffix}`;
}

function summarizeResultsForHistory(results) {
  return (results || []).map((entry) => ({
    table: entry.table,
    status: entry.status,
    reason: entry.reason,
    attempted: entry.attempted || 0,
    succeeded: entry.succeeded || 0,
    error: entry.error
  }));
}

function parseRecordData(record) {
  if (!record?.RecordData || typeof record.RecordData !== 'string') {
    return undefined;
  }

  try {
    return JSON.parse(record.RecordData);
  } catch (error) {
    return undefined;
  }
}

function stripRecordMetadata(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return record;
  }

  const { __metadata, ...withoutMetadata } = record;
  return withoutMetadata;
}

function normalizeRecordForRollback(record) {
  const recordData = parseRecordData(record);
  return stripRecordMetadata(recordData || record);
}

function normalizeFieldName(fieldName) {
  return String(fieldName || '').trim().toLowerCase();
}

function normalizeRecordForComparison(record) {
  const recordData = parseRecordData(record);
  const source = recordData || record;

  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return {};
  }

  const { __metadata, ...withoutMetadata } = source;

  return Object.fromEntries(
    Object.entries(withoutMetadata).map(([key, value]) => [key.toLowerCase(), value])
  );
}

function getFieldMappingFieldName(mapping) {
  return mapping.field || mapping.targetField;
}

function replaceMappedValue(key, value, fieldMappings) {
  const normalizedKey = normalizeFieldName(key);
  const mapping = fieldMappings.find((entry) => normalizeFieldName(getFieldMappingFieldName(entry)) === normalizedKey);

  if (!mapping) {
    return value;
  }

  if (typeof value !== 'string') {
    return value === mapping.sourceValue ? mapping.targetValue : value;
  }

  const trimmedValue = value.trim();

  if (trimmedValue === mapping.sourceValue) {
    return mapping.targetValue;
  }

  return value;
}

function generateReplacementFieldValue(fieldName) {
  if (normalizeFieldName(fieldName) === 'ruuid') {
    return crypto.randomBytes(16).toString('base64');
  }

  return undefined;
}

function replaceRegeneratedFieldsInRecordObject(record, fields = []) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || fields.length === 0) {
    return record;
  }

  const fieldSet = new Set(fields.map(normalizeFieldName));

  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      if (!fieldSet.has(normalizeFieldName(key))) {
        return [key, value];
      }

      const replacement = generateReplacementFieldValue(key);
      return [key, replacement === undefined ? value : replacement];
    })
  );
}

function replaceMappedValuesInRecordObject(record, fieldMappings, regeneratedFields = []) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return record;
  }

  const mappedRecord = Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      replaceMappedValue(key, value, fieldMappings)
    ])
  );

  return replaceRegeneratedFieldsInRecordObject(mappedRecord, regeneratedFields);
}

function replaceMappedValuesInRecord(record, fieldMappings, regeneratedFields = []) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return record;
  }

  if (record.RecordData && typeof record.RecordData === 'string') {
    try {
      return {
        ...record,
        RecordData: JSON.stringify(
          replaceMappedValuesInRecordObject(JSON.parse(record.RecordData), fieldMappings, regeneratedFields)
        )
      };
    } catch (error) {
      throw new AppError(
        'Unable to parse RecordData before renumbering transfer payload',
        500,
        {
          parseError: error.message
        }
      );
    }
  }

  return replaceMappedValuesInRecordObject(record, fieldMappings, regeneratedFields);
}

function extractObjectIdFieldsFromWhereTemplate(template) {
  if (!template || typeof template !== 'string' || !template.includes('{OBJECT_ID}')) {
    return [];
  }

  const fields = [];
  const objectIdPredicatePattern = /([A-Z0-9_]+)\s*=\s*'\{OBJECT_ID\}'/gi;
  let match;

  while ((match = objectIdPredicatePattern.exec(template)) !== null) {
    fields.push(match[1].toUpperCase());
  }

  return fields;
}

function getObjectIdFieldsForTable(definition, tableName) {
  const fields = new Set();
  const keyFieldByTable = definition.keyFieldByTable || {};
  const whereClauseByTable = definition.whereClauseByTable || {};

  fields.add((keyFieldByTable[tableName] || definition.keyField || 'OBJECT_ID').toUpperCase());

  for (const field of extractObjectIdFieldsFromWhereTemplate(whereClauseByTable[tableName])) {
    fields.add(field);
  }

  return [...fields];
}

async function buildRenumberValueMap(definition, sourceObjectId, targetObjectId, context, targetClient, targetSystem) {
  const valueMappings = [{
    sourceValue: String(sourceObjectId),
    targetValue: targetObjectId,
    fieldsByTable: Object.fromEntries(
      (definition.writeSequence || definition.fetchSequence || []).map((tableName) => [
        tableName,
        getObjectIdFieldsForTable(definition, tableName)
      ])
    )
  }];
  const generatedKeys = [];
  const updatedContext = { ...context };

  for (const mapping of definition.renumberValueMappings || []) {
    const sourceValue = context[mapping.sourceContextField];

    if (sourceValue === undefined || sourceValue === null || sourceValue === '') {
      continue;
    }

    if (mapping.target === 'objectId') {
      valueMappings.push({
        fields: [mapping.targetContextField || mapping.sourceContextField],
        sourceValue: String(sourceValue),
        targetValue: targetObjectId
      });
      updatedContext[mapping.targetContextField || mapping.sourceContextField] = targetObjectId;
      generatedKeys.push({
        field: mapping.targetContextField || mapping.sourceContextField,
        sourceValue: String(sourceValue),
        targetValue: targetObjectId,
        source: 'objectId'
      });
      continue;
    }

    if (mapping.target === 'numberRange') {
      if (!mapping.numberRangeObject) {
        throw new AppError(
          `A number range object is required to renumber ${mapping.sourceContextField}`,
          500,
          {
            sourceContextField: mapping.sourceContextField,
            requiredEnv: `TDE_${mapping.sourceContextField}_NUMBER_RANGE_OBJECT`
          }
        );
      }

      const nextValue = await getNextNumberWithClient(
        targetClient,
        targetSystem,
        mapping.numberRangeObject,
        mapping.numberRangeSubObject || ''
      );
      const targetValue = String(nextValue);
      const targetContextField = mapping.targetContextField || mapping.sourceContextField;

      valueMappings.push({
        fields: [targetContextField],
        sourceValue: String(sourceValue),
        targetValue
      });
      updatedContext[targetContextField] = targetValue;
      generatedKeys.push({
        field: targetContextField,
        sourceValue: String(sourceValue),
        targetValue,
        numberRangeObject: mapping.numberRangeObject,
        numberRangeSubObject: mapping.numberRangeSubObject || ''
      });
    }
  }

  return {
    valueMappings,
    generatedKeys,
    context: updatedContext
  };
}

function getFieldMappingsForTable(tableName, valueMappings) {
  return valueMappings.flatMap((mapping) => {
    const fields = mapping.fieldsByTable?.[tableName] || mapping.fields || [];

    return fields.map((field) => ({
      field,
      sourceValue: mapping.sourceValue,
      targetValue: mapping.targetValue
    }));
  });
}

async function renumberSourceTables(sourceTables, definition, sourceObjectId, targetObjectId, context, targetClient, targetSystem) {
  const renumbering = await buildRenumberValueMap(
    definition,
    sourceObjectId,
    targetObjectId,
    context,
    targetClient,
    targetSystem
  );

  return {
    tables: sourceTables.map((entry) => ({
      ...entry,
      records: entry.records.map((record) => replaceMappedValuesInRecord(
        record,
        getFieldMappingsForTable(entry.table, renumbering.valueMappings),
        definition.regenerateFieldsByTable?.[entry.table] || []
      ))
    })),
    generatedKeys: renumbering.generatedKeys,
    context: renumbering.context
  };
}

function applyConfiguredTableTransforms(sourceTables, definition) {
  return sourceTables.map((entry) => ({
    ...entry,
    records: entry.records.map((record) => replaceMappedValuesInRecord(
      record,
      [],
      definition.regenerateFieldsByTable?.[entry.table] || []
    ))
  }));
}

function normalizeComparableValue(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return String(value).trim();
}

function compareInsertedRowToTarget(insertRow, targetRecord) {
  const sent = normalizeRecordForComparison(insertRow);
  const target = normalizeRecordForComparison(targetRecord);

  const sentFields = Object.keys(sent);
  const targetFields = Object.keys(target);
  const targetFieldSet = new Set(targetFields);
  const missingFields = sentFields.filter((field) => !targetFieldSet.has(field));
  const blankedFields = sentFields.filter((field) => (
    targetFieldSet.has(field) &&
    normalizeComparableValue(sent[field]) !== '' &&
    normalizeComparableValue(target[field]) === ''
  ));
  const differentFields = sentFields
    .filter((field) => (
      targetFieldSet.has(field) &&
      normalizeComparableValue(sent[field]) !== '' &&
      normalizeComparableValue(target[field]) !== '' &&
      normalizeComparableValue(sent[field]) !== normalizeComparableValue(target[field])
    ))
    .map((field) => ({
      field,
      sent: sent[field],
      target: target[field]
    }));

  return {
    sentFieldCount: sentFields.length,
    targetFieldCount: targetFields.length,
    missingFieldCount: missingFields.length,
    blankedFieldCount: blankedFields.length,
    differentFieldCount: differentFields.length,
    missingFields,
    blankedFields,
    differentFields: differentFields.slice(0, 50),
    targetOnlyFields: targetFields.filter((field) => !sentFields.includes(field))
  };
}

function getTableSequence(definition, sequenceName) {
  const configuredSequence = definition?.[sequenceName];

  if (Array.isArray(configuredSequence) && configuredSequence.length > 0) {
    return configuredSequence;
  }

  return [definition.rootTable];
}

function shouldSkipIndependentFetch(definition, tableName) {
  return Array.isArray(definition?.independentTables) &&
    definition.independentTables.includes(tableName) &&
    !definition?.whereClauseByTable?.[tableName] &&
    !definition?.keyFieldByTable?.[tableName];
}

function summarizePreviewTables(tables) {
  return tables.map((entry) => ({
    table: entry.table,
    rowCount: entry.records.length,
    sampleFieldCount: Object.keys(normalizeRecordForComparison(entry.records[0] || {})).length,
    status: entry.status || (entry.records.length > 0 ? 'HAS_DATA' : 'NO_DATA'),
    reason: entry.reason
  }));
}

function isInactiveTransparentTableError(error) {
  const messageParts = [
    error?.message,
    error?.details?.sapError,
    error?.details?.error,
    error?.response?.data?.error?.message?.value,
    error?.response?.data?.error?.message,
    typeof error?.response?.data === 'string' ? error.response.data : undefined
  ].filter(Boolean);
  const combinedMessage = messageParts.join(' ').toLowerCase();

  return /not an active transparent table|is not active|table .* not active|table .* does not exist/.test(combinedMessage);
}

function isUnknownDatabaseColumnError(error) {
  const messageParts = [
    error?.message,
    error?.details?.sapError,
    error?.details?.error,
    error?.response?.data?.error?.message?.value,
    error?.response?.data?.error?.message,
    typeof error?.response?.data === 'string' ? error.response.data : undefined
  ].filter(Boolean);
  const combinedMessage = messageParts.join(' ').toLowerCase();

  return /database column .* is unknown|unknown database column|column .* is unknown/.test(combinedMessage);
}

function buildInactiveTableSkip(tableName, error, system) {
  return {
    table: tableName,
    records: [],
    status: 'SKIPPED',
    reason: 'Table is not active or does not exist in SAP',
    system,
    error: error.message,
    sapError: error.details?.sapError
  };
}

function buildUnknownColumnTableSkip(tableName, error, system) {
  return {
    table: tableName,
    records: [],
    status: 'SKIPPED',
    reason: 'Configured key field is not available in SAP table',
    system,
    error: error.message,
    sapError: error.details?.sapError
  };
}

function buildUnmappedIndependentTableSkip(tableName, system) {
  return {
    table: tableName,
    records: [],
    status: 'SKIPPED',
    reason: 'Independent table has no configured object-id relationship',
    system
  };
}

function buildCleanupGuidance({ objectType, sourceObjectId, objectId, generatedKeys, results, failedTable }) {
  const insertedTables = (results || [])
    .filter((entry) => entry.status === 'SUCCESS' && entry.succeeded > 0)
    .map((entry) => ({
      table: entry.table,
      insertedRows: entry.succeeded
    }));

  if (insertedTables.length === 0) {
    return {
      status: 'NO_WRITE',
      message: 'No target table writes were confirmed before the transfer stopped.',
      objectType,
      sourceObjectId,
      objectId,
      generatedKeys
    };
  }

  return {
    status: 'PARTIAL_WRITE',
    message: 'Some target records were inserted before the transfer stopped. Clean up this generated target object before retrying, or run a fresh transfer so new keys are generated.',
    objectType,
    sourceObjectId,
    objectId,
    generatedKeys,
    insertedTables,
    failedTable,
    suggestedAction: `Review and clean target ${objectType} ${objectId} in SAP before retrying this transfer.`
  };
}

async function runTransferPreflight({
  targetClient,
  targetSystem,
  objectType,
  objectId,
  sourceObjectId,
  definition,
  context,
  sourceTables,
  generatedKeys,
  traceId
}) {
  const tableByName = new Map(sourceTables.map((entry) => [entry.table, entry]));
  const checks = [];

  for (const tableName of getTableSequence(definition, 'writeSequence')) {
    const sourceEntry = tableByName.get(tableName) || { table: tableName, records: [] };

    if (sourceEntry.records.length === 0) {
      checks.push({
        table: tableName,
        status: sourceEntry.status || 'SKIPPED',
        sourceRecordCount: 0,
        targetRecordCount: 0,
        reason: sourceEntry.reason || 'No source rows found',
        error: sourceEntry.error
      });
      continue;
    }

    let targetRecords = [];

    try {
      targetRecords = await fetchTableDataWithClient(
        targetClient,
        targetSystem,
        tableName,
        objectId,
        objectType,
        context
      );
    } catch (error) {
      if (!isInactiveTransparentTableError(error)) {
        throw error;
      }

      logger.warn('Skipping target preflight check because SAP table is inactive or unavailable', {
        traceId,
        targetSystem,
        objectType,
        objectId,
        sourceObjectId,
        table: tableName,
        error: error.message,
        sapError: error.details?.sapError
      });

      checks.push({
        table: tableName,
        status: 'SKIPPED',
        sourceRecordCount: sourceEntry.records.length,
        targetRecordCount: 0,
        reason: 'Target table is not active or does not exist in SAP',
        error: error.message
      });
      continue;
    }

    checks.push({
      table: tableName,
      status: targetRecords.length > 0 ? 'CONFLICT' : 'CLEAR',
      sourceRecordCount: sourceEntry.records.length,
      targetRecordCount: targetRecords.length
    });
  }

  const conflicts = checks.filter((entry) => entry.status === 'CONFLICT');
  const preflight = {
    status: conflicts.length > 0 ? 'FAILED' : 'PASSED',
    checkedAt: new Date().toISOString(),
    checks
  };

  if (conflicts.length > 0) {
    logger.warn('Transfer preflight found existing target records; stopping before writes', {
      traceId,
      objectType,
      objectId,
      sourceObjectId,
      targetSystem,
      conflicts
    });

    throw new AppError(
      `Preflight found existing target data for ${objectType} ${objectId}. No records were written.`,
      409,
      {
        objectType,
        objectId,
        sourceObjectId,
        targetSystem,
        traceId,
        preflight,
        cleanupGuidance: buildCleanupGuidance({
          objectType,
          sourceObjectId,
          objectId,
          generatedKeys,
          results: [],
          failedTable: conflicts[0]?.table
        })
      }
    );
  }

  logger.info('Transfer preflight passed', {
    traceId,
    objectType,
    objectId,
    sourceObjectId,
    targetSystem,
    checkedTableCount: checks.length
  });

  return preflight;
}

function addDependencyContext(context, tableName, records, definition) {
  const dependencyFields = definition.dependencyFields?.[tableName] || [];

  if (!Array.isArray(dependencyFields) || dependencyFields.length === 0 || records.length === 0) {
    return context;
  }

  const normalizedRecord = normalizeRecordForComparison(records[0]);
  const additions = {};

  for (const fieldName of dependencyFields) {
    const value = normalizedRecord[fieldName.toLowerCase()];

    if (value !== undefined && value !== null && value !== '') {
      additions[fieldName] = value;
    }
  }

  return {
    ...context,
    ...additions
  };
}

// ── Phone masking helper (used for both regular & synthetic transfers) ────────
const PHONE_FIELD_NAMES = new Set(['TELF1', 'TELFX', 'MOBIL', 'TELNR', 'TELEPHONE']);

function _maskPhoneValue(val) {
  if (!val || typeof val !== 'string') return val;
  const parts = val.split(/(\d+)/);
  let digitCount = 0;
  return parts.map(p => {
    if (/^\d+$/.test(p)) {
      digitCount++;
      return digitCount > 1 ? '*'.repeat(p.length) : p; // keep first digit group (area code)
    }
    return p;
  }).join('');
}

function maskPhoneFields(records) {
  return records.map(record => {
    const masked = { ...record };
    for (const key of Object.keys(masked)) {
      if (PHONE_FIELD_NAMES.has(key.toUpperCase())) {
        masked[key] = _maskPhoneValue(masked[key]);
      }
    }
    return masked;
  });
}
// ─────────────────────────────────────────────────────────────────────────────

async function fetchConfiguredTables(sourceClient, sourceSystem, objectType, objectId, definition) {
  const tables = [];
  let context = { OBJECT_ID: objectId };

  for (const tableName of getTableSequence(definition, 'fetchSequence')) {
    let records = [];

    if (shouldSkipIndependentFetch(definition, tableName)) {
      logger.info('Skipping independent source table without configured object relationship', {
        sourceSystem,
        objectType,
        objectId,
        table: tableName
      });

      tables.push(buildUnmappedIndependentTableSkip(tableName, sourceSystem));
      continue;
    }

    try {
      records = await fetchTableDataWithClient(
        sourceClient,
        sourceSystem,
        tableName,
        objectId,
        objectType,
        context
      );
    } catch (error) {
      const isMissingDependency = (
        error instanceof AppError &&
        error.message === 'Unable to build WhereClause because dependency field KNUMV is missing'
      ) || (
        error instanceof AppError &&
        error.details?.missingField
      );

      if (isInactiveTransparentTableError(error)) {
        logger.warn('Skipping source table fetch because SAP table is inactive or unavailable', {
          sourceSystem,
          objectType,
          objectId,
          table: tableName,
          error: error.message,
          sapError: error.details?.sapError
        });

        tables.push(buildInactiveTableSkip(tableName, error, sourceSystem));
        continue;
      }

      if (isUnknownDatabaseColumnError(error)) {
        logger.warn('Skipping source table fetch because configured key field is unavailable', {
          sourceSystem,
          objectType,
          objectId,
          table: tableName,
          error: error.message,
          sapError: error.details?.sapError
        });

        tables.push(buildUnknownColumnTableSkip(tableName, error, sourceSystem));
        continue;
      }

      if (!isMissingDependency) {
        throw error;
      }

      logger.warn('Skipping dependent SAP table fetch because a prerequisite field is missing', {
        sourceSystem,
        objectType,
        objectId,
        table: tableName,
        missingField: error.details?.missingField,
        availableFields: error.details?.availableFields
      });
    }

    tables.push({ table: tableName, records });
    context = addDependencyContext(context, tableName, records, definition);
  }

  return {
    tables,
    context
  };
}

async function resolveTargetObjectId({
  targetClient,
  targetSystem,
  objectType,
  objectId,
  definition,
  context,
  traceId
}) {
  const mode = getTargetExistenceCheckMode();

  if (mode === 'skip') {
    return {
      objectId,
      sourceObjectId: objectId,
      renumbered: false,
      targetExistenceCheck: {
        mode,
        status: 'SKIPPED'
      }
    };
  }

  try {
    const targetRecords = await fetchTableDataWithClient(
      targetClient,
      targetSystem,
      definition.rootTable,
      objectId,
      objectType,
      context
    );

    if (targetRecords.length === 0) {
      return {
        objectId,
        sourceObjectId: objectId,
        renumbered: false,
        targetExistenceCheck: {
          mode,
          status: 'AVAILABLE',
          table: definition.rootTable,
          existingRecordCount: 0
        }
      };
    }

    if (!definition.numberRangeObject) {
      throw new AppError(
        `Target ${targetSystem} already has ${objectType} ${objectId}, but no number range object is configured`,
        409,
        {
          objectType,
          objectId,
          targetSystem,
          rootTable: definition.rootTable
        }
      );
    }

    const nextNumber = await getNextNumberWithClient(
      targetClient,
      targetSystem,
      definition.numberRangeObject,
      definition.numberRangeSubObject || ''
    );
    const newObjectId = normalizeNumberRangeId(objectType, nextNumber);

    logger.info('Target object exists; using next number range value', {
      traceId,
      objectType,
      sourceObjectId: objectId,
      targetObjectId: newObjectId,
      targetSystem,
      rootTable: definition.rootTable,
      existingRecordCount: targetRecords.length,
      numberRangeObject: definition.numberRangeObject
    });

    return {
      objectId: newObjectId,
      sourceObjectId: objectId,
      renumbered: true,
      targetExistenceCheck: {
        mode,
        status: 'RENUMBERED',
        table: definition.rootTable,
        existingRecordCount: targetRecords.length,
        numberRangeObject: definition.numberRangeObject,
        sourceObjectId: objectId,
        targetObjectId: newObjectId
      }
    };
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 409) {
      throw error;
    }

    if (mode === 'optional') {
      logger.warn('Target existence check failed; continuing with original object id', {
        traceId,
        objectType,
        objectId,
        targetSystem,
        error: error.message,
        statusCode: error.statusCode
      });

      return {
        objectId,
        sourceObjectId: objectId,
        renumbered: false,
        targetExistenceCheck: {
          mode,
          status: 'FAILED_CONTINUED',
          error: error.message,
          statusCode: error.statusCode
        }
      };
    }

    throw new AppError(
      `Target existence check failed for ${objectType} ${objectId} in ${targetSystem}`,
      error.statusCode || error.response?.status || 502,
      {
        objectType,
        objectId,
        targetSystem,
        traceId,
        details: error.details,
        rawResponse: error.response?.data
      }
    );
  }
}

async function verifyTargetTable(targetClient, targetSystem, tableName, objectType, objectId, context, insertSampleRow) {
  try {
    const targetRecords = await fetchTableDataWithClient(
      targetClient,
      targetSystem,
      tableName,
      objectId,
      objectType,
      context
    );

    return {
      targetFetchedRecordCount: targetRecords.length,
      comparison: compareInsertedRowToTarget(insertSampleRow || {}, targetRecords[0] || {})
    };
  } catch (verificationError) {
    return {
      error: verificationError.message,
      statusCode: verificationError.statusCode
    };
  }
}

async function previewTransfer({ sourceSystem, targetSystem, objectKey, objectType, objectId, synthesize }) {
  const requestedObject = objectKey || objectType;
  const normalizedObjectId = normalizeObjectId(requestedObject, objectId);
  await validateTransferInput({ sourceSystem, targetSystem, objectType: requestedObject, objectId: normalizedObjectId });

  const { configKey, definition } = resolveObjectDefinition(requestedObject);
  const sourceClient = await getSystemClient(sourceSystem);
  await warmCsrfToken(sourceClient);
  const { tables } = await fetchConfiguredTables(
    sourceClient,
    sourceSystem,
    configKey,
    normalizedObjectId,
    definition
  );

  // Preview always shows real data — synthesis is a separate transfer-time operation
  return {
    success: true,
    objectType: configKey,
    objectKey: definition.objectKey,
    objectDescription: definition.description,
    objectId: normalizedObjectId,
    sourceSystem,
    targetSystem,
    summary: {
      tableCount: tables.length,
      tables: summarizePreviewTables(tables)
    }
  };
}

async function executeTransfer(payload) {
  const {
    sourceSystem, targetSystem, objectKey, objectType, objectId, synthesize,
    // Masking option (applies to both regular and synthetic transfers)
    maskPhoneNumbers = false,
    // Synthetic sampling options
    mode: sampleMode = 'top',
    sampleCount = 500,
    sampleFrom = 0,
    sampleTo = 200,
    generateCount = 100,
    optionalFollowons = []
  } = payload;
  const traceId = createTransferTraceId();
  const startedAt = new Date().toISOString();
  const requestedObject = objectKey || objectType;
  const normalizedObjectId = normalizeObjectId(requestedObject, objectId);

  await validateTransferInput({ sourceSystem, targetSystem, objectType: requestedObject, objectId: normalizedObjectId });

  const { configKey, definition } = resolveObjectDefinition(requestedObject);

  // Fetch all configured source tables first. Tables without rows are skipped
  // during the target write.
  const sourceClient = await getSystemClient(sourceSystem);
  await warmCsrfToken(sourceClient);
  const { tables: fetchedSourceTables, context } = await fetchConfiguredTables(
    sourceClient,
    sourceSystem,
    configKey,
    normalizedObjectId,
    definition
  );
  const totalSourceRecords = fetchedSourceTables.reduce((total, entry) => total + entry.records.length, 0);

  if (totalSourceRecords === 0) {
    throw new AppError(
      `No source records found for ${definition.description} ${normalizedObjectId} in ${sourceSystem}. Nothing was transferred.`,
      404,
      {
        objectType: configKey,
        objectKey: definition.objectKey,
        objectId: normalizedObjectId,
        sourceSystem,
        targetSystem,
        traceId,
        results: fetchedSourceTables.map((entry) => ({
          table: entry.table,
          status: entry.status || 'NO_DATA',
          reason: entry.reason,
          attempted: 0,
          succeeded: 0,
          error: entry.error,
          sapError: entry.sapError
        }))
      }
    );
  }

  const targetClient = await getSystemClient(targetSystem);
  await warmCsrfToken(targetClient);
  const targetResolution = await resolveTargetObjectId({
    targetClient,
    targetSystem,
    objectType: configKey,
    objectKey: definition.objectKey,
    objectId: normalizedObjectId,
    definition,
    context,
    traceId
  });
  const effectiveObjectId = targetResolution.objectId;
  const transferKey = definition.keyField || 'OBJECT_ID';
  const rootGeneratedKey = targetResolution.renumbered
    ? [{
      field: transferKey,
      sourceValue: normalizedObjectId,
      targetValue: effectiveObjectId,
      numberRangeObject: definition.numberRangeObject,
      numberRangeSubObject: definition.numberRangeSubObject || ''
    }]
    : [];
  const renumberedPayload = targetResolution.renumbered
    ? await renumberSourceTables(
      fetchedSourceTables,
      definition,
      normalizedObjectId,
      effectiveObjectId,
      context,
      targetClient,
      targetSystem
    )
    : {
      tables: applyConfiguredTableTransforms(fetchedSourceTables, definition),
      generatedKeys: [],
      context
    };

  // --- SYNTHETIC DATA: Generate NEW records and push to target independently ---
  if (synthesize) {
    try {
      logger.info('Starting synthetic data transfer', { sourceSystem, configKey, sampleMode, sampleCount, sampleFrom, sampleTo, generateCount });

      // Step 1: Fetch reference rows from source using the user-selected sampling strategy.
      let referenceRecords = fetchedSourceTables.length > 0 ? fetchedSourceTables[0].records : [];
      const primaryTable = fetchedSourceTables.length > 0 ? fetchedSourceTables[0].table : configKey;

      // If we need more than what's already fetched, or a different strategy, re-fetch.
      const needsRefetch = sampleMode === 'random' || sampleMode === 'range' ||
                           (sampleMode === 'top' && sampleCount > referenceRecords.length);

      if (needsRefetch) {
        try {
          const rawClient = await getSystemClient(sourceSystem);
          let url;
          if (sampleMode === 'range') {
            const rangeSize = Math.max(1, sampleTo - sampleFrom);
            url = `/${primaryTable}?$skip=${sampleFrom}&$top=${rangeSize}&$format=json`;
          } else if (sampleMode === 'random') {
            const totalApprox = 10000;
            const maxSkip = Math.max(0, totalApprox - sampleCount);
            const randomSkip = Math.floor(Math.random() * maxSkip);
            url = `/${primaryTable}?$skip=${randomSkip}&$top=${sampleCount}&$format=json`;
          } else {
            url = `/${primaryTable}?$top=${sampleCount}&$format=json`;
          }
          const refResponse = await rawClient.get(url);
          const fetched = refResponse.data?.d?.results || refResponse.data?.value || [];
          if (fetched.length > 0) {
            referenceRecords = fetched;
            logger.info(`Re-fetched ${fetched.length} reference rows (mode=${sampleMode})`, { primaryTable, url });
          }
        } catch (err) {
          logger.warn(`Could not re-fetch reference rows via GET (${err.message}), attempting POST fallback for generic API`);
          try {
             // Fallback for Generic API which uses FetchDataSet via POST
             const rawClient = await getSystemClient(sourceSystem);
             const fallbackCount = sampleMode === 'random' ? Math.max(1000, sampleCount * 2) : sampleCount;
             
             const fetchedRows = await fetchTableDataWithClient(
                rawClient, sourceSystem, primaryTable, '__FETCH_ALL__', configKey, { rows: fallbackCount }
             );
             
             if (fetchedRows && fetchedRows.length > 0) {
                if (sampleMode === 'random') {
                   // Shuffle and pick
                   referenceRecords = fetchedRows.sort(() => 0.5 - Math.random()).slice(0, sampleCount);
                } else if (sampleMode === 'range') {
                   // Fallback for range: just slice
                   const rangeSize = Math.max(1, sampleTo - sampleFrom);
                   referenceRecords = fetchedRows.slice(sampleFrom, sampleFrom + rangeSize);
                } else {
                   referenceRecords = fetchedRows.slice(0, sampleCount);
                }
                logger.info(`Re-fetched ${referenceRecords.length} reference rows using Generic API POST fallback`);
             }
          } catch (fallbackErr) {
             logger.warn(`Fallback POST re-fetch failed (${fallbackErr.message}), using already-fetched single row`);
          }
        }
      }

      // Step 2: Fetch the current MAX synthetic VBELN from the target system.
      // Query VBAK directly via FetchDataSet filtering only synthetic range >= 9900000000.
      // This sees ALL previously inserted synthetic records and prevents key collisions.
      let maxId = 0;
      let pkField = 'VBELN';

      try {
        const maxRows = await fetchTableData(
          targetSystem,
          'VBAK',
          '__FETCH_ALL__',
          configKey,
          { where: "VBELN >= '9900000000'", rows: 5000 }
        );

        for (const row of (maxRows || [])) {
          const vbeln = row.VBELN || row.vbeln || '';
          const parsed = parseInt(vbeln, 10) || 0;
          if (parsed > maxId) maxId = parsed;
        }

        if (maxId > 0) {
          logger.info(`Found current MAX synthetic VBELN in ${targetSystem}: ${maxId}`);
        }
      } catch (err) {
        logger.warn(`Could not fetch MAX synthetic VBELN via VBAK FetchDataSet: ${err.message}. Will use random offset.`);
      }

      // Step 3: Generate VBAK (root/Type A table) synthetic records via Python ML engine.
      // Use incremental 99* generation. If maxId is already in the 99* range, increment it.
      // Otherwise, start exactly at 9900000000.
      let baseOffsetToUse = maxId > 0 ? maxId + 1 : null;
      if (baseOffsetToUse !== null && baseOffsetToUse < 9900000000) {
          baseOffsetToUse = null; // Let python randomize it if maxId is suspiciously low
      }
      
      const numToGenerate = generateCount;

      // Pre-select one anchor source record per synthetic order BEFORE ML generation.
      // These anchors ensure the generated VBAK has a coherent customer+sales-area combo.
      // Filter to Standard Orders (AUART='TA') so all anchors have proper item data.
      const standardOrderRefs = referenceRecords.filter(r => {
        const auart = r.AUART || r.auart || r.Auart || '';
        return auart.trim().toUpperCase() === 'TA';
      });
      let qualifiedRefs = standardOrderRefs.length > 0 ? standardOrderRefs : referenceRecords;

      // --- KNVV Validation: only keep anchors whose KUNNR is actually extended to the sales area ---
      // This prevents "Sold-to party not maintained for sales area" errors in VA03.
      try {
        // Detect the sales area from the first qualified ref
        const sampleRef = qualifiedRefs[0] || {};
        const vkorg = sampleRef.VKORG || sampleRef.vkorg || '';
        const vtweg = sampleRef.VTWEG || sampleRef.vtweg || '';
        const spart = sampleRef.SPART || sampleRef.spart || '00';

        if (vkorg && vtweg) {
          const knvvWhere = `VKORG = '${vkorg}' AND VTWEG = '${vtweg}' AND SPART = '${spart}'`;
          const knvvRows = await fetchTableData(targetSystem, 'KNVV', '__FETCH_ALL__', configKey, {
            where: knvvWhere,
            rows: 2000
          });
          const validKunnrs = new Set(
            (knvvRows || []).map(r => (r.KUNNR || r.kunnr || '').trim()).filter(Boolean)
          );
          if (validKunnrs.size > 0) {
            const knvvFiltered = qualifiedRefs.filter(r => {
              const kunnr = (r.KUNNR || r.kunnr || '').trim();
              return validKunnrs.has(kunnr);
            });
            if (knvvFiltered.length > 0) {
              qualifiedRefs = knvvFiltered;
              logger.info(`KNVV filter: ${knvvFiltered.length} anchors confirmed valid for sales area ${vkorg}/${vtweg}/${spart} (from ${validKunnrs.size} valid customers)`);
            } else {
              logger.warn(`KNVV filter found no overlap — using unfiltered pool. Check customer master for ${vkorg}/${vtweg}/${spart}.`);
            }
          }
        }
      } catch (knvvErr) {
        logger.warn(`KNVV pre-flight lookup failed (${knvvErr.message}), proceeding without customer validation`);
      }
      // -----------------------------------------------------------------------------------------

      const shuffledQualified = [...qualifiedRefs].sort(() => 0.5 - Math.random());
      // selectedAnchors[i] is the source record whose key fields will be used for syntheticRootRecords[i]
      const selectedAnchors = Array.from({ length: numToGenerate }, (_, i) =>
        shuffledQualified[i % shuffledQualified.length]
      );

      logger.info(`Template pool: ${qualifiedRefs.length} qualifying anchors (TA + KNVV-validated)`);


      const { records: syntheticRootRecords, actualBaseOffset } = await syntheticDataClient.requestSyntheticData(
        primaryTable,
        referenceRecords,
        numToGenerate,
        baseOffsetToUse,
        maskPhoneNumbers,
        optionalFollowons
      );

      // Overlay coherence-critical fields from each anchor record onto the ML-generated VBAK.
      // This guarantees that KUNNR is always valid for the VKORG/VTWEG/SPART combination.
      const COHERENCE_FIELDS = ['KUNNR', 'kunnr', 'VKORG', 'vkorg', 'VTWEG', 'vtweg', 'SPART', 'spart',
                                 'AUART', 'auart', 'VBTYP', 'vbtyp', 'BUKRS', 'bukrs', 'WAERK', 'waerk'];
      if (syntheticRootRecords && syntheticRootRecords.length > 0) {
        syntheticRootRecords.forEach((rec, i) => {
          const anchor = selectedAnchors[i];
          if (!anchor) return;
          for (const field of COHERENCE_FIELDS) {
            if (anchor[field] !== undefined && anchor[field] !== null && anchor[field] !== '') {
              rec[field] = anchor[field];
            }
          }

          // Ensure 'from' dates are smaller than or equal to 'to' dates
          // Since the ML generates columns independently, validity periods can get reversed
          const datePairs = [
            { from: 'GUEBG', to: 'GUEEN' },
            { from: 'ANGDT', to: 'BNDDT' },
            { from: 'KDATB', to: 'KDATE' }
          ];

          for (const pair of datePairs) {
            const fromKey = Object.keys(rec).find(k => k.toUpperCase() === pair.from);
            const toKey = Object.keys(rec).find(k => k.toUpperCase() === pair.to);
            
            if (fromKey && toKey) {
               const fromVal = rec[fromKey];
               const toVal = rec[toKey];
               
               // SAP dates are YYYYMMDD or /Date(...)/. String comparison works for both to determine order.
               // Ignore '00000000' which means no end date
               if (fromVal && toVal && typeof fromVal === 'string' && typeof toVal === 'string' && toVal !== '00000000') {
                  if (fromVal > toVal) {
                     // Swap them
                     rec[fromKey] = toVal;
                     rec[toKey] = fromVal;
                  }
               }
            }
          }
        });
        logger.info('Overlaid coherence fields (KUNNR/VKORG/VTWEG/SPART/AUART) from anchor records onto synthetic VBAK');
      }

      // Lock in the actual base offset used (Python may have chosen a random 99xxxxxxxx base)
      const resolvedBase = actualBaseOffset ?? null;

      // Compute ID range for reporting
      let idRange = 'N/A';
      if (resolvedBase !== null && resolvedBase !== undefined && syntheticRootRecords.length > 0) {
        idRange = `${resolvedBase} to ${resolvedBase + syntheticRootRecords.length - 1}`;
      }
      logger.info(`Generated ID range: ${idRange} (pkField=${pkField}, actualBaseOffset=${actualBaseOffset})`);

      // Setup target client (warm CSRF once, reuse for all table pushes)
      const targetClient2 = await getSystemClient(targetSystem);
      await warmCsrfToken(targetClient2);

      const allTableResults = [];

      // Step 4: Push root table (VBAK) records to target.
      if (syntheticRootRecords && syntheticRootRecords.length > 0) {
        logger.info(`Pushing ${syntheticRootRecords.length} NEW synthetic ${primaryTable} records to target`, { targetSystem });
        const rootPushResult = await pushTableDataWithClient(targetClient2, targetSystem, primaryTable, syntheticRootRecords);
        allTableResults.push({
          table: primaryTable,
          status: rootPushResult.succeeded > 0 ? 'SYNTHETIC_INSERTED' : 'FAILED',
          attempted: rootPushResult.attempted,
          succeeded: rootPushResult.succeeded
        });
      }

      // Step 4.5: Fetch dynamic child templates
      const childTemplates = [];
      const templateCount = Math.min(10, referenceRecords.length);
      if (templateCount > 0) {
        logger.info(`Fetching ${templateCount} dynamic child templates for synthetic generation`);
        
        // Use the same anchor records already selected before ML generation.
        // This ensures child templates match the header's KUNNR/VKORG/VTWEG/SPART.
        const selectedRefs = selectedAnchors.slice(0, templateCount);
        const fallbackPk = definition.keyField || 'OBJECT_ID';
        
        const fetchPromises = selectedRefs.map(async (ref) => {
          const vbeln = ref[fallbackPk] || ref.SalesOrder || ref.VBELN || ref.vbeln;
          if (vbeln) {
             try {
                // Fetch the full relational tree for this reference record
                const { tables } = await fetchConfiguredTables(
                  sourceClient, sourceSystem, configKey, String(vbeln), definition
                );
                // Slice(1) to remove VBAK, keeping only child tables
                return tables.slice(1);
             } catch (err) {
                logger.warn(`Failed to fetch child template for ${vbeln}: ${err.message}`);
                return null;
             }
          }
          return null;
        });
        
        const results = await Promise.all(fetchPromises);
        for (const res of results) {
           if (res && res.length > 0) childTemplates.push(res);
        }
      }
      
      // Fallback: if dynamic fetching failed, just use the single UI objectId child tables
      if (childTemplates.length === 0) {
         childTemplates.push(fetchedSourceTables.slice(1));
      }

      // Step 5: Populate Type B & C child tables using dynamic round-robin strategy.
      // Tables that are virtual/computed and should never be directly inserted.
      const SKIP_INSERT_TABLES = new Set(['SALESDOC_CNT', 'PRCD_ELEMENTS', 'VBFA']);
      const SKIP_TEMPLATE_TABLES = new Set(['VBFA']);
      const VBELV_TABLE = 'VBFA';

      const allSyntheticChildRecordsByTable = {}; // table -> records[]
      const tableOrder = []; // maintain insertion order
      
      for (let orderIdx = 0; orderIdx < numToGenerate; orderIdx++) {
         const syntheticVbeln = String(resolvedBase + orderIdx).padStart(10, '0');
         
         // Round-robin selection of a child template
         const templateTables = childTemplates[orderIdx % childTemplates.length];
         
         for (const tableEntry of templateTables) {
            if (!tableEntry.records || tableEntry.records.length === 0) continue;
            if (tableEntry.status === 'SKIPPED') continue;
            if (SKIP_TEMPLATE_TABLES.has(tableEntry.table)) continue;
            if (SKIP_INSERT_TABLES.has(tableEntry.table)) continue;
            if (resolvedBase === null || resolvedBase === undefined) continue;
            
            if (!allSyntheticChildRecordsByTable[tableEntry.table]) {
               allSyntheticChildRecordsByTable[tableEntry.table] = [];
               tableOrder.push(tableEntry.table);
            }
            
            const isVbfa = tableEntry.table === VBELV_TABLE;
            
            for (const sourceRec of tableEntry.records) {
               const rec = { ...sourceRec };
               const rootRec = syntheticRootRecords[orderIdx];
               
               // Critical fields that must be identical between Header and Child tables
               // Removed 'KUNNR' because syncing it forces all VBPA partner functions (Ship-To, Bill-To, etc.)
               // to take the Sold-To's customer ID, which breaks VA03 partner resolution.
               const SYNC_FIELDS = new Set(['WAERK', 'VKORG', 'VTWEG', 'SPART', 'KNUMV', 'BUKRS_VF', 'BUKRS', 'AUART', 'VBTYP']);
               
               // Replace the FK field(s) referencing the sales-order VBELN and sync critical fields
               for (const key of Object.keys(rec)) {
                 const upperKey = key.toUpperCase();
                 if (isVbfa) {
                   if (upperKey === 'VBELV') rec[key] = syntheticVbeln;
                   if (upperKey === 'RUUID') delete rec[key];
                 } else {
                   if (upperKey === 'VBELN') rec[key] = syntheticVbeln;
                   if (tableEntry.table === 'VBAP' && (upperKey === 'VGBEL' || upperKey === 'VGPOS')) {
                       rec[key] = ''; // Clear predecessor references so old quotations don't show up in Document Flow
                   }
                 }
                 
                 // Sync critical header values to child items so SAP GUI doesn't reject the Frankenstein document
                 if (SYNC_FIELDS.has(upperKey) && rootRec) {
                    const rootKey = Object.keys(rootRec).find(k => k.toUpperCase() === upperKey);
                    if (rootKey && rootRec[rootKey] !== undefined && rootRec[rootKey] !== null) {
                       rec[key] = rootRec[rootKey];
                    }
                 }
                 
                 // Scale item monetary amounts (NETWR, NETPR, WAVWR) to match the ML-generated Header NETWR
                 const anchor = selectedAnchors[orderIdx];
                 const anchorNetwr = anchor ? parseFloat(anchor.NETWR || anchor.netwr || 0) : 0;
                 const syntheticNetwr = rootRec ? parseFloat(rootRec.NETWR || rootRec.netwr || 0) : 0;
                 if (anchorNetwr > 0 && syntheticNetwr > 0 && anchorNetwr !== syntheticNetwr) {
                    const scaleFactor = syntheticNetwr / anchorNetwr;
                    if (['NETWR', 'NETPR', 'WAVWR'].includes(upperKey)) {
                       const val = parseFloat(rec[key] || 0);
                       rec[key] = Math.round(val * scaleFactor * 100) / 100;
                    }
                 }
               }
               
               allSyntheticChildRecordsByTable[tableEntry.table].push(rec);
            }
         }
      }
      
      // Push each aggregated child table individually
      for (const tableName of tableOrder) {
         const childRecords = allSyntheticChildRecordsByTable[tableName];
         if (!childRecords || childRecords.length === 0) continue;
         
         logger.info(`Pushing ${childRecords.length} dynamic synthetic child records for ${tableName}`, { targetSystem, table: tableName });
         
         try {
           const childPushResult = await pushTableDataWithClient(targetClient2, targetSystem, tableName, childRecords);
           allTableResults.push({
             table: tableName,
             status: childPushResult.succeeded > 0 ? 'SYNTHETIC_INSERTED' : 'FAILED',
             attempted: childPushResult.attempted,
             succeeded: childPushResult.succeeded
           });
         } catch (childErr) {
           logger.warn(`Synthetic child table push failed for ${tableName} — continuing with other tables`, { error: childErr.message });
           allTableResults.push({
             table: tableName,
             status: 'FAILED',
             attempted: childRecords.length,
             succeeded: 0,
             error: childErr.message
           });
         }
      }

      // Step 6: Clone KONV (pricing conditions) for each synthetic order.
      // KONV is keyed by KNUMV (not VBELN) and lives outside SALES_DOCUMENT sub-tables.
      // We clone the anchor's rows, restamp KNUMV, and SCALE all monetary amounts
      // by the ratio (synthetic NETWR / anchor NETWR) so the Conditions tab totals
      // always agree with the header net amount and item values.
      try {
        const konvByOrder = [];

        await Promise.all(selectedAnchors.map(async (anchor, idx) => {
          const anchorKnumv  = (anchor.KNUMV  || anchor.knumv  || '').trim();
          const syntheticRec = syntheticRootRecords[idx];
          const syntheticKnumv = syntheticRec
            ? (syntheticRec.KNUMV || syntheticRec.knumv || '').trim()
            : '';

          if (!anchorKnumv || !syntheticKnumv || anchorKnumv === syntheticKnumv) return;

          // --- Compute scale factor from NETWR ---
          // anchor NETWR: read from the anchor VBAK record
          const anchorNetwr    = parseFloat(anchor.NETWR    || anchor.netwr    || 0);
          // synthetic NETWR: already ML-generated and overlaid on the synthetic VBAK
          const syntheticNetwr = parseFloat(
            syntheticRec.NETWR || syntheticRec.netwr || 0
          );

          // Default to 1 (no scaling) if either value is missing or zero
          const scaleFactor = (anchorNetwr > 0 && syntheticNetwr > 0)
            ? syntheticNetwr / anchorNetwr
            : 1;

          logger.info(
            `KONV scale: anchor NETWR=${anchorNetwr}, synthetic NETWR=${syntheticNetwr}, ` +
            `factor=${scaleFactor.toFixed(4)} (${anchorKnumv} → ${syntheticKnumv})`
          );

          try {
            let fetchTableName = 'KONV';
            let konvRows = await fetchTableData(
              sourceSystem, fetchTableName, '__FETCH_ALL__', configKey,
              { where: `KNUMV = '${anchorKnumv}'`, rows: 500 }
            );

            if (!konvRows || konvRows.length === 0) {
              logger.info(`KONV returned 0 rows for ${anchorKnumv}. Trying PRCD_ELEMENTS...`);
              fetchTableName = 'PRCD_ELEMENTS';
              konvRows = await fetchTableData(
                sourceSystem, fetchTableName, '__FETCH_ALL__', configKey,
                { where: `KNUMV = '${anchorKnumv}'`, rows: 500 }
              );
            }

            if (konvRows && konvRows.length > 0) {
              const clonedRows = konvRows.map(row => {
                const r = { ...row };

                // 1. Restamp KNUMV to the synthetic order's condition number
                for (const k of Object.keys(r)) {
                  if (k.toUpperCase() === 'KNUMV') r[k] = syntheticKnumv;
                }

                // 2. Scale monetary amounts by the NETWR ratio
                //    KRECH (calculation type) tells us how the condition is calculated:
                //      'A' = percentage  → preserve KBETR (the %), scale KWERT only
                //      'B' = fixed amt   → scale both KBETR and KWERT
                //      'C' = quantity    → scale both KBETR and KWERT
                //      others            → scale KWERT only (safe default)
                if (scaleFactor !== 1) {
                  const krech = (r.KRECH || r.krech || '').toUpperCase();
                  const isPercentage = krech === 'A';

                  // Scale KWERT (condition value = the currency amount shown in the grid)
                  const kwertKey = Object.keys(r).find(k => k.toUpperCase() === 'KWERT');
                  if (kwertKey !== undefined && r[kwertKey] !== undefined) {
                    const scaled = parseFloat(r[kwertKey] || 0) * scaleFactor;
                    r[kwertKey] = Math.round(scaled * 100) / 100; // round to 2 dp
                  }

                  // Scale KBETR (condition rate / base amount) only for non-percentage types
                  if (!isPercentage) {
                    const kbetrKey = Object.keys(r).find(k => k.toUpperCase() === 'KBETR');
                    if (kbetrKey !== undefined && r[kbetrKey] !== undefined) {
                      const scaled = parseFloat(r[kbetrKey] || 0) * scaleFactor;
                      r[kbetrKey] = Math.round(scaled * 100) / 100;
                    }
                  }

                  // Scale KWMENG (condition quantity basis) proportionally as well
                  const kwmengKey = Object.keys(r).find(k => k.toUpperCase() === 'KWMENG');
                  if (kwmengKey !== undefined && r[kwmengKey] !== undefined) {
                    const scaled = parseFloat(r[kwmengKey] || 0) * scaleFactor;
                    r[kwmengKey] = Math.round(scaled * 1000) / 1000;
                  }
                }

                return r;
              });

              konvByOrder.push({ rows: clonedRows, syntheticKnumv, fetchTableName });
              logger.info(
                `${fetchTableName}: cloned+scaled ${clonedRows.length} condition rows ` +
                `(${anchorKnumv} → ${syntheticKnumv}, factor=${scaleFactor.toFixed(4)})`
              );
            }
          } catch (konvFetchErr) {
            logger.warn(`KONV fetch failed for anchor KNUMV ${anchorKnumv}: ${konvFetchErr.message}`);
          }
        }));

        const tablesToPush = [...new Set(konvByOrder.map(k => k.fetchTableName))];
        for (const tableName of tablesToPush) {
          const rowsToPush = konvByOrder.filter(k => k.fetchTableName === tableName).flatMap(k => k.rows);
          if (rowsToPush.length > 0) {
            logger.info(`Pushing ${rowsToPush.length} total condition rows to target table ${tableName}`);
            try {
              const konvPushResult = await pushTableDataWithClient(
                targetClient2, targetSystem, tableName, rowsToPush
              );
              allTableResults.push({
                table: tableName,
                status: konvPushResult.succeeded > 0 ? 'SYNTHETIC_INSERTED' : 'FAILED',
                attempted: konvPushResult.attempted,
                succeeded: konvPushResult.succeeded,
                failed: konvPushResult.failed
              });
            } catch (pushErr) {
              logger.warn(`Failed to push conditions to ${tableName}: ${pushErr.message}`);
            }
          }
        }
      } catch (konvErr) {
        logger.warn(`KONV cloning step failed: ${konvErr.message}`);
      }

      const totalGenerated = allTableResults.reduce((s, r) => s + (r.attempted || 0), 0);
      const totalPushed = allTableResults.reduce((s, r) => s + (r.succeeded || 0), 0);
      const tablesPopulated = allTableResults.filter(r => r.status === 'SYNTHETIC_INSERTED').length;

      const synthKeys = [];
      if (resolvedBase !== null && syntheticRootRecords && syntheticRootRecords.length > 0) {
        for (let i = 0; i < syntheticRootRecords.length; i++) {
          synthKeys.push({ field: pkField, targetValue: String(resolvedBase + i).padStart(10, '0') });
        }
      }

      // Step 7: Orchestrate Synthesizing Follow-on objects
      try {
        const followOnKeys = await synthesizeFollowOns(
          syntheticRootRecords,
          optionalFollowons || [],
          sourceClient,
          targetClient2,
          sourceSystem,
          targetSystem,
          allTableResults,
          numToGenerate
        );
        if (followOnKeys && followOnKeys.length > 0) {
           synthKeys.push(...followOnKeys);
        }
      } catch (fErr) {
        logger.error(`Follow-on generation orchestration failed: ${fErr.message}`);
      }

      recordRunHistory({
        traceId,
        status: tablesPopulated > 0 ? 'SUCCESS' : 'FAILED',
        startedAt,
        completedAt: new Date().toISOString(),
        sourceSystem,
        targetSystem,
        objectType: configKey,
        sourceObjectId: normalizedObjectId,
        objectId: normalizedObjectId,
        generatedKeys: synthKeys,
        results: allTableResults,
        synthetic: true
      });

      return {
        success: true,
        synthetic: true,
        generatedKeys: synthKeys,
        pkField,
        objectType: configKey,
        objectId: normalizedObjectId,
        sourceSystem,
        targetSystem,
        traceId,
        startedAt,
        completedAt: new Date().toISOString(),
        syntheticRowsGenerated: totalGenerated,
        syntheticRowsPushed: totalPushed,
        generatedIdRange: idRange,
        tablesPopulated,
        note: `Synthetic transfer complete. ${numToGenerate} order(s) generated in range ${idRange}. ${tablesPopulated}/${allTableResults.length} tables successfully populated (including child tables for VA03 display).`,
        results: allTableResults
      };

    } catch (err) {
      logger.error('Synthetic data transfer failed', { error: err.message });
      throw new AppError(`Synthetic data transfer failed: ${err.message}`, 500, { traceId });
    }
  }
  // ---------------------------------------------------------------------------

  const sourceTables = renumberedPayload.tables;
  const effectiveContext = renumberedPayload.context;
  const generatedKeys = [
    ...rootGeneratedKey,
    ...renumberedPayload.generatedKeys
  ];
  let preflight;

  try {
    preflight = await runTransferPreflight({
      targetClient,
      targetSystem,
      objectType: configKey,
      objectId: effectiveObjectId,
      sourceObjectId: normalizedObjectId,
      definition,
      context: effectiveContext,
      sourceTables,
      generatedKeys,
      traceId
    });
  } catch (error) {
    if (error instanceof AppError) {
      recordRunHistory({
        traceId,
        status: 'FAILED',
        startedAt,
        completedAt: new Date().toISOString(),
        sourceSystem,
        targetSystem,
        objectType: configKey,
        sourceObjectId: normalizedObjectId,
        objectId: effectiveObjectId,
        generatedKeys,
        error: error.message,
        preflight: error.details?.preflight,
        cleanupGuidance: error.details?.cleanupGuidance,
        results: []
      });
    }

    throw error;
  }

  const tableByName = new Map(sourceTables.map((entry) => [entry.table, entry]));
  const results = [];

  for (const tableName of getTableSequence(definition, 'writeSequence')) {
    const sourceEntry = tableByName.get(tableName) || { table: tableName, records: [] };

    if (sourceEntry.records.length === 0) {
      logger.info('Skipping SAP table transfer because source has no rows', {
        traceId,
        sourceSystem,
        targetSystem,
        objectType: configKey,
        objectId: effectiveObjectId,
        sourceObjectId: normalizedObjectId,
        table: tableName
      });

      results.push({
        table: tableName,
        status: sourceEntry.status || 'SKIPPED',
        reason: sourceEntry.reason || 'No source rows found',
        attempted: 0,
        succeeded: 0,
        sourceSystem: sourceEntry.system,
        error: sourceEntry.error,
        sapError: sourceEntry.sapError
      });
      continue;
    }

    const insertDiagnostics = buildInsertBodyDiagnostics(tableName, sourceEntry.records);

    // Apply phone masking to real data if the user opted in
    const recordsToWrite = maskPhoneNumbers
      ? maskPhoneFields(sourceEntry.records)
      : sourceEntry.records;

    try {
      const pushResult = await pushTableDataWithClient(
        targetClient,
        targetSystem,
        tableName,
        recordsToWrite
      );
      const verification = await verifyTargetTable(
        targetClient,
        targetSystem,
        tableName,
        configKey,
        effectiveObjectId,
        effectiveContext,
        insertDiagnostics.sampleRow
      );

      logger.info('SAP table transfer succeeded', {
        traceId,
        sourceSystem,
        targetSystem,
        objectType: configKey,
        objectId: effectiveObjectId,
        sourceObjectId: normalizedObjectId,
        table: tableName,
        attempted: pushResult.attempted,
        succeeded: pushResult.succeeded,
        requestPayloadField: pushResult.requestPayloadField,
        insertBatchSize: pushResult.insertBatchSize,
        targetFetchedRecordCount: verification.targetFetchedRecordCount,
        verificationError: verification.error
      });

      results.push({
        table: tableName,
        status: 'SUCCESS',
        attempted: pushResult.attempted,
        succeeded: pushResult.succeeded,
        requestPayloadField: pushResult.requestPayloadField,
        insertBatchSize: pushResult.insertBatchSize,
        rollbackRows: sourceEntry.records.map(normalizeRecordForRollback),
        diagnostics: {
          sourceFetchedRecordCount: sourceEntry.records.length,
          sourceFieldCount: Object.keys(normalizeRecordForComparison(sourceEntry.records[0] || {})).length,
          insertFieldCount: insertDiagnostics.sampleFields.length,
          insertFields: insertDiagnostics.sampleFields,
          insertSampleRow: insertDiagnostics.sampleRow,
          verification
        }
      });
    } catch (error) {
      if (isInactiveTransparentTableError(error)) {
        logger.warn('Skipping SAP table write because target table is inactive or unavailable', {
          traceId,
          sourceSystem,
          targetSystem,
          objectType: configKey,
          objectId: effectiveObjectId,
          sourceObjectId: normalizedObjectId,
          table: tableName,
          attempted: sourceEntry.records.length,
          error: error.message,
          sapError: error.details?.sapError
        });

        results.push({
          table: tableName,
          status: 'SKIPPED',
          reason: 'Target table is not active or does not exist in SAP',
          attempted: sourceEntry.records.length,
          succeeded: error.details?.succeeded || 0,
          error: error.message,
          details: error.details,
          rawResponse: error.response?.data
        });
        continue;
      }

      const failureResult = {
        table: tableName,
        status: 'FAILED',
        attempted: sourceEntry.records.length,
        succeeded: error.details?.succeeded || 0,
        error: error.message,
        details: error.details,
        rawResponse: error.response?.data
      };
      const failureResults = [...results, failureResult];
      const cleanupGuidance = buildCleanupGuidance({
        objectType: configKey,
        sourceObjectId: normalizedObjectId,
        objectId: effectiveObjectId,
        generatedKeys,
        results: failureResults,
        failedTable: tableName
      });

      recordRunHistory({
        traceId,
        status: 'FAILED',
        startedAt,
        completedAt: new Date().toISOString(),
        sourceSystem,
        targetSystem,
        objectType: configKey,
        sourceObjectId: normalizedObjectId,
        objectId: effectiveObjectId,
        generatedKeys,
        error: error.message,
        preflight,
        cleanupGuidance,
        results: failureResults
      });

      throw new AppError(
        `Transfer failed while writing ${tableName} to ${targetSystem}`,
        error.response?.status || error.statusCode || 502,
        {
          objectType: configKey,
          objectId: effectiveObjectId,
          sourceObjectId: normalizedObjectId,
          sourceSystem,
          targetSystem,
          traceId,
          preflight,
          generatedKeys,
          cleanupGuidance,
          results: failureResults
        }
      );
    }
  }

  const response = {
    success: true,
    traceId,
    objectType: configKey,
    objectKey: definition.objectKey,
    objectDescription: definition.description,
    objectId: effectiveObjectId,
    sourceObjectId: normalizedObjectId,
    renumbered: targetResolution.renumbered,
    sourceSystem,
    targetSystem,
    targetExistenceCheck: targetResolution.targetExistenceCheck,
    preflight,
    generatedKeys,
    results
  };

  recordRunHistory({
    traceId,
    status: 'SUCCESS',
    startedAt,
    completedAt: new Date().toISOString(),
    sourceSystem,
    targetSystem,
    objectType: configKey,
    sourceObjectId: normalizedObjectId,
    objectId: effectiveObjectId,
    generatedKeys,
    preflight,
    results
  });

  return response;
}

function getRollbackTableNames(run) {
  const cleanupTables = run?.cleanupGuidance?.insertedTables;

  if (Array.isArray(cleanupTables) && cleanupTables.length > 0) {
    return cleanupTables.map((entry) => entry.table).filter(Boolean).reverse();
  }

  return (run?.results || [])
    .filter((entry) => entry.status === 'SUCCESS' && entry.succeeded > 0)
    .map((entry) => entry.table)
    .filter(Boolean)
    .reverse();
}

function buildRollbackContext(run) {
  return (run?.generatedKeys || []).reduce((context, key) => {
    if (key?.field && key?.targetValue) {
      context[key.field] = key.targetValue;
    }

    return context;
  }, { OBJECT_ID: run?.objectId });
}

async function getRollbackRows({ targetClient, run, definition, tableName }) {
  const resultEntry = (run.results || []).find((entry) => entry.table === tableName);

  if (Array.isArray(resultEntry?.rollbackRows) && resultEntry.rollbackRows.length > 0) {
    return resultEntry.rollbackRows;
  }

  return fetchTableDataWithClient(
    targetClient,
    run.targetSystem,
    tableName,
    run.objectId,
    run.objectType,
    buildRollbackContext(run)
  );
}

async function rollbackRun(traceId) {
  const run = getRunHistory(traceId);

  if (!run) {
    throw new AppError(`Run ${traceId} was not found`, 404, { traceId });
  }

  if (run.rollback?.status === 'SUCCESS') {
    return {
      success: true,
      traceId,
      status: 'ALREADY_ROLLED_BACK',
      rollback: run.rollback,
      run
    };
  }

  const cleanupStatus = run.cleanupGuidance?.status;

  if (cleanupStatus !== 'PARTIAL_WRITE') {
    throw new AppError(
      `Run ${traceId} does not have partial target writes to roll back`,
      409,
      {
        traceId,
        status: run.status,
        cleanupStatus
      }
    );
  }

  const resolved = resolveObjectDefinition(run.objectType);

  if (!resolved?.definition) {
    throw new AppError(`Object type ${run.objectType} is not configured`, 500, {
      traceId,
      objectType: run.objectType
    });
  }

  const tableNames = getRollbackTableNames(run);
  const targetClient = await getSystemClient(run.targetSystem);
  await warmCsrfToken(targetClient);

  const rollbackResults = [];

  for (const tableName of tableNames) {
    const rows = await getRollbackRows({
      targetClient,
      run,
      definition: resolved.definition,
      tableName
    });

    if (!Array.isArray(rows) || rows.length === 0) {
      rollbackResults.push({
        table: tableName,
        status: 'SKIPPED',
        reason: 'No rollback rows found',
        attempted: 0,
        deleted: 0
      });
      continue;
    }

    try {
      const deleteResult = await deleteTableDataWithClient(
        targetClient,
        run.targetSystem,
        tableName,
        rows
      );

      rollbackResults.push({
        table: tableName,
        status: 'SUCCESS',
        attempted: deleteResult.attempted,
        deleted: deleteResult.deleted,
        requestPayloadField: deleteResult.requestPayloadField
      });
    } catch (error) {
      const rollback = {
        status: 'FAILED',
        attemptedAt: new Date().toISOString(),
        failedTable: tableName,
        error: error.message,
        results: rollbackResults
      };

      updateRunHistory(traceId, (entry) => ({
        ...entry,
        rollback
      }));

      throw new AppError(
        `Rollback failed while deleting ${tableName} from ${run.targetSystem}`,
        error.statusCode || 502,
        {
          traceId,
          objectType: run.objectType,
          objectId: run.objectId,
          targetSystem: run.targetSystem,
          rollback,
          sapError: error.details?.sapError,
          details: error.details
        }
      );
    }
  }

  const rollback = {
    status: 'SUCCESS',
    completedAt: new Date().toISOString(),
    objectType: run.objectType,
    objectId: run.objectId,
    targetSystem: run.targetSystem,
    results: rollbackResults
  };
  const updatedRun = updateRunHistory(traceId, (entry) => ({
    ...entry,
    status: 'ROLLED_BACK',
    rollback
  }));

  logger.info('Rollback completed', {
    traceId,
    objectType: run.objectType,
    objectId: run.objectId,
    targetSystem: run.targetSystem,
    deletedTables: rollbackResults.filter((entry) => entry.status === 'SUCCESS').length
  });

  return {
    success: true,
    traceId,
    rollback,
    run: updatedRun
  };
}


/**
 * Generates synthetic data based on the real source rows for the given object
 * and returns it as a CSV string ready for download — no target system required.
 */
async function generateSyntheticCsv(params) {
  const { sourceSystem, objectKey, objectType, objectId, generateCount = 100, maskPhoneNumbers = true, optionalFollowons = [] } = params;
  const requestedObject = objectKey || objectType;
  const normalizedObjectId = normalizeObjectId(requestedObject, objectId);
  const { configKey, definition } = resolveObjectDefinition(requestedObject);

  // Fetch real reference rows from source (QS3)
  const sourceClient = await getSystemClient(sourceSystem);
  await warmCsrfToken(sourceClient);
  const { tables: fetchedSourceTables } = await fetchConfiguredTables(
    sourceClient,
    sourceSystem,
    configKey,
    normalizedObjectId,
    definition
  );

  const referenceRecords = fetchedSourceTables.length > 0 ? fetchedSourceTables[0].records : [];
  const primaryTable = fetchedSourceTables.length > 0 ? fetchedSourceTables[0].table : configKey;

  if (referenceRecords.length === 0) {
    throw new AppError(`No reference records found for ${definition.description} ${normalizedObjectId} in ${sourceSystem}.`, 404);
  }

  logger.info(`Generating ${generateCount} synthetic records for download`, { primaryTable, referenceCount: referenceRecords.length });

  // Call Python ML API with a dummy base offset for CSV output
  const dummyBaseOffset = 9900000000;
  const { records: syntheticRootRecords, actualBaseOffset } = await syntheticDataClient.requestSyntheticData(
    primaryTable, 
    referenceRecords, 
    generateCount,
    dummyBaseOffset,
    maskPhoneNumbers,
    optionalFollowons
  );

  if (!syntheticRootRecords || syntheticRootRecords.length === 0) {
    throw new AppError('Synthetic data generation returned no records.', 500);
  }

  const resolvedBase = actualBaseOffset ?? dummyBaseOffset;
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();

  // Helper to format a table block to CSV
  const buildCsvBlock = (tableName, rows) => {
    if (!rows || rows.length === 0) return '';
    const headers = Object.keys(rows[0]).filter(k => k !== '__metadata');
    const lines = [
      headers.join(','),
      ...rows.map(record =>
        headers.map(h => {
          const val = record[h] == null ? '' : String(record[h]);
          return val.includes(',') || val.includes('"') || val.includes('\n')
            ? `"${val.replace(/"/g, '""')}"`
            : val;
        }).join(',')
      )
    ];
    return lines.join('\n');
  };

  // Add the primary table (VBAK)
  const rootCsv = buildCsvBlock(primaryTable, syntheticRootRecords);
  if (rootCsv) zip.addFile(`${primaryTable}.csv`, Buffer.from(rootCsv, 'utf8'));

  // Add all the child tables (Type B & C) cloned for each synthetic order
  const VBELV_TABLE = 'VBFA';
  const childTables = fetchedSourceTables.slice(1);
  
  for (const tableEntry of childTables) {
    if (!tableEntry.records || tableEntry.records.length === 0) continue;
    if (tableEntry.status === 'SKIPPED') continue;
    
    const isVbfa = tableEntry.table === VBELV_TABLE;
    const childRecords = [];
    
    for (let orderIdx = 0; orderIdx < generateCount; orderIdx++) {
      const syntheticVbeln = String(resolvedBase + orderIdx).padStart(10, '0');
      
      for (const sourceRec of tableEntry.records) {
        const rec = { ...sourceRec };
        for (const key of Object.keys(rec)) {
          const upperKey = key.toUpperCase();
          if (isVbfa) {
            if (upperKey === 'VBELV') rec[key] = syntheticVbeln;
            if (upperKey === 'RUUID') delete rec[key];
          } else {
            if (upperKey === 'VBELN') rec[key] = syntheticVbeln;
          }
        }
        childRecords.push(rec);
      }
    }
    
    if (childRecords.length > 0) {
      const childCsv = buildCsvBlock(tableEntry.table, childRecords);
      if (childCsv) zip.addFile(`${tableEntry.table}.csv`, Buffer.from(childCsv, 'utf8'));
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `synthetic_${primaryTable}_${normalizedObjectId}_${timestamp}.zip`;

  return { zipBuffer: zip.toBuffer(), filename };
}

/**
 * Orchestrates the synthesis of follow-on documents (e.g. Delivery, Billing) based on the target keys
 * selected in the UI. For full generation, this queries the follow-on object's root table for a
 * template, clones its full configured table tree, stamps new IDs, and writes a VBFA document flow
 * link from the synthetic Sales Order to the new follow-on document.
 *
 * Key design decisions:
 *  - followOnVbeln is deterministically derived from the synthetic SO VBELN + follow-on type so
 *    it is guaranteed unique and can never collide with real SAP documents.
 *  - VBFA.VBTYP_N is read from the VBTYP_N_BY_OBJECT map in followonConfig, not guessed from the
 *    template record's VBTYP field which carries the wrong meaning.
 *  - POSNV / POSNN are '000000' for header-level document flow links (SAP standard).
 *  - VBFA cloning from template tables is skipped; only the explicit clean link is written.
 */
async function synthesizeFollowOns(syntheticRootRecords, optionalFollowOnKeys, sourceClient, targetClient, sourceSystem, targetSystem, allTableResults, numToGenerate) {
  const { FOLLOWON_RULES, VBTYP_N_BY_OBJECT } = require('../config/followonConfig');
  const generatedFollowOnKeys = [];

  // Extract mandatory keys from the rules and combine with the selected optional keys
  const mandatoryKeys = FOLLOWON_RULES.filter(r => r.mandatory).map(r => r.targetObjectKey);
  
  // Combine, parse as ints, and deduplicate
  const allFollowOnKeys = [...new Set([...mandatoryKeys, ...optionalFollowOnKeys.map(k => parseInt(k, 10))])];

  for (const followOnKey of allFollowOnKeys) {
    const rule = FOLLOWON_RULES.find(r => r.targetObjectKey === followOnKey);
    if (!rule) continue;

    try {
      const { configKey, definition } = resolveObjectDefinition(followOnKey);
      if (!definition || !definition.tables || definition.tables.length === 0) continue;

      const isMandatory = rule.mandatory ? '(MANDATORY)' : '(OPTIONAL)';
      logger.info(`Generating full synthetic tree for follow-on: ${configKey} ${isMandatory}`, { targetSystem });

      // 1. Determine the root table and its primary key field
      const rootTableName = definition.rootTable || (definition.tables && definition.tables[0] && definition.tables[0].tableName);
      
      let rootPkField = definition.keyField;
      const followOnKeyStr = String(followOnKey).trim();
      const metaKey = followOnKeyStr.startsWith('OBJECT_') ? followOnKeyStr.replace('OBJECT_', '') : followOnKeyStr;
      
      if ((!rootPkField || rootPkField === 'OBJECT_ID') && objectKeyFieldMetadata[metaKey]) {
         const meta = objectKeyFieldMetadata[metaKey];
         if (meta.keyFieldsByTable && meta.keyFieldsByTable[rootTableName] && meta.keyFieldsByTable[rootTableName].length > 0) {
            rootPkField = meta.keyFieldsByTable[rootTableName][0];
         }
      }
      
      if (!rootPkField || rootPkField === 'OBJECT_ID') rootPkField = 'VBELN';

      // 2. Fetch a single template document from the source system
      const randomDocs = await fetchTableDataWithClient(
         sourceClient, sourceSystem, rootTableName, '__FETCH_ALL__', configKey, { rows: 1 }
      );
      
      if (!randomDocs || randomDocs.length === 0) {
         logger.warn(`No reference docs found for follow-on ${configKey} in ${rootTableName} - Skipping generation`);
         continue;
      }
      
      const referenceId = randomDocs[0][rootPkField] || randomDocs[0][rootPkField.toLowerCase()];
      if (!referenceId) {
         logger.warn(`Failed to extract referenceId for ${configKey} using key field ${rootPkField} from ${rootTableName}`);
         continue;
      }

      logger.info(`Using template ${configKey} referenceId=${referenceId} (keyField=${rootPkField})`);

      // Determine the correct VBTYP_N for VBFA from the config map
      const vbtypN = VBTYP_N_BY_OBJECT[followOnKey] || rule.vbtypN || 'J';

      // 3. For each synthetic Sales Order, clone the header, overwrite keys, push to SAP
      for (let orderIdx = 0; orderIdx < numToGenerate; orderIdx++) {
         const rootSalesOrder = syntheticRootRecords[orderIdx];
         if (!rootSalesOrder) continue;
         
         const salesOrderVbeln = rootSalesOrder.VBELN || rootSalesOrder.vbeln || Object.values(rootSalesOrder)[0];
         if (!salesOrderVbeln) {
            logger.warn(`Cannot determine VBELN for synthetic root record at index ${orderIdx} — skipping follow-on`);
            continue;
         }
         
         // Derive a deterministic follow-on VBELN that:
         //   (a) is guaranteed unique per SO + follow-on type + iteration
         //   (b) uses a TDE-specific prefix (99 + 8 digits) that does not collide
         //       with real SAP document ranges (which use numbers like 80xx, 88xx etc.)
         const soSuffix   = String(salesOrderVbeln).replace(/\D/g, '').slice(-6).padStart(6, '0');
         const typeSuffix = String(followOnKey % 100).padStart(2, '0');
         const idxSuffix  = String(orderIdx % 100).padStart(2, '0');
         const followOnVbeln = ('99' + soSuffix + typeSuffix + idxSuffix).slice(0, 10);
         
         generatedFollowOnKeys.push({ field: rule.description || 'Follow-on', targetValue: followOnVbeln });

         logger.info(`Synthesizing follow-on ${configKey}: salesOrder=${salesOrderVbeln} → followOn=${followOnVbeln}`);

         // Clone ONLY the root header table from our randomDocs fetch.
         // We bypass `fetchConfiguredTables` entirely because we don't need sub-tables
         // (they cause duplicate POSNR crashes) and `fetchConfiguredTables` struggles
         // with broken OBJECT_ID field mappings for some SAP SD objects.
         const clonedTables = [];
         const records = [];
         
         for (const r of randomDocs) {
            const clonedRow = { ...r };
            
            // Stamp the new follow-on document number onto all key fields
            for (const key of Object.keys(clonedRow)) {
               const upperKey = key.toUpperCase();
               if (upperKey === rootPkField.toUpperCase() || upperKey === 'VBELN') {
                  clonedRow[key] = followOnVbeln;
               }
            }
            
            // Stamp predecessor references back to the synthetic Sales Order
            if ('VGBEL' in clonedRow) clonedRow.VGBEL = salesOrderVbeln;
            if ('vgbel' in clonedRow) clonedRow.vgbel = salesOrderVbeln;
            if ('VGPOS' in clonedRow) clonedRow.VGPOS = '000000';
            if ('vgpos' in clonedRow) clonedRow.vgpos = '000000';
            if ('VBELV' in clonedRow) clonedRow.VBELV = salesOrderVbeln;
            if ('vbelv' in clonedRow) clonedRow.vbelv = salesOrderVbeln;

            records.push(clonedRow);
         }
         
         if (records.length > 0) {
            clonedTables.push({ table: rootTableName, records });
         }

         
         // Push the cloned follow-on tables to SAP
         for (const ct of clonedTables) {
            try {
               const pushResult = await pushTableDataWithClient(targetClient, targetSystem, ct.table, ct.records);
               allTableResults.push({
                  table: `${ct.table} [${configKey}]`,
                  status: pushResult.succeeded > 0 ? 'SYNTHETIC_INSERTED' : 'FAILED',
                  attempted: pushResult.attempted,
                  succeeded: pushResult.succeeded
               });
            } catch (tableErr) {
               logger.warn(`Failed to push follow-on table ${ct.table} for ${configKey}: ${tableErr.message}`);
               allTableResults.push({
                  table: `${ct.table} [${configKey}]`,
                  status: 'FAILED',
                  attempted: ct.records.length,
                  succeeded: 0,
                  error: tableErr.message
               });
            }
         }
         
         // Write the VBFA document flow link: synthetic SO → new follow-on document
         // Primary key: VBELV + POSNV + VBELN + POSNN (header-level = 000000)
         // Note: We MUST supply a unique RUUID, otherwise SAP defaults it to "" and throws 
         // a duplicate secondary key error on subsequent inserts.
         // We only insert the header link (000000) because inserting an item link (000010)
         // causes SAP GUI to crash looking for follow-on item records (LIPS/VBRP) that we don't clone.
         const vbfaRecord = {
            RUUID:    require('crypto').randomBytes(16).toString('base64'),
            VBELV:    salesOrderVbeln,   // predecessor = the synthetic Sales Order
            POSNV:    '000000',           // header-level link
            VBELN:    followOnVbeln,      // successor  = the new follow-on document
            POSNN:    '000000',           // header-level link
            VBTYP_V:  'C',                // Sales Order document category
            VBTYP_N:  vbtypN             // Follow-on document category (from config map)
         };

         try {
            const vbfaResult = await pushTableDataWithClient(targetClient, targetSystem, 'VBFA', [vbfaRecord]);
            if (vbfaResult.succeeded > 0) {
               logger.info(`VBFA link inserted: ${salesOrderVbeln} (C) → ${followOnVbeln} (${vbtypN}) [${configKey}]`);
               allTableResults.push({
                  table: `VBFA [${configKey}]`,
                  status: 'SYNTHETIC_INSERTED',
                  attempted: 1,
                  succeeded: 1
               });
            } else {
               logger.warn(`VBFA insert returned 0 succeeded for ${salesOrderVbeln} → ${followOnVbeln}`);
               allTableResults.push({ table: `VBFA [${configKey}]`, status: 'FAILED', attempted: 1, succeeded: 0 });
            }
         } catch (vbfaErr) {
            // Log but do not crash — a duplicate VBFA key (e.g. re-run) is non-fatal
            const isDuplicate = vbfaErr.message && vbfaErr.message.includes('same primary key');
            if (isDuplicate) {
               logger.warn(`VBFA link already exists for ${salesOrderVbeln} → ${followOnVbeln} — skipping duplicate`);
            } else {
               logger.warn(`VBFA insert failed for ${salesOrderVbeln} → ${followOnVbeln}: ${vbfaErr.message}`);
            }
            allTableResults.push({
               table: `VBFA [${configKey}]`,
               status: isDuplicate ? 'SKIPPED_DUPLICATE' : 'FAILED',
               attempted: 1,
               succeeded: 0,
               error: vbfaErr.message
            });
         }
      }

    } catch (err) {
      logger.warn(`Error generating follow-on ${followOnKey}: ${err.message}`);
    }
  }

  return generatedFollowOnKeys;
}

module.exports = {
  previewTransfer,
  executeTransfer,
  rollbackRun,
  listRunHistory,
  generateSyntheticCsv
};

