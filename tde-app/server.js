require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const transferRoutes = require('./routes/transferRoutes');
const { errorHandler, notFoundHandler } = require('./utils/errorHandler');
const logger = require('./utils/logger');
const { getSystemClient, warmCsrfToken } = require('./services/odataService');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: false }));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({
    status: 'UP',
    app: 'tde-app',
    timestamp: new Date().toISOString()
  });
});

app.use('/api', transferRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

async function warmCsrfCache() {
  const systems = (process.env.TDE_CSRF_WARMUP_SYSTEMS || 'QS2,QS3')
    .split(',')
    .map((system) => system.trim())
    .filter(Boolean);

  if (systems.length === 0) {
    return;
  }

  for (const system of systems) {
    try {
      const client = await getSystemClient(system);
      await warmCsrfToken(client);
      logger.info('CSRF cache warmed', { system });
    } catch (error) {
      logger.warn('CSRF cache warm-up failed', {
        system,
        error: error.message,
        details: error.details
      });
    }
  }
}

app.listen(port, () => {
  logger.info(`tde-app listening on port ${port}`);
  warmCsrfCache();
});
