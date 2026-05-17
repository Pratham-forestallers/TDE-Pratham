const objectConfig = require('../config/objectConfig');
const crypto = require('crypto');
const { resolveDestination } = require('./destinationService');
const {
  getSystemClient,
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
    generateCount = 100
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
            // SAP OData doesn't support true random; we skip by a random offset
            const totalApprox = 10000; // reasonable upper bound
            const maxSkip = Math.max(0, totalApprox - sampleCount);
            const randomSkip = Math.floor(Math.random() * maxSkip);
            url = `/${primaryTable}?$skip=${randomSkip}&$top=${sampleCount}&$format=json`;
          } else {
            // top N
            url = `/${primaryTable}?$top=${sampleCount}&$format=json`;
          }
          const refResponse = await rawClient.get(url);
          const fetched = refResponse.data?.d?.results || refResponse.data?.value || [];
          if (fetched.length > 0) {
            referenceRecords = fetched;
            logger.info(`Re-fetched ${fetched.length} reference rows (mode=${sampleMode})`, { primaryTable, url });
          }
        } catch (err) {
          logger.warn(`Could not re-fetch reference rows (${err.message}), using already-fetched rows`);
        }
      }
      // Step 2: Fetch the current MAX ID from the target system for "MAX+1" logic.
      let maxId = 0;
      let pkField = 'VBELN'; // Default for Sales Orders

      try {
        // Find PK field (skip system fields like MANDT/CLIENT)
        const systemFields = ['MANDT', 'mandt', 'CLIENT', 'client'];
        if (configKey === 'SALES_DOCUMENT') {
          pkField = 'VBELN';
        } else if (referenceRecords.length > 0) {
          const fields = Object.keys(referenceRecords[0]);
          pkField = fields.find(f => !systemFields.includes(f)) || fields[0];
        }

        // Use standard SAP OData service path for reliable counting if known
        let servicePathForMax = `/${primaryTable}`;
        if (configKey === 'SALES_DOCUMENT') {
          servicePathForMax = `/sap/opu/odata/sap/API_SALES_ORDER_SRV/A_SalesOrder`;
        }

        const rawTargetClient = await getRawClient(targetSystem);
        const maxResponse = await rawTargetClient.get(`${servicePathForMax}?$top=1&$select=${pkField}&$orderby=${pkField} desc&$format=json`);
        
        const maxRecords = maxResponse.data?.d?.results || maxResponse.data?.value || [];
        if (maxRecords.length > 0) {
          const rawMax = maxRecords[0][pkField];
          // Try to parse as int, ignoring leading zeros
          maxId = parseInt(rawMax, 10) || 0;
          logger.info(`Found current MAX ${pkField} in ${targetSystem}: ${maxId}`);
        }
      } catch (err) {
        logger.warn(`Could not fetch MAX ID for ${primaryTable}, falling back to high-range: ${err.message}`);
      }

      // Step 3: Generate brand-new synthetic records with unique PKs via Python ML API.
      const numToGenerate = generateCount; // use the user-specified count
      const baseOffset = maxId > 0 ? maxId + 1 : null;
      const { records: syntheticRecords, actualBaseOffset } = await syntheticDataClient.requestSyntheticData(
        primaryTable,
        referenceRecords,
        numToGenerate,
        baseOffset,
        maskPhoneNumbers  // pass user preference to Python ML engine
      );

      if (syntheticRecords && syntheticRecords.length > 0) {
        logger.info(`Pushing ${syntheticRecords.length} NEW synthetic records to target`, { targetSystem, table: primaryTable });

        // Step 3: Push the synthetic records to the target system as NEW additional records.
        // These are NOT replacements — the original records in QS3 remain untouched.
        const targetClient2 = await getSystemClient(targetSystem);
        await warmCsrfToken(targetClient2);
        const pushResult = await pushTableDataWithClient(targetClient2, targetSystem, primaryTable, syntheticRecords);

        const resolvedBase = actualBaseOffset || baseOffset;
        const idRange = (resolvedBase !== null && resolvedBase !== undefined)
          ? `${resolvedBase} to ${resolvedBase + syntheticRecords.length - 1}`
          : 'N/A';
        logger.info(`Generated ID range: ${idRange} (pkField=${pkField}, actualBaseOffset=${actualBaseOffset})`);

        const syntheticResult = {
          success: true,
          synthetic: true,
          pkField,
          objectType: configKey,
          objectId: normalizedObjectId,
          sourceSystem,
          targetSystem,
          traceId,
          startedAt,
          completedAt: new Date().toISOString(),
          syntheticRowsGenerated: syntheticRecords.length,
          syntheticRowsPushed: pushResult.succeeded,
          generatedIdRange: idRange,
          note: `${syntheticRecords.length} new synthetic ${primaryTable} records were transferred to ${targetSystem} (Range: ${idRange}). Original data in ${sourceSystem} is untouched.`,
          results: [{
            table: primaryTable,
            status: pushResult.succeeded > 0 ? 'SYNTHETIC_INSERTED' : 'FAILED',
            attempted: pushResult.attempted,
            succeeded: pushResult.succeeded,
          }]
        };

        // Record to run history so the sidebar panel shows this run
        recordRunHistory({
          traceId,
          status: pushResult.succeeded > 0 ? 'SUCCESS' : 'FAILED',
          startedAt,
          completedAt: syntheticResult.completedAt,
          sourceSystem,
          targetSystem,
          objectType: configKey,
          sourceObjectId: normalizedObjectId,
          objectId: normalizedObjectId,
          synthetic: true,
          generatedIdRange: idRange,
          pkField,
          generatedKeys: [],
          results: syntheticResult.results
        });

        return syntheticResult;
      }
    } catch (err) {
      logger.error('Synthetic data transfer failed', { error: err.message });
      recordRunHistory({
        traceId,
        status: 'FAILED',
        startedAt,
        completedAt: new Date().toISOString(),
        sourceSystem,
        targetSystem,
        objectType: configKey,
        sourceObjectId: normalizedObjectId,
        objectId: normalizedObjectId,
        synthetic: true,
        error: err.message,
        generatedKeys: [],
        results: []
      });
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
async function generateSyntheticCsv({ sourceSystem, objectKey, objectType, objectId, numRecords = 100 }) {
  const requestedObject = objectKey || objectType;
  const normalizedObjectId = normalizeObjectId(requestedObject, objectId);
  const { configKey, definition } = resolveObjectDefinition(requestedObject);

  // Fetch real reference rows from source (QS3)
  const sourceClient = await getSystemClient(sourceSystem);
  await warmCsrfToken(sourceClient);
  const { tables } = await fetchConfiguredTables(
    sourceClient,
    sourceSystem,
    configKey,
    normalizedObjectId,
    definition
  );

  const referenceRecords = tables.length > 0 ? tables[0].records : [];
  const primaryTable = tables.length > 0 ? tables[0].table : configKey;

  if (referenceRecords.length === 0) {
    throw new AppError(`No reference records found for ${definition.description} ${normalizedObjectId} in ${sourceSystem}.`, 404);
  }

  logger.info(`Generating ${numRecords} synthetic records for download`, { primaryTable, referenceCount: referenceRecords.length });

  // Call Python ML API
  const syntheticRecords = await syntheticDataClient.requestSyntheticData(primaryTable, referenceRecords, numRecords);

  if (!syntheticRecords || syntheticRecords.length === 0) {
    throw new AppError('Synthetic data generation returned no records.', 500);
  }

  // Convert to CSV
  const headers = Object.keys(syntheticRecords[0]).filter(k => k !== '__metadata');
  const csvRows = [
    headers.join(','),
    ...syntheticRecords.map(record =>
      headers.map(h => {
        const val = record[h] == null ? '' : String(record[h]);
        // Wrap in quotes if it contains commas, quotes, or newlines
        return val.includes(',') || val.includes('"') || val.includes('\n')
          ? `"${val.replace(/"/g, '""')}"`
          : val;
      }).join(',')
    )
  ];

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `synthetic_${primaryTable}_${normalizedObjectId}_${timestamp}.csv`;

  return { csvContent: csvRows.join('\n'), filename };
}

module.exports = {
  previewTransfer,
  executeTransfer,
  rollbackRun,
  listRunHistory,
  generateSyntheticCsv
};
