const config = {
  baseUrl: process.env.SAP_BASE_URL || 'http://APPHOST-01:8000/sap/opu/odata/FDE/TDE_GEN_SRV',
  username: process.env.SAP_USERNAME || 'F10007',
  password: process.env.SAP_PASSWORD || 'Naitik@2608',
  rejectUnauthorized: process.env.SAP_REJECT_UNAUTHORIZED !== 'false',
  defaultBatchSize: Number(process.env.TDE_DEFAULT_BATCH_SIZE || 100),
  maxRows: Number(process.env.TDE_MAX_ROWS || 5000),
  timeout: Number(process.env.SAP_HTTP_TIMEOUT_MS || 60000)
};

module.exports = config;
