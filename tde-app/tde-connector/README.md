# TDE Connector

Reusable Node.js connector for SAP Test Data Express OData service `/sap/opu/odata/FDE/TDE_GEN_SRV`.

## Setup

Set environment variables before running:

```bash
export SAP_BASE_URL="http://APPHOST-01:8000/sap/opu/odata/FDE/TDE_GEN_SRV"
export SAP_USERNAME="..."
export SAP_PASSWORD="..."
export SAP_REJECT_UNAUTHORIZED=false
export TDE_DEFAULT_BATCH_SIZE=100
export TDE_MAX_ROWS=5000
```

The connector uses Basic Auth and fetches a fresh CSRF token from `GET /$metadata` before POST requests.

## Usage

```js
const { fetchTable, insertRows, getNextNumber } = require('./sapService');

async function main() {
  const rows = await fetchTable('T000', "MANDT LIKE '1%'", 5);
  const number = await getNextNumber('RV_BELEG', '');
  const result = await insertRows('ZTEST_TDE', [
    { MANDT: '100', ID: number, TXT: 'hello' }
  ]);

  console.log(rows, result);
}

main();
```

## Migration

```js
const { migrateObject, migrateBatch } = require('./orchestrator');

await migrateObject('SALES_ORDER');
await migrateBatch(['SALES_ORDER'], {
  SALES_ORDER: "ERDAT >= '20240101'"
});
```

## Tests

These tests call real SAP endpoints and write to `ZTEST_TDE`:

```bash
node tde-connector/test.js
```

Do not run tests against production unless the target tables and number range behavior are approved.
