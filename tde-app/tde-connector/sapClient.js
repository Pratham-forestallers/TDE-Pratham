const https = require('https');
const axios = require('axios');
const config = require('./config');

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

function buildClient() {
  return axios.create({
    baseURL: normalizeBaseUrl(config.baseUrl),
    auth: {
      username: config.username,
      password: config.password
    },
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    httpsAgent: new https.Agent({
      rejectUnauthorized: config.rejectUnauthorized
    }),
    timeout: config.timeout
  });
}

function extractSapError(error) {
  const data = error.response?.data;

  if (data?.error?.message?.value) {
    return data.error.message.value;
  }

  if (data?.error?.message) {
    return typeof data.error.message === 'string'
      ? data.error.message
      : JSON.stringify(data.error.message);
  }

  if (typeof data === 'string') {
    return data;
  }

  return error.message;
}

function buildRequestError(error, context) {
  const message = extractSapError(error);
  const wrapped = new Error(`${context}: ${message}`);
  wrapped.status = error.response?.status;
  wrapped.sapError = message;
  wrapped.responseData = error.response?.data;
  return wrapped;
}

function buildCookieHeader(cookies) {
  return Array.isArray(cookies) ? cookies.join('; ') : '';
}

/**
 * Fetches a fresh SAP CSRF token and session cookies from the OData metadata endpoint.
 * @returns {Promise<{token: string, cookies: string[]}>}
 */
async function getCSRFToken() {
  const client = buildClient();

  try {
    const response = await client.get('/$metadata', {
      headers: {
        'x-csrf-token': 'Fetch',
        Accept: 'application/xml,text/xml'
      },
      responseType: 'text',
      transformResponse: [(data) => data]
    });

    const token = response.headers['x-csrf-token'];

    if (!token) {
      throw new Error('SAP did not return x-csrf-token from $metadata');
    }

    return {
      token,
      cookies: response.headers['set-cookie'] || []
    };
  } catch (error) {
    throw buildRequestError(error, 'Failed to fetch SAP CSRF token');
  }
}

/**
 * Sends a POST request to an SAP OData entity set with CSRF handling.
 * If SAP rejects the request because the token is stale, a fresh token is fetched and the request is retried once.
 * @param {string} entitySet SAP OData entity set name.
 * @param {object} body JSON request body.
 * @returns {Promise<object>} Raw Axios response data.
 */
async function sapPost(entitySet, body) {
  const client = buildClient();
  let csrf = await getCSRFToken();

  const postOnce = () => client.post(`/${entitySet}`, body, {
    headers: {
      'x-csrf-token': csrf.token,
      Cookie: buildCookieHeader(csrf.cookies)
    }
  });

  try {
    const response = await postOnce();
    return response.data;
  } catch (error) {
    const status = error.response?.status;
    const sapError = extractSapError(error);

    if (status === 403 && /csrf/i.test(sapError)) {
      csrf = await getCSRFToken();
      try {
        const retryResponse = await postOnce();
        return retryResponse.data;
      } catch (retryError) {
        throw buildRequestError(retryError, `SAP POST ${entitySet} failed after CSRF retry`);
      }
    }

    throw buildRequestError(error, `SAP POST ${entitySet} failed`);
  }
}

module.exports = {
  getCSRFToken,
  sapPost,
  extractSapError
};
