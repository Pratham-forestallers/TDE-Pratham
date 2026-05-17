/**
 * Applies configured field renames to a row.
 * @param {object} row Source row.
 * @param {object} fieldMap Map of source field names to target field names.
 * @returns {object} Row with mapped field names.
 */
function applyFieldMap(row, fieldMap = {}) {
  const mapped = {};

  for (const [field, value] of Object.entries(row || {})) {
    const targetField = fieldMap[field] || field;
    mapped[targetField] = value;
  }

  return mapped;
}

/**
 * Applies field mapping and per-field transformation functions to a single row.
 * Missing fields are skipped without throwing.
 * @param {object} row Source row.
 * @param {object} config Object migration config.
 * @returns {object} Transformed row.
 */
function applyTransformations(row, config) {
  const transformed = applyFieldMap(row, config.fieldMap || {});

  for (const [field, transform] of Object.entries(config.transformations || {})) {
    if (typeof transform === 'function') {
      transformed[field] = transform(transformed[field]);
    }
  }

  return transformed;
}

/**
 * Applies configured transformations to an entire row array.
 * @param {object[]} rows Source rows.
 * @param {object} config Object migration config.
 * @returns {object[]} Transformed rows.
 */
function transformTable(rows, config) {
  return (rows || []).map((row) => applyTransformations(row, config));
}

module.exports = {
  applyTransformations,
  applyFieldMap,
  transformTable
};
