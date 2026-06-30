require('dotenv').config();
const { getSystemClient, postWithCsrfRetry } = require('./services/odataService');

async function test() {
  const client = await getSystemClient('MOCK_SYS');
  try {
    const crypto = require('crypto');
    const ruuid = crypto.randomBytes(16).toString('base64');
    
    const vbfaRecord = {
      RUUID: ruuid,
      VBELV: '9962108605',
      POSNV: '000000',
      VBELN: '9910860526',
      POSNN: '000000',
      VBTYP_V: 'C',
      VBTYP_N: 'M'
    };
    
    console.log("Trying with RUUID:", ruuid);
    const payload = {
       table: "VBFA",
       mode: "INSERT",
       rows: JSON.stringify([vbfaRecord])
    };
    
    const res = await postWithCsrfRetry(client, 'InsertDataSet', {
       RequestId: "TEST_RUUID_123",
       Payload: JSON.stringify(payload)
    });
    console.log("Success! Status:", res.response.status);
  } catch (err) {
    if (err.response) {
       console.error("Error from SAP:", JSON.stringify(err.response.data));
    } else {
       console.error("Error:", err.message);
    }
  }
}
test();
