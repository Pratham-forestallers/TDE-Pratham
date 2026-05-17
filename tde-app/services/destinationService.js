const axios = require('axios');
const { AppError } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const CACHE_TTL_MS = Number(process.env.DESTINATION_CACHE_TTL_MS || 300000);
const destinationCache = new Map();

function parseVcapServices() {
  if (!process.env.VCAP_SERVICES) {
    return {};
  }

  try {
    return JSON.parse(process.env.VCAP_SERVICES);
  } catch (error) {
    throw new AppError('VCAP_SERVICES is not valid JSON', 500, { error: error.message });
  }
}

function findServiceCredentials(serviceName) {
  const services = parseVcapServices();
  const entries = Object.values(services).flat();

  const service = entries.find((entry) => {
    const label = String(entry.label || '').toLowerCase();
    const name = String(entry.name || '').toLowerCase();
    const tags = Array.isArray(entry.tags) ? entry.tags.map((tag) => String(tag).toLowerCase()) : [];

    return label.includes(serviceName) || name.includes(serviceName) || tags.includes(serviceName);
  });

  return service?.credentials;
}

function getDestinationCredentials() {
  const credentials = findServiceCredentials('destination');

  if (credentials) {
    return credentials;
  }

  if (
    process.env.DESTINATION_SERVICE_URI &&
    process.env.DESTINATION_AUTH_URL &&
    process.env.DESTINATION_CLIENT_ID &&
    process.env.DESTINATION_CLIENT_SECRET
  ) {
    return {
      uri: process.env.DESTINATION_SERVICE_URI,
      url: process.env.DESTINATION_AUTH_URL,
      clientid: process.env.DESTINATION_CLIENT_ID,
      clientsecret: process.env.DESTINATION_CLIENT_SECRET
    };
  }

  throw new AppError(
    'No SAP BTP Destination service binding found. Bind a destination service instance to tde-app.',
    500
  );
}

function getConnectivityCredentials() {
  return findServiceCredentials('connectivity');
}

async function getClientCredentialsToken({ tokenUrl, clientId, clientSecret }) {
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');

  const response = await axios.post(tokenUrl, params, {
    auth: {
      username: clientId,
      password: clientSecret
    },
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    timeout: 30000
  });

  return response.data.access_token;
}

async function getDestinationToken() {
  const credentials = getDestinationCredentials();
  const tokenUrl = `${String(credentials.url).replace(/\/+$/, '')}/oauth/token`;

  return getClientCredentialsToken({
    tokenUrl,
    clientId: credentials.clientid,
    clientSecret: credentials.clientsecret
  });
}

async function getConnectivityToken(credentials) {
  const tokenBaseUrl = credentials.token_service_url || credentials.url;
  const tokenUrl = `${String(tokenBaseUrl).replace(/\/+$/, '')}/oauth/token`;

  return getClientCredentialsToken({
    tokenUrl,
    clientId: credentials.clientid,
    clientSecret: credentials.clientsecret
  });
}

async function callDestinationApi(path) {
  const credentials = getDestinationCredentials();
  const accessToken = await getDestinationToken();
  const baseUrl = String(credentials.uri || credentials.url).replace(/\/+$/, '');

  return axios.get(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json'
    },
    timeout: 30000
  });
}

function getDestinationConfig(destination) {
  return destination.destinationConfiguration || destination;
}

