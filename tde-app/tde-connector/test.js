const assert = require('assert');
const { fetchTable, insertRows, getNextNumber } = require('./sapService');
const { migrateObject } = require('./orchestrator');

async function run() {
  const tableRows = await fetchTable('T000', "MANDT LIKE '1%'", 5);
  assert(Array.isArray(tableRows), 'fetchTable must return an array');
  assert(tableRows.length >= 1, 'fetchTable should return at least one T000 row');

  const nextNumber = await getNextNumber('RV_BELEG', '');
  assert(/^\d{10}$/.test(nextNumber), 'getNextNumber should return a 10-char numeric string');

  const insertResult = await insertRows('ZTEST_TDE', [
    {
      MANDT: '100',
      ID: 'TEST001',
      TXT: 'hello'
    }
  ]);
  assert.strictEqual(insertResult.status, 'OK', 'insertRows should return status OK');

  const summary = await migrateObject('SALES_ORDER');
  assert.strictEqual(summary.objectType, 'SALES_ORDER', 'summary objectType mismatch');
  assert(typeof summary.fetched === 'number', 'summary.fetched must be a number');
  assert(typeof summary.inserted === 'number', 'summary.inserted must be a number');

  console.log('All TDE connector tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
