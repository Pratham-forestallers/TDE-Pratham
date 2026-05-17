const connectorConfig = require('./config');
const objectConfig = require('./objectConfig');
const { fetchTable, insertRows, getNextNumber } = require('./sapService');
const { transformTable } = require('./transformer');

function log(message, meta) {
  if (meta) {
    console.log(`[TDE] ${message}`, meta);
    return;
  }

  console.log(`[TDE] ${message}`);
}

function chunkRows(rows, size) {
  const chunks = [];

  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }

  return chunks;
}

/**
 * Migrates one configured object type from source table to target table.
 * Parent object migration completes before dependencies are migrated in order.
 * @param {string} objectType Object config key.
 * @param {string} overrideFilter Optional WHERE clause override.
 * @returns {Promise<{objectType: string, fetched: number, inserted: number, dependencies: object[]}>}
 */
async function migrateObject(objectType, overrideFilter) {
  const config = objectConfig[objectType];

  if (!config) {
    throw new Error(`Unknown migration object type: ${objectType}`);
  }

  const filter = overrideFilter !== undefined ? overrideFilter : config.filter;
  log(`${objectType}: fetching from ${config.sourceTable}`, { filter });

  const sourceRows = await fetchTable(config.sourceTable, filter, connectorConfig.maxRows);
  log(`${objectType}: fetched ${sourceRows.length} rows`);

  log(`${objectType}: transforming`);
  const transformedRows = transformTable(sourceRows, config);

  if (config.numberRangeObject) {
    log(`${objectType}: assigning new ${config.keyField} values from ${config.numberRangeObject}`);

    for (const row of transformedRows) {
      row[config.keyField] = await getNextNumber(config.numberRangeObject, '');
    }
  }

  const batches = chunkRows(transformedRows, connectorConfig.defaultBatchSize);
  let inserted = 0;

  for (let index = 0; index < batches.length; index += 1) {
    log(`${objectType}: inserting batch ${index + 1} of ${batches.length}`);
    const result = await insertRows(config.targetTable, batches[index]);
    inserted += Number(result.inserted ?? batches[index].length);
  }

  const dependencies = [];

  for (const dependencyType of config.dependencies || []) {
    log(`${objectType}: migrating dependency ${dependencyType}`);
    dependencies.push(await migrateObject(dependencyType));
  }

  log(`${objectType}: done`, { fetched: sourceRows.length, inserted });

  return {
    objectType,
    fetched: sourceRows.length,
    inserted,
    dependencies
  };
}

/**
 * Migrates multiple object types in sequence. Errors are logged per object and do not abort the batch.
 * @param {string[]} objectTypes Object type keys.
 * @param {object} filters Optional map of object type to WHERE clause.
 * @returns {Promise<object[]>} Per-object migration results.
 */
async function migrateBatch(objectTypes, filters = {}) {
  const results = [];

  for (const objectType of objectTypes) {
    try {
      results.push(await migrateObject(objectType, filters[objectType]));
    } catch (error) {
      log(`${objectType}: failed`, {
        message: error.message,
        status: error.status,
        sapError: error.sapError
      });

      results.push({
        objectType,
        success: false,
        error: error.message
      });
    }
  }

  return results;
}

module.exports = {
  migrateObject,
  migrateBatch
};