function describeDestinationConfig(config) {
  let url;

  try {
    const parsedUrl = new URL(config.URL);
    url = `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
  } catch (error) {
    url = config.URL ? '[invalid-url]' : undefined;
  }

  return {
    name: config.Name,
    type: config.Type,
    url,
    proxyType: config.ProxyType,
    authentication: config.Authentication,
    cloudConnectorLocationId: resolveConnectivityLocationId(config) || undefined,
    hasCloudConnectorLocationId: Boolean(resolveConnectivityLocationId(config))
  };
}

function resolveConnectivityLocationId(config) {
  const destinationLocationId = config.CloudConnectorLocationId ||
    config.CloudConnectorLocationID ||
    config['CloudConnectorLocationId'] ||
    config['CloudConnectorLocationID'];

  if (destinationLocationId) {
    return destinationLocationId;
  }

  const destinationName = String(config.Name || '').replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  return process.env[`TDE_${destinationName}_CONNECTIVITY_LOCATION_ID`] ||
    process.env.TDE_CONNECTIVITY_LOCATION_ID;
}

function normalizeDestinationEntry(destination) {
  const config = getDestinationConfig(destination);

  return {
    key: config.Name,
    name: config.Description || config.Name,
    type: config.Type,
    hasUrl: Boolean(config.URL),
    proxyType: config.ProxyType,
    authentication: config.Authentication
  };
}

function filterDestinations(destinations) {
  const prefix = process.env.TDE_DESTINATION_PREFIX;

  return destinations
    .map(normalizeDestinationEntry)
    .filter((destination) => destination.key)
    .filter((destination) => destination.hasUrl)
    .filter((destination) => !destination.type || destination.type === 'HTTP')
    .filter((destination) => !prefix || destination.key.startsWith(prefix))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function parseDestinationList(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data.destinations)) {
    return data.destinations;
  }

  if (Array.isArray(data.subaccountDestinations) || Array.isArray(data.instanceDestinations)) {
    return [
      ...(data.subaccountDestinations || []),
      ...(data.instanceDestinations || [])
    ];
  }

  return [];
}

async function fetchDestinationCollection(path) {
  try {
    const response = await callDestinationApi(path);
    return parseDestinationList(response.data);
  } catch (error) {
    if (error.response?.status === 404) {
      return [];
    }

    throw error;
  }
}

async function listDestinations() {
  if (process.env.MOCK_DESTINATION_URL) {
    return [{
      key: 'MOCK_SYS',
      name: 'Local Test System (Bypass)',
      type: 'HTTP',
      hasUrl: true,
      proxyType: 'Internet',
      authentication: 'BasicAuthentication'
    }];
  }

  try {
    const [subaccountDestinations, instanceDestinations] = await Promise.all([
      fetchDestinationCollection('/destination-configuration/v1/subaccountDestinations'),
      fetchDestinationCollection('/destination-configuration/v1/instanceDestinations')
    ]);

    return filterDestinations([
      ...subaccountDestinations,
      ...instanceDestinations
    ]);
  } catch (error) {
    throw new AppError(
      'Failed to load SAP BTP destinations',
      error.response?.status || 502,
      {
        sapError: error.response?.data || error.message
      }
    );
  }
}

async function resolveDestination(destinationName) {
  if (!destinationName) {
    throw new AppError('Destination name is required', 400);
  }

  if (process.env.MOCK_DESTINATION_URL && destinationName === 'MOCK_SYS') {
    const authHeader = 'Basic ' + Buffer.from(`${process.env.MOCK_SAP_USER || ''}:${process.env.MOCK_SAP_PASSWORD || ''}`).toString('base64');
    return {
      destinationConfiguration: {
        Name: 'MOCK_SYS',
        Type: 'HTTP',
        URL: process.env.MOCK_DESTINATION_URL,
        ProxyType: 'Internet',
        Authentication: 'BasicAuthentication'
      },
      authTokens: [
        {
          type: 'BasicAuthentication',
          value: authHeader,
          http_header: { key: 'Authorization', value: authHeader }
        }
      ]
    };
  }

  const cached = destinationCache.get(destinationName);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.destination;
  }

  try {
    const response = await callDestinationApi(
      `/destination-configuration/v1/destinations/${encodeURIComponent(destinationName)}`
    );
    const destination = response.data;
    const config = getDestinationConfig(destination);

    if (!config.URL) {
      throw new AppError(`Destination ${destinationName} does not define a URL`, 500);
    }

    logger.info('Resolved SAP BTP destination', {
      destination: destinationName,
      config: describeDestinationConfig(config)
    });

    destinationCache.set(destinationName, {
      destination,
      expiresAt: Date.now() + CACHE_TTL_MS
    });

    return destination;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      `Failed to resolve SAP BTP destination ${destinationName}`,
      error.response?.status || 502,
      {
        destination: destinationName,
        sapError: error.response?.data || error.message
      }
    );
  }
}

function getAuthHeaders(destination) {
  const headers = {};
  const authTokens = Array.isArray(destination.authTokens) ? destination.authTokens : [];

  for (const token of authTokens) {
    const headerName = token.http_header?.key || token.http_header?.name;
    const headerValue = token.http_header?.value || token.value;

    if (headerName && headerValue) {
      headers[headerName] = headerValue;
    }
  }

  return headers;
}

async function getConnectivityOptions(destination) {
  const config = getDestinationConfig(destination);

  if (config.ProxyType !== 'OnPremise') {
    logger.info('Using direct destination connection', {
      destination: config.Name,
      proxyType: config.ProxyType
    });

    return {};
  }

  const credentials = getConnectivityCredentials();
  if (!credentials) {
    throw new AppError(
      `Destination ${config.Name} uses ProxyType=OnPremise but no connectivity service is bound`,
      500
    );
  }

  const token = await getConnectivityToken(credentials);
  const headers = {
    'Proxy-Authorization': `Bearer ${token}`
  };

  const locationId = resolveConnectivityLocationId(config);

  if (locationId) {
    headers['SAP-Connectivity-SCC-Location_ID'] = locationId;
  }

  logger.info('Using SAP Connectivity service for OnPremise destination', {
    destination: config.Name,
    proxyHost: credentials.onpremise_proxy_host,
    proxyPort: credentials.onpremise_proxy_port,
    locationId: locationId || null
  });

  return {
    proxy: {
      host: credentials.onpremise_proxy_host,
      port: Number(credentials.onpremise_proxy_port),
      protocol: 'http'
    },
    headers
  };
}

module.exports = {
  listDestinations,
  resolveDestination,
  getDestinationConfig,
  describeDestinationConfig,
  resolveConnectivityLocationId,
  getAuthHeaders,
  getConnectivityOptions
};
