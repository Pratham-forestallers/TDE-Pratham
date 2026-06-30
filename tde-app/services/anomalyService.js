const { getSystemClient, fetchTableDataWithClient, pushTableDataWithClient } = require('./odataService');
const logger = require('../utils/logger');
const crypto = require('crypto');

function generateRandomAnomalyId() {
  // prefix '77' for anomalies, plus 8 random digits to match 10-char VBELN
  const suffix = Math.floor(10000000 + Math.random() * 90000000).toString();
  return `77${suffix}`;
}

function toUppercaseKeys(record) {
  if (!record || typeof record !== 'object') return record;
  const uppercaseRecord = {};
  for (const [key, value] of Object.entries(record)) {
    uppercaseRecord[key.toUpperCase()] = value;
  }
  return uppercaseRecord;
}

async function generateAnomalies(payload) {
  const { sourceSystem, targetSystem, objectType, referenceRows, generateCount, anomalyType } = payload;
  
  if (!sourceSystem || !targetSystem) {
    throw new Error('Source and Target systems are required.');
  }

  // Currently specifically tailored for Sales Orders (objectKey: "878" generally means Sales Order in TDE setup)
  // For anomalies, we fetch VBAK and apply the transformations
  const sourceClient = await getSystemClient(sourceSystem);
  const targetClient = await getSystemClient(targetSystem);
  
  logger.info(`Fetching ${referenceRows} reference rows from VBAK on ${sourceSystem}...`);
  // Filter out empty rows when fetching base reference records
  const rawVbakRecords = await fetchTableDataWithClient(sourceClient, sourceSystem, 'VBAK', '__FETCH_ALL__', objectType, {
    where: "vbeln <> ''",
    rows: referenceRows
  });
  
  if (!rawVbakRecords || rawVbakRecords.length === 0) {
    throw new Error('No reference records found in the source system to clone.');
  }

  const vbakRecords = rawVbakRecords.map(toUppercaseKeys);

  const generatedRows = [];
  const generatedIds = [];
  const labeledData = [];
  
  // Also fetch VBAP items if we need them (e.g. Quantity discrepancies)
  const vbelnList = vbakRecords.map(r => `'${r.VBELN}'`).join(', ');
  const rawVbapRecords = await fetchTableDataWithClient(sourceClient, sourceSystem, 'VBAP', '__FETCH_ALL__', objectType, {
    where: `vbeln IN (${vbelnList})`,
    rows: 1000 // Just to get all items
  });
  const vbapRecords = rawVbapRecords.map(toUppercaseKeys);

  // Fetch VBPA partners (Sold-to, Ship-to, etc.)
  const rawVbpaRecords = await fetchTableDataWithClient(sourceClient, sourceSystem, 'VBPA', '__FETCH_ALL__', objectType, {
    where: `vbeln IN (${vbelnList})`,
    rows: 1000
  });
  const vbpaRecords = rawVbpaRecords.map(toUppercaseKeys);

  for (let i = 0; i < generateCount; i++) {
    // Pick a random reference record
    const baseRecord = vbakRecords[i % vbakRecords.length];
    const newVbeln = generateRandomAnomalyId();
    
    // Deep clone the header
    const clonedVbak = JSON.parse(JSON.stringify(baseRecord));
    delete clonedVbak.__metadata;
    clonedVbak.VBELN = newVbeln;
    
    // Clone related items
    const baseItems = vbapRecords.filter(r => r.VBELN === baseRecord.VBELN);
    const clonedVbapList = baseItems.map(item => {
      const clonedItem = JSON.parse(JSON.stringify(item));
      delete clonedItem.__metadata;
      clonedItem.VBELN = newVbeln;
      return clonedItem;
    });

    // Clone related partners
    const basePartners = vbpaRecords.filter(r => r.VBELN === baseRecord.VBELN);
    const clonedVbpaList = basePartners.map(partner => {
      const clonedPartner = JSON.parse(JSON.stringify(partner));
      delete clonedPartner.__metadata;
      clonedPartner.VBELN = newVbeln;
      return clonedPartner;
    });

    // --- APPLY ANOMALY INJECTION ---
    switch (anomalyType) {
      case 1: // Master Data & Dependency
        clonedVbak.KUNNR = '9999999999'; // Invalid customer
        clonedVbak.VKORG = ''; // Missing Sales Org
        break;
      case 2: // Pricing & Financial
        clonedVbak.NETWR = '-5000.00'; // Negative Net Value
        clonedVbak.WAERK = 'XXX'; // Invalid Currency
        break;
      case 3: // Date & Chronological
        clonedVbak.VDATU = '19800101'; // Impossible past delivery date
        clonedVbak.ERDAT = '20991231'; // Future creation date
        break;
      case 4: // Quantity & Fulfillment
        // Empty out items completely (Header without items) or modify KWMENG
        if (clonedVbapList.length > 0) {
          clonedVbapList[0].KWMENG = '0.500'; // Fractional quantity on potentially indivisible material
        }
        break;
      case 5: // Format & Constraint
        // Exceed typical character lengths (BSTNK is usually 35 chars)
        clonedVbak.BSTNK = 'A'.repeat(100); 
        clonedVbak.AUART = 'XXXXXX'; // Invalid length
        break;
      default:
        logger.warn(`Unknown anomaly type ${anomalyType}, skipping injection.`);
    }

    const anomalyLabels = {
      1: "Master Data & Dependency",
      2: "Pricing & Financial",
      3: "Date & Chronological",
      4: "Quantity & Fulfillment",
      5: "Format & Constraint"
    };

    labeledData.push({
      anomalyLabel: anomalyLabels[anomalyType] || "Unknown",
      anomalyId: anomalyType,
      vbeln: newVbeln,
      tables: {
        VBAK: [clonedVbak],
        VBAP: clonedVbapList,
        VBPA: clonedVbpaList
      }
    });

    // Push VBAK
    try {
      const pushVbakResult = await pushTableDataWithClient(targetClient, targetSystem, 'VBAK', [clonedVbak]);
      if (pushVbakResult.succeeded > 0) {
        generatedRows.push({ table: 'VBAK', vbeln: newVbeln, status: 'Success' });
        generatedIds.push(newVbeln);
        
        // Push VBAP (if not deliberately dropped in anomaly case 4)
        if (anomalyType !== 4 || clonedVbapList.length > 0) {
          if (clonedVbapList.length > 0) {
            await pushTableDataWithClient(targetClient, targetSystem, 'VBAP', clonedVbapList);
          }
        }

        // Push VBPA (Partners)
        if (clonedVbpaList.length > 0) {
          await pushTableDataWithClient(targetClient, targetSystem, 'VBPA', clonedVbpaList);
        }
      } else {
        throw new Error('Failed to insert VBAK record via pushTableDataWithClient');
      }
    } catch (err) {
      logger.error(`Failed to push anomaly record ${newVbeln}: ${err.message}`);
      generatedRows.push({ table: 'VBAK', vbeln: newVbeln, status: 'Error', error: err.message });
    }
  }

  return {
    success: true,
    generatedRows: generatedRows.filter(r => r.status === 'Success').length,
    details: generatedRows,
    generatedKeys: generatedIds.map(id => ({
      field: 'VBELN',
      sourceValue: 'N/A',
      targetValue: id,
      numberRangeObject: 'Anomaly Generation'
    })),
    labeledData
  };
}

