const axios = require('axios');
const logger = require('../utils/logger');

const SYNTHETIC_API_URL = process.env.SYNTHETIC_API_URL || 'http://localhost:8000';

/**
 * Requests synthetic data generation from the Python microservice.
 * @param {string} entitySet - The target entity set to synthesize (e.g., 'API_SALES_ORDER_SRV/A_SalesOrder')
 * @param {Array} sourceData - The source records to synthesize from
 * @param {number} numRecords - How many records to generate
 * @returns {Promise<Array>} The synthetic records
 */
async function requestSyntheticData(entitySet, sourceData = [], numRecords = 100, baseOffset = null, maskPhoneNumbers = true) {
  try {
    logger.info(`Requesting synthetic data for ${entitySet} from Python API`);
    
    const response = await axios.post(`${SYNTHETIC_API_URL}/api/synthesize`, {
      entitySet: entitySet,
      numRecords: numRecords,
      sourceData: sourceData,
      baseOffset: baseOffset,
      maskPhoneNumbers: maskPhoneNumbers
    }, {
      timeout: 120000 // ML generation might take a bit
    });
    
    if (response.data && response.data.results) {
      const actualBase = response.data.actualBaseOffset;
      logger.info(`Successfully generated ${response.data.syntheticRowsGenerated} synthetic records for ${entitySet} (baseOffset=${actualBase}, maskPhones=${maskPhoneNumbers})`);
      return { records: response.data.results, actualBaseOffset: actualBase };
    }
    
    return { records: [], actualBaseOffset: null };
  } catch (error) {
    logger.error('Failed to request synthetic data', {
      error: error.message,
      entitySet,
      response: error.response?.data
    });
    throw error;
  }
}

module.exports = {
  requestSyntheticData
};
