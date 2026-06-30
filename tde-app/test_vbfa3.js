require('dotenv').config();
const { getSystemClient, fetchTableDataWithClient } = require('./services/odataService');

async function test() {
  const client = await getSystemClient('MOCK_SYS');
  try {
    const vbfa = await fetchTableDataWithClient(
      client, 'MOCK_SYS', 'VBFA', '__FETCH_ALL__', 'OBJECT_173', 
      { where: "VBELV = '9962108605'", rows: 10 }
    );
    console.log(JSON.stringify(vbfa, null, 2));
  } catch (err) {
    console.error(err);
  }
}
test();
