const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const OBJECT_TEXT_HTML = path.join(PROJECT_ROOT, 'object text.HTML');
const OBJECT_STRUCTURE_HTML = path.join(PROJECT_ROOT, 'object structure.HTML');
const NUMBER_RANGE_HTML = path.join(PROJECT_ROOT, 'numberrange.HTML');
const OUTPUT_FILE = path.join(PROJECT_ROOT, 'config', 'objectStructureConfig.js');

const TABLE_TYPE_LABELS = {
  A: 'MAIN',
  B: 'SUB',
  C: 'INDEPENDENT'
};

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCharCode(parseInt(decimal, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function normalizeCell(value) {
  return decodeHtml(value)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHtmlTable(filePath) {
  const html = fs.readFileSync(filePath, 'utf8');
  const rows = [];
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const cells = [];
    const cellPattern = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;

    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      cells.push(normalizeCell(cellMatch[1]));
    }

    if (cells.length > 0 && !cells[0].startsWith('Project Key')) {
      rows.push(cells);
    }
  }

  return rows;
}

function toNumber(value) {
  const normalized = String(value || '').trim();

  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function toConfigKey(description, objectKey) {
  const normalized = String(description || '')
    .normalize('NFKD')
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

  return normalized || `OBJECT_${objectKey}`;
}

function uniqueConfigKey(baseKey, objectKey, usedKeys) {
  if (!usedKeys.has(baseKey)) {
    usedKeys.add(baseKey);
    return baseKey;
  }

  const suffixed = `${baseKey}_${objectKey}`;
  usedKeys.add(suffixed);
  return suffixed;
}

function sortTables(tables) {
  return [...tables].sort((left, right) => {
    const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    return left.tableName.localeCompare(right.tableName);
  });
}

function groupTableNames(tables, tableType) {
  return sortTables(tables)
    .filter((table) => table.tableType === tableType)
    .map((table) => table.tableName);
}

function getCompoundKey(projectKey, objectKey) {
  return `${projectKey}:${objectKey}`;
}

function parseNumberRanges() {
  if (!fs.existsSync(NUMBER_RANGE_HTML)) {
    return new Map();
  }

  const numberRangesByObject = new Map();

  for (const cells of parseHtmlTable(NUMBER_RANGE_HTML)) {
    const projectKey = toNumber(cells[0]);
    const objectKey = toNumber(cells[1]);
    const attributeName = cells[2];
    const lineNumber = toNumber(cells[3]);
    const value = cells[4];

    if (
      projectKey === null ||
      objectKey === null ||
      attributeName !== 'NUMBER_RANGE' ||
      !value
    ) {
      continue;
    }

    const compoundKey = getCompoundKey(projectKey, objectKey);

    if (!numberRangesByObject.has(compoundKey)) {
      numberRangesByObject.set(compoundKey, []);
    }

    numberRangesByObject.get(compoundKey).push({
      lineNumber,
      object: value
    });
  }

  for (const [compoundKey, numberRanges] of numberRangesByObject.entries()) {
    numberRangesByObject.set(
      compoundKey,
      numberRanges.sort((left, right) => {
        const leftLine = left.lineNumber ?? Number.MAX_SAFE_INTEGER;
        const rightLine = right.lineNumber ?? Number.MAX_SAFE_INTEGER;

        if (leftLine !== rightLine) {
          return leftLine - rightLine;
        }

        return left.object.localeCompare(right.object);
      })
    );
  }

  return numberRangesByObject;
}

function buildObjectConfig() {
  const objectTextByKey = new Map();
  const objectTextByCompoundKey = new Map();

  for (const cells of parseHtmlTable(OBJECT_TEXT_HTML)) {
    const projectKey = toNumber(cells[0]);
    const objectKey = toNumber(cells[2]);
    const description = cells[3];

    if (objectKey !== null) {
      objectTextByKey.set(objectKey, description);
    }

    if (projectKey !== null && objectKey !== null) {
      objectTextByCompoundKey.set(getCompoundKey(projectKey, objectKey), description);
    }
  }

  const objectEntriesByCompoundKey = new Map();

  for (const cells of parseHtmlTable(OBJECT_STRUCTURE_HTML)) {
    const projectKey = toNumber(cells[0]);
    const objectKey = toNumber(cells[1]);
    const tableName = cells[2];
    const tableType = cells[3];

    if (projectKey === null || objectKey === null || !tableName || !TABLE_TYPE_LABELS[tableType]) {
      continue;
    }

    const table = {
      tableName,
      tableType,
      tableRole: TABLE_TYPE_LABELS[tableType],
      linkKey: toNumber(cells[4]),
      segment: cells[5] || null,
      order: toNumber(cells[6])
    };
    const compoundKey = getCompoundKey(projectKey, objectKey);

    if (!objectEntriesByCompoundKey.has(compoundKey)) {
      objectEntriesByCompoundKey.set(compoundKey, {
        projectKey,
        objectKey,
        tables: []
      });
    }

    objectEntriesByCompoundKey.get(compoundKey).tables.push(table);
  }

  const numberRangesByObject = parseNumberRanges();
  const usedKeys = new Set();
  const config = {};

  const objectEntries = [...objectEntriesByCompoundKey.values()].sort((left, right) => (
    left.projectKey - right.projectKey || left.objectKey - right.objectKey
  ));

  for (const { projectKey, objectKey, tables } of objectEntries) {
    const compoundKey = getCompoundKey(projectKey, objectKey);
    const description = objectTextByCompoundKey.get(compoundKey) ||
      objectTextByKey.get(objectKey) ||
      `Object ${objectKey}`;
    const configKey = uniqueConfigKey(toConfigKey(description, objectKey), objectKey, usedKeys);
    const mainTables = groupTableNames(tables, 'A');
    const subTables = groupTableNames(tables, 'B');
    const independentTables = groupTableNames(tables, 'C');
    const numberRanges = numberRangesByObject.get(compoundKey) || [];

    config[configKey] = {
      projectKey,
      objectKey,
      description,
      rootTable: mainTables[0] || null,
      numberRanges,
      numberRangeObject: numberRanges[0]?.object || null,
      mainTables,
      subTables,
      independentTables,
      fetchSequence: [
        ...mainTables,
        ...subTables,
        ...independentTables
      ],
      writeSequence: [
        ...mainTables,
        ...subTables
      ],
      tables: sortTables(tables)
    };
  }

  return config;
}

function writeOutput(config) {
  const fileContents = [
    '// Generated from object text.HTML, object structure.HTML, and numberrange.HTML.',
    '// Run `npm run generate:object-structure-config` after replacing those SAP exports.',
    "'use strict';",
    '',
    `module.exports = ${JSON.stringify(config, null, 2)};`,
    ''
  ].join('\n');

  fs.writeFileSync(OUTPUT_FILE, fileContents);
}

writeOutput(buildObjectConfig());
