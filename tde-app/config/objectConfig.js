const fs = require('fs');
const path = require('path');
const generatedObjectConfig = require('./objectStructureConfig');

const DEFAULT_KEY_FIELD = process.env.TDE_DEFAULT_OBJECT_KEY_FIELD || 'OBJECT_ID';
const RELATION_EXPORT_PATH = path.join(__dirname, '..', '..', 'Table and fields relations.HTML');

function decodeHtmlCell(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x20;/gi, ' ')
    .replace(/&#(\d+);/g, (match, codePoint) => String.fromCharCode(Number(codePoint)))
    .replace(/&#x([0-9a-f]+);/gi, (match, codePoint) => String.fromCharCode(parseInt(codePoint, 16)))
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function readRelationExportRows() {
  if (!fs.existsSync(RELATION_EXPORT_PATH)) {
    return [];
  }

  const html = fs.readFileSync(RELATION_EXPORT_PATH, 'utf8');

  return html
    .split(/<tr[^>]*>/i)
    .slice(1)
    .map((row) => row.split(/<\/tr>/i)[0])
    .map((row) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => decodeHtmlCell(cell[1])))
    .filter((cells) => cells.length >= 12 && /^\d+$/.test(cells[1]))
    .map((cells) => ({
      projectKey: Number(cells[0]),
      objectKey: Number(cells[1]),
      linkKey: Number(cells[2]),
      sourceTable: cells[3],
      sourceField: cells[4],
      predecessorTable: cells[7],
      targetField: cells[8]
    }));
}

function buildKeyFieldByTableFromRelations(definition, relationRows) {
  const tableNames = new Set((definition.fetchSequence || []).map((tableName) => tableName.toUpperCase()));
  const mappings = {};

  for (const row of relationRows) {
    const sourceTable = row.sourceTable.toUpperCase();

    if (
      row.objectKey !== definition.objectKey ||
      !sourceTable ||
      !row.sourceField ||
      !tableNames.has(sourceTable)
    ) {
      continue;
    }

    mappings[sourceTable] = row.sourceField.toUpperCase();
  }

  return mappings;
}

const relationRows = readRelationExportRows();

function withRuntimeDefaults(definition) {
  const relationKeyFieldByTable = buildKeyFieldByTableFromRelations(definition, relationRows);

  return {
    keyField: DEFAULT_KEY_FIELD,
    dependencyFields: {},
    renumberValueMappings: [],
    whereClauseByTable: {},
    decimalFieldsByTable: {},
    ...definition,
    keyFieldByTable: {
      ...relationKeyFieldByTable,
      ...(definition.keyFieldByTable || {})
    }
  };
}

const objectConfig = Object.fromEntries(
  Object.entries(generatedObjectConfig).map(([configKey, definition]) => [
    configKey,
    withRuntimeDefaults(definition)
  ])
);

// Manual runtime overrides stay backend-only. The SAP object structure export
// tells us object/table membership, but not every business key field, number
// range, or special WHERE clause needed to copy live data.
if (objectConfig.SALES_DOCUMENT) {
  Object.assign(objectConfig.SALES_DOCUMENT, {
    keyField: 'VBELN',
    keyFieldByTable: {
      ...objectConfig.SALES_DOCUMENT.keyFieldByTable,
      VBREVAC: 'VBELV'
    },
    objectIdLabel: 'Sales Document Number',
    objectIdPlaceholder: 'Sales document number / VBELN',
    numberRangeObject: 'RV_BELEG',
    idLength: 10,
    idPadChar: '0',
    dependencyFields: {
      VBAK: ['KNUMV']
    },
    renumberValueMappings: [
      {
        sourceContextField: 'KNUMV',
        target: 'numberRange',
        targetContextField: 'KNUMV',
        numberRangeObject: process.env.TDE_KNUMV_NUMBER_RANGE_OBJECT || 'KONV',
        numberRangeSubObject: process.env.TDE_KNUMV_NUMBER_RANGE_SUBOBJECT || ''
      }
    ],
    whereClauseByTable: {
      VBFA: "VBELV = '{OBJECT_ID}'",
      PRCD_ELEMENTS: "KNUMV = '{KNUMV}'"
    },
    regenerateFieldsByTable: {
      VBFA: ['RUUID']
    },
    decimalFieldsByTable: {
      VBAK: ['NETWR']
    }
  });
}

if (objectConfig.PURCHASING_DOCUMENT) {
  Object.assign(objectConfig.PURCHASING_DOCUMENT, {
    description: 'Purchase Order',
    keyField: 'EBELN',
    objectIdLabel: 'Purchase Order Number',
    objectIdPlaceholder: 'Purchase order number / EBELN',
    numberRangeObject: 'EINKBELEG',
    idLength: 10,
    idPadChar: '0'
  });
}

module.exports = objectConfig;
