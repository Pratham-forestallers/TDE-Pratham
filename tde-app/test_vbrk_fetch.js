const { createSapClient } = require('./utils/sapClient');
const { fetchTableDataWithClient } = require('./services/odataService');
const systems = require('./config/systems');

async function test() {
  const sys = systems['MOCK_SYS']; // Or whatever system has the URL 192.168.1.203
  const client = createSapClient(sys.odataUrl, sys.auth.username, sys.auth.password);
  
  try {
    const docs = await fetchTableDataWithClient(client, 'MOCK_SYS', 'VBRK', '__FETCH_ALL__', 'OBJECT_173', { rows: 1 });
    console.log("Docs:", JSON.stringify(docs, null, 2));
  } catch (err) {
    console.error(err);
  }
}
test();
