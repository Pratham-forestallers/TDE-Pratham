# tde-app

Test Data Express (TDE) is a Node.js and Express web application for previewing and transferring SAP business object data between SAP systems configured as SAP BTP destinations. It calls the real OData service `/sap/opu/odata/FDE/TDE_GEN_SRV/`.

The application does not contain mock records, generated fallback records, or simulated OData responses. If SAP OData is unreachable or the service metadata mapping is wrong, the API returns the real failure details in a structured error response.

## Features

- Select source and target SAP systems from SAP BTP destinations.
- Select a supported object type. The current object type is `SALES_ORDER`, scoped to sales order header, item, partner, schedule, pricing, and document-flow tables.
- Enter an object ID such as a sales order number.
- Preview related source data through real SAP OData reads.
- Execute a transfer through real SAP OData writes.
- Switch between light and dark liquid-glass UI themes.
- Deploy to SAP BTP Cloud Foundry with `cf push`.

## Project Structure

```text
tde-app/
  config/               Backend object and SAP system configuration.
  public/               Browser UI assets for the main transfer app.
    index.html          Main application page.
    app.js              Main frontend behavior and theme toggle.
    style.css           Shared liquid-glass theme and layout styles.
  routes/               Express API route definitions.
    transferRoutes.js   Public transfer API endpoints.
  services/             SAP destination, OData, and transfer orchestration logic.
  utils/                Logging and Express error helpers.
  tde-connector/        Legacy connector utility code and connector-level test script.
  server.js             Express app setup, static asset hosting, and API mounting.
```

The production UI is intentionally kept in `public/`, and backend behavior is split between `routes/`, `services/`, and `config/`. Temporary diagnostic pages and proof-of-concept trial routes have been removed from the main app surface.

## Local Setup

Install dependencies:

```bash
npm install
```

Create a local environment file:

```bash
cp .env.example .env
```

For local development against a BTP Destination service instance, populate `.env` with service credentials from a service key:

```bash
PORT=3000
DESTINATION_SERVICE_URI=https://destination-configuration.cfapps...
DESTINATION_AUTH_URL=https://your-subdomain.authentication...
DESTINATION_CLIENT_ID=...
DESTINATION_CLIENT_SECRET=...
TDE_DESTINATION_PREFIX=
```

On Cloud Foundry, these values come from `VCAP_SERVICES` automatically when the app is bound to a Destination service. Do not put SAP backend usernames or passwords in `.env`.

Run locally:

```bash
npm start
```

For development with automatic restarts:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

Health check:

```text
http://localhost:3000/health
```

## SAP BTP Destination Configuration

Create SAP BTP destinations for each SAP source or target system. The app lists HTTP destinations returned by the bound Destination service.

Recommended destination examples:

```text
Name=TDE_PRD
Type=HTTP
URL=https://your-prd-host.example.com
ProxyType=Internet
Authentication=BasicAuthentication
User=...
Password=...
```

```text
Name=TDE_DEV
Type=HTTP
URL=https://your-dev-host.example.com
ProxyType=Internet
Authentication=BasicAuthentication
User=...
Password=...
```

If you use `ProxyType=OnPremise`, also bind a Connectivity service instance and configure SAP Cloud Connector. The manifest includes a commented `tde-connectivity` binding line for that case.

If your Cloud Connector uses a Location ID and the BTP destination does not expose it to the app, set either a global fallback or a system-specific fallback:

```bash
cf set-env tde-app TDE_CONNECTIVITY_LOCATION_ID USA
cf set-env tde-app TDE_QS2_CONNECTIVITY_LOCATION_ID USA
cf set-env tde-app TDE_QS3_CONNECTIVITY_LOCATION_ID USA
```

By default the app warms CSRF tokens for `QS2` and `QS3` after startup. Override the list if needed:

```bash
cf set-env tde-app TDE_CSRF_WARMUP_SYSTEMS QS2,QS3
```

By default the app reads the root table in the target system before writing. If the same business object number already exists, the app calls `NumberRangeSet` on the target system, replaces the old object number in the fetched payload with the next number range value, and writes the records with that new key:

```bash
cf set-env tde-app TDE_TARGET_EXISTENCE_CHECK optional
```

Use `required` when a target lookup failure should stop the transfer. Use `skip` only when target-side duplicate detection and renumbering should be bypassed.

When sales order renumbering is active, `KNUMV` is also treated as a dependent key. Configure its number range object so copied pricing records do not reuse an existing target `PRCD_ELEMENTS` key:

```bash
cf set-env tde-app TDE_KNUMV_NUMBER_RANGE_OBJECT KONV
cf set-env tde-app TDE_KNUMV_NUMBER_RANGE_SUBOBJECT ""
```

Set `TDE_DESTINATION_PREFIX` if you want the dropdown to show only destinations with a specific prefix, for example `TDE_`.

