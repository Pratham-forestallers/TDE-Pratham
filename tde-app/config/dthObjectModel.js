'use strict';

const fs = require('fs');
const path = require('path');
const objectConfig = require('./objectConfig');
const { parseHtmlTable } = require('../utils/htmlTableParser');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const EXPORT_PATHS = {
  objectHeader: path.join(PROJECT_ROOT, 'DTHT_MOBJ Basic object details.HTML'),
  assignedTables: path.join(PROJECT_ROOT, 'DTHTM_OBJ_S Object table level details.HTML'),
  keyFields: path.join(PROJECT_ROOT, 'DTHT_M_OBJ_I Key fields.HTML'),
  attributes: path.join(PROJECT_ROOT, 'DTHT_M_OBJ_A Number range details.HTML')
};

const TABLE_ROLE_BY_TYPE = {
  A: 'MAIN',
  B: 'SUB',
  C: 'INDEPENDENT'
};

function toNumber(value) {
  const normalized = String(value || '').trim();

  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function getCompoundKey(projectKey, objectKey) {
  return `${projectKey}:${objectKey}`;
}

function readRows(exportPath) {
  if (!fs.existsSync(exportPath)) {
    return [];
  }

  return parseHtmlTable(exportPath);
}

function sortNullableNumbers(left, right) {
  const leftValue = left ?? Number.MAX_SAFE_INTEGER;
  const rightValue = right ?? Number.MAX_SAFE_INTEGER;

  return leftValue - rightValue;
}

function sortTables(left, right) {
  return sortNullableNumbers(left.order, right.order) ||
    sortNullableNumbers(left.linkKey, right.linkKey) ||
    left.tabname.localeCompare(right.tabname);
}

function sortKeyFields(left, right) {
  return sortNullableNumbers(left.fieldPosition, right.fieldPosition) ||
    left.fieldName.localeCompare(right.fieldName);
}

function getRuntimeDefinitionByObjectKey(objectKey) {
  return Object.values(objectConfig).find((definition) => definition.objectKey === objectKey);
}

function normalizeHeaderRow(cells) {
  const projectKey = toNumber(cells[0]);
  const objectKey = toNumber(cells[1]);

  if (projectKey === null || objectKey === null) {
    return null;
  }

  return {
    modelKey: projectKey,
    objectKey,
    objectName: cells[2] || null,
    mainObjectKey: toNumber(cells[3]),
    status: cells[4] || null,
    implementationStatus: cells[5] || null,
    inheritFromMainObject: cells[6] === 'X' || cells[7] === 'X',
    textObjectKey: toNumber(cells[8]),
    copyFrom: cells[9] || null
  };
}

function normalizeAssignedTableRow(cells) {
  const projectKey = toNumber(cells[0]);
  const objectKey = toNumber(cells[1]);
  const tabname = cells[2];

  if (projectKey === null || objectKey === null || !tabname) {
    return null;
  }

  return {
    modelKey: projectKey,
    objectKey,
    tabname,
    tableType: cells[3] || null,
    tableRole: TABLE_ROLE_BY_TYPE[cells[3]] || 'UNKNOWN',
    linkKey: toNumber(cells[4]),
    segment: cells[5] || null,
    order: toNumber(cells[6]),
    keyFields: []
  };
}

function normalizeKeyFieldRow(cells) {
  const projectKey = toNumber(cells[0]);
  const objectKey = toNumber(cells[1]);
  const tabname = cells[2];
  const fieldName = cells[3];

  if (projectKey === null || objectKey === null || !tabname || !fieldName) {
    return null;
  }

  return {
    modelKey: projectKey,
    objectKey,
    tabname,
    fieldName,
    fieldPosition: toNumber(cells[4])
  };
}

function normalizeAttributeRow(cells) {
  const projectKey = toNumber(cells[0]);
  const objectKey = toNumber(cells[1]);
  const attributeName = cells[2];

  if (projectKey === null || objectKey === null || !attributeName) {
    return null;
  }

  return {
    modelKey: projectKey,
    objectKey,
    attributeName,
    lineNumber: toNumber(cells[3]),
    value: cells[4] || ''
  };
}

function groupByCompoundKey(rows) {
  return rows.reduce((groups, row) => {
    const compoundKey = getCompoundKey(row.modelKey, row.objectKey);

    if (!groups.has(compoundKey)) {
      groups.set(compoundKey, []);
    }

    groups.get(compoundKey).push(row);
    return groups;
  }, new Map());
}

function groupKeyFieldsByObjectAndTable(keyFields) {
  return keyFields.reduce((groups, field) => {
    const compoundKey = `${getCompoundKey(field.modelKey, field.objectKey)}:${field.tabname.toUpperCase()}`;

    if (!groups.has(compoundKey)) {
      groups.set(compoundKey, []);
    }

    groups.get(compoundKey).push(field);
    return groups;
  }, new Map());
}

function buildObjectFromHeader(header, assignedTablesByObject, keyFieldsByObjectTable, attributesByObject) {
  const runtimeDefinition = getRuntimeDefinitionByObjectKey(header.objectKey);
  const compoundKey = getCompoundKey(header.modelKey, header.objectKey);
  const assignedTables = (assignedTablesByObject.get(compoundKey) || [])
    .map((table) => ({
      ...table,
      keyFields: (keyFieldsByObjectTable.get(`${compoundKey}:${table.tabname.toUpperCase()}`) || [])
        .sort(sortKeyFields)
    }))
    .sort(sortTables);
  const attributes = (attributesByObject.get(compoundKey) || [])
    .sort((left, right) => left.attributeName.localeCompare(right.attributeName) || sortNullableNumbers(left.lineNumber, right.lineNumber));
  const mainTables = assignedTables.filter((table) => table.tableRole === 'MAIN').map((table) => table.tabname);
  const subTables = assignedTables.filter((table) => table.tableRole === 'SUB').map((table) => table.tabname);
  const independentTables = assignedTables.filter((table) => table.tableRole === 'INDEPENDENT').map((table) => table.tabname);

  return {
    modelKey: header.modelKey,
    objectKey: header.objectKey,
    effectiveObjectKey: header.mainObjectKey || header.objectKey,
    objectName: header.objectName,
    description: runtimeDefinition?.description || header.objectName,
    header,
    rootTable: runtimeDefinition?.rootTable || mainTables[0] || null,
    assignedTables,
    attributes,
    mainTables,
    subTables,
    independentTables,
    runtime: runtimeDefinition
      ? {
        keyField: runtimeDefinition.keyField,
        keyFieldByTable: runtimeDefinition.keyFieldByTable || {},
        fetchSequence: runtimeDefinition.fetchSequence || [],
        writeSequence: runtimeDefinition.writeSequence || [],
        numberRangeObject: runtimeDefinition.numberRangeObject || null,
        numberRanges: runtimeDefinition.numberRanges || []
      }
      : null
  };
}

function buildDthObjectModel() {
  const headers = readRows(EXPORT_PATHS.objectHeader).map(normalizeHeaderRow).filter(Boolean);
  const assignedTables = readRows(EXPORT_PATHS.assignedTables).map(normalizeAssignedTableRow).filter(Boolean);
  const keyFields = readRows(EXPORT_PATHS.keyFields).map(normalizeKeyFieldRow).filter(Boolean);
  const attributes = readRows(EXPORT_PATHS.attributes).map(normalizeAttributeRow).filter(Boolean);
  const assignedTablesByObject = groupByCompoundKey(assignedTables);
  const keyFieldsByObjectTable = groupKeyFieldsByObjectAndTable(keyFields);
  const attributesByObject = groupByCompoundKey(attributes);
  const objects = headers
    .map((header) => buildObjectFromHeader(header, assignedTablesByObject, keyFieldsByObjectTable, attributesByObject))
    .sort((left, right) => left.modelKey - right.modelKey || left.objectKey - right.objectKey);

  return {
    sourceTables: {
      objectHeader: '/DTH/T_M_OBJ',
      assignedTables: '/DTH/T_M_OBJ_S',
      keyFields: '/DTH/T_M_OBJ_I',
      attributes: '/DTH/T_M_OBJ_A'
    },
    exportPaths: EXPORT_PATHS,
    counts: {
      objects: objects.length,
      assignedTables: assignedTables.length,
      keyFields: keyFields.length,
      attributes: attributes.length
    },
    objects
  };
}

const dthObjectModel = buildDthObjectModel();

function listDthObjects() {
  return dthObjectModel.objects.map((object) => ({
    modelKey: object.modelKey,
    objectKey: object.objectKey,
    objectName: object.objectName,
    description: object.description,
    rootTable: object.rootTable,
    assignedTableCount: object.assignedTables.length,
    keyFieldCount: object.assignedTables.reduce((total, table) => total + table.keyFields.length, 0),
    attributeCount: object.attributes.length
  }));
}

function findDthObject(objectKey, modelKey) {
  const normalizedObjectKey = toNumber(objectKey);
  const normalizedModelKey = modelKey === undefined ? null : toNumber(modelKey);

  if (normalizedObjectKey === null) {
    return null;
  }

  return dthObjectModel.objects.find((object) => (
    object.objectKey === normalizedObjectKey &&
    (normalizedModelKey === null || object.modelKey === normalizedModelKey)
  )) || null;
}

function resolveEffectiveObjectKey(objectKey, modelKey) {
  const object = findDthObject(objectKey, modelKey);

  return object?.effectiveObjectKey || toNumber(objectKey);
}

module.exports = {
  dthObjectModel,
  listDthObjects,
  findDthObject,
  resolveEffectiveObjectKey
};
