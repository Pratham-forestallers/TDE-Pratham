const { getSystemClient, fetchTableDataWithClient } = require('./services/odataService');

async function test() {
  try {
    const sourceSystem = 'MOCK_SYS';
    const client = await getSystemClient(sourceSystem);
    
    console.log('Fetching KONV...');
    const konv = await fetchTableDataWithClient(
      client, sourceSystem, 'KONV', '__FETCH_ALL__', 'SALES_DOCUMENT', 
      { where: "KNUMV = '0000004959'", rows: 50 }
    );
    console.log(`KONV rows: ${konv ? konv.length : 0}`);

    console.log('Fetching PRCD_ELEMENTS...');
    const prcd = await fetchTableDataWithClient(
      client, sourceSystem, 'PRCD_ELEMENTS', '__FETCH_ALL__', 'SALES_DOCUMENT', 
      { where: "KNUMV = '0000004959'", rows: 50 }
    );
    console.log(`PRCD_ELEMENTS rows: ${prcd ? prcd.length : 0}`);

  } catch (err) {
    console.error('Error:', err.message);
  }
}

test();
