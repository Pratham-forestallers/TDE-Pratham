require('dotenv').config();
const { getSystemClient, postWithCsrfRetry } = require('./services/odataService');

async function test() {
  const client = await getSystemClient('MOCK_SYS');
  try {
    const crypto = require('crypto');
    
    // Insert item-level link for Delivery
    const vbfaRecord = {
      RUUID: crypto.randomBytes(16).toString('base64'),
      VBELV: '9962108611',
      POSNV: '10',  // Item 10
      VBELN: '9910861173',
      POSNN: '10',
      VBTYP_V: 'C',
      VBTYP_N: 'M'
    };
    
    const payload = {
       table: "VBFA",
       mode: "INSERT",
       rows: JSON.stringify([vbfaRecord])
    };
    
    const res = await postWithCsrfRetry(client, 'InsertDataSet', {
       RequestId: "TEST_ITEM_LINK",
       Payload: JSON.stringify(payload)
    });
    console.log("Success item link! Status:", res.response.status);
  } catch (err) {
    if (err.response) {
       console.error("Error from SAP:", JSON.stringify(err.response.data));
    } else {
       console.error("Error:", err.message);
    }
  }
}
test();
