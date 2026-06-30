require('dotenv').config();
const { getSystemClient, pushTableDataWithClient } = require('./services/transferService');

async function test() {
  const client = await require('./services/odataService').getSystemClient('MOCK_SYS');
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
    const result = await pushTableDataWithClient(client, 'MOCK_SYS', 'VBFA', [vbfaRecord]);
    console.log("Success:", result);
  } catch (err) {
    console.error("Error:", err.message);
  }
}
test();