async function generateMixedAnomalies(payload) {
  const { sourceSystem, objectType, rowCount } = payload;
  
  if (!sourceSystem) throw new Error('Source system is required.');

  const sourceClient = await getSystemClient(sourceSystem);
  
  logger.info(`Fetching reference rows from VBAK on ${sourceSystem} for mixed generation...`);
  const rawVbakRecords = await fetchTableDataWithClient(sourceClient, sourceSystem, 'VBAK', '__FETCH_ALL__', objectType, {
    where: "vbeln <> ''",
    rows: Math.min(rowCount, 100) // fetch up to 100 references
  });
  
  if (!rawVbakRecords || rawVbakRecords.length === 0) {
    throw new Error('No reference records found in the source system to clone.');
  }
  const vbakRecords = rawVbakRecords.map(toUppercaseKeys);

  const vbelnList = vbakRecords.map(r => `'${r.VBELN}'`).join(', ');
  const rawVbapRecords = await fetchTableDataWithClient(sourceClient, sourceSystem, 'VBAP', '__FETCH_ALL__', objectType, {
    where: `vbeln IN (${vbelnList})`,
    rows: 1000
  });
  const vbapRecords = rawVbapRecords.map(toUppercaseKeys);

  const rawVbpaRecords = await fetchTableDataWithClient(sourceClient, sourceSystem, 'VBPA', '__FETCH_ALL__', objectType, {
    where: `vbeln IN (${vbelnList})`,
    rows: 1000
  });
  const vbpaRecords = rawVbpaRecords.map(toUppercaseKeys);

  const labeledData = [];
  const anomalyLabels = {
    1: "Master Data & Dependency",
    2: "Pricing & Financial",
    3: "Date & Chronological",
    4: "Quantity & Fulfillment",
    5: "Format & Constraint"
  };

  for (let i = 0; i < rowCount; i++) {
    const baseRecord = vbakRecords[i % vbakRecords.length];
    const newVbeln = generateRandomAnomalyId();
    const anomalyType = (i % 5) + 1; // 1 to 5 evenly mixed
    
    const clonedVbak = JSON.parse(JSON.stringify(baseRecord));
    delete clonedVbak.__metadata;
    clonedVbak.VBELN = newVbeln;
    
    const baseItems = vbapRecords.filter(r => r.VBELN === baseRecord.VBELN);
    const clonedVbapList = baseItems.map(item => {
      const clonedItem = JSON.parse(JSON.stringify(item));
      delete clonedItem.__metadata;
      clonedItem.VBELN = newVbeln;
      return clonedItem;
    });

    const basePartners = vbpaRecords.filter(r => r.VBELN === baseRecord.VBELN);
    const clonedVbpaList = basePartners.map(partner => {
      const clonedPartner = JSON.parse(JSON.stringify(partner));
      delete clonedPartner.__metadata;
      clonedPartner.VBELN = newVbeln;
      return clonedPartner;
    });

    switch (anomalyType) {
      case 1: 
        clonedVbak.KUNNR = '9999999999'; 
        clonedVbak.VKORG = ''; 
        break;
      case 2: 
        clonedVbak.NETWR = '-5000.00'; 
        clonedVbak.WAERK = 'XXX'; 
        break;
      case 3: 
        clonedVbak.VDATU = '19800101'; 
        clonedVbak.ERDAT = '20991231'; 
        break;
      case 4: 
        if (clonedVbapList.length > 0) clonedVbapList[0].KWMENG = '0.500'; 
        break;
      case 5: 
        clonedVbak.BSTNK = 'A'.repeat(100); 
        clonedVbak.AUART = 'XXXXXX'; 
        break;
    }

    labeledData.push({
      anomalyLabel: anomalyLabels[anomalyType] || "Unknown",
      anomalyId: anomalyType,
      vbeln: newVbeln,
      tables: {
        VBAK: [clonedVbak],
        VBAP: clonedVbapList,
        VBPA: clonedVbpaList
      }
    });
  }

  return {
    success: true,
    generatedRows: rowCount,
    labeledData
  };
}

module.exports = {
  generateAnomalies,
  generateMixedAnomalies
};
