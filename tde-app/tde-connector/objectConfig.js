const objectConfig = {
  SALES_ORDER: {
    sourceTable: 'VBAK',
    targetTable: 'ZVBAK_COPY',
    numberRangeObject: 'RV_BELEG',
    keyField: 'VBELN',
    fieldMap: {},
    transformations: {
      NETWR: (val) => (val === undefined || val === null || val === '' ? val : String(parseFloat(val).toFixed(2))),
      ERDAT: (val) => val
    },
    dependencies: ['SALES_ORDER_ITEM'],
    filter: "ERDAT >= '20240101'"
  },
  SALES_ORDER_ITEM: {
    sourceTable: 'VBAP',
    targetTable: 'ZVBAP_COPY',
    numberRangeObject: null,
    keyField: 'VBELN',
    fieldMap: {},
    transformations: {},
    dependencies: [],
    filter: ''
  }
};

module.exports = objectConfig;