The OData integration is centralized in `services/odataService.js`. The service uses this SAP OData base path:

```text
/sap/opu/odata/FDE/TDE_GEN_SRV/
```

The implementation posts request envelopes to `FetchDataSet` for reads and `InsertDataSet` for writes.

The backend accepts `RequestId` and `Payload` for `FetchDataSet`, `RequestId` and `Payload` for `InsertDataSet`, and returns `Payload` in responses. The JSON contract inside that payload string is isolated at the top of `services/odataService.js` and can be adjusted with environment variables:

```js
const ODATA_MAPPING = {
  servicePath: '/sap/opu/odata/FDE/TDE_GEN_SRV/',
  fetchEntitySet: 'FetchDataSet',
  insertEntitySet: 'InsertDataSet',
  requestIdField: 'RequestId',
  fetchRequestPayloadField: 'Payload',
  insertRequestPayloadField: 'Payload',
  responsePayloadField: 'Payload',
  csrfTokenPaths: ['FetchDataSet', 'InsertDataSet', 'NumberRangeSet', '', '$metadata']
};
```

The default payload keys are `table`, `where`, and `rows`, matching the ABAP contract for `FetchDataSet` and `InsertDataSet`. The request payload property is always a stringified JSON string, not a nested object. For inserts, `rows` defaults to a stringified JSON array inside `Payload`, matching the SAP Gateway Client/Postman shape:

```json
{
  "RequestId": "INSERT_001",
  "Payload": "{\"table\":\"VBAK\",\"rows\":\"[{\\\"vbeln\\\":\\\"0000015763\\\"}]\"}"
}
```

Set `TDE_INSERT_ROWS_AS_STRING=false` if the ABAP service expects `rows` as an array. Insert row field names default to lower case, matching the working Postman payload. Set `TDE_INSERT_RECORD_KEY_CASE=preserve` if the ABAP service expects the original source field casing. Insert values are stringified by default with `TDE_INSERT_STRINGIFY_VALUES=true`, and configured decimal fields such as `VBAK.NETWR` are formatted with two decimals. The current transfer does not limit insert fields: every field returned by each source `FetchDataSet` row is sent to the target after OData metadata is removed and normal insert formatting is applied. Automated transfers post one row per `InsertDataSet` request by default, matching the known-good single-record body; set `TDE_INSERT_BATCH_SIZE` to a larger number only if the ABAP service supports multi-row insert payloads. If the ABAP implementation expects different names inside the payload string, update the `TDE_PAYLOAD_*` environment variables. If the names do not match, the app fails transparently and returns the SAP OData error instead of inventing data.

## Backend Object Logic

Business object dependency logic is backend-only in `config/objectConfig.js`. The frontend does not contain dependency mapping and does not provide any UI for maintaining table dependencies.

Current support:

```text
SALES_ORDER -> VBAK, VBAP, VBKD, VBPA, VBEP, PRCD_ELEMENTS, VBFA
```

## API

### GET `/api/systems`

Returns available SAP BTP destinations for dropdowns. It does not expose destination credentials.

### GET `/api/object-types`

Returns supported object types.

### POST `/api/preview`

Request:

```json
{
  "sourceSystem": "TDE_PRD",
  "targetSystem": "TDE_DEV",
  "objectType": "SALES_ORDER",
  "objectId": "50000123"
}
```

The backend validates the request, resolves backend-only object dependencies, calls the real source SAP OData service, and returns structured data.

### POST `/api/run`

Request:

```json
{
  "sourceSystem": "TDE_PRD",
  "targetSystem": "TDE_DEV",
  "objectType": "SALES_ORDER",
  "objectId": "50000123"
}
```

The backend fetches fresh data from the source system and writes it to the target system in the configured backend sequence. If a table write fails, processing stops and the response includes the table-level failure details.

## Cloud Foundry Deployment

Log in to the target SAP BTP Cloud Foundry subaccount:

```bash
cf login
```

Deploy the app without starting it, then set environment variables:

```bash
cf create-service destination lite tde-destination
# Optional, only for ProxyType=OnPremise destinations:
# cf create-service connectivity lite tde-connectivity
cf push --no-start
```

Optionally restrict the dropdown to TDE destinations:

```bash
cf set-env tde-app TDE_DESTINATION_PREFIX TDE_
```

Start the app:

```bash
cf start tde-app
```

For later code deployments, run:

```bash
cf push
```

## Production Notes

- Store SAP system credentials in SAP BTP destinations, not in source control or frontend code.
- Confirm the exact JSON shape expected inside `FetchDataSet.Payload` and `InsertDataSet.Payload` with the ABAP service implementation.
- Keep business object dependency logic out of frontend code and customer-visible configuration.
- Review network connectivity between SAP BTP Cloud Foundry and each SAP backend before deployment.
