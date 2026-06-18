'use strict';

const followOnRows = require('./followOnRows');
const objectLabels = require('./objectLabels');

const SALES_DOCUMENT_OBJECT_KEY = 878;

/**
 * Maps a follow-on object key to the SAP VBTYP document category code used in
 * VBFA.VBTYP_N.  Standard SAP SD category codes:
 *   A  Inquiry
 *   B  Quotation
 *   C  Sales Order
 *   D  Item proposal
 *   E  Scheduling agreement
 *   F  Production / Process Order
 *   G  Contract
 *   H  Returns
 *   J  Delivery
 *   K  Credit memo request
 *   L  Debit memo request
 *   M  Billing document (Invoice)
 *   N  Cancellation billing document
 *   O  Overhead order
 *   P  Purchase order
 *   Q  WM transfer order
 *   R  GI/GR (Goods movement / Material document)
 *   S  Credit memo
 *   T  Debit memo
 *   U  Independent requirement
 *   V  Purchase requisition
 *   W  Ind. despatch note
 *   X  Exchange (internal)
 */
const VBTYP_N_BY_OBJECT = {
  173: 'M',   // Billing Document (Invoice)
  174: 'M',   // Billing Document Data
  176: 'M',   // Billing for Third Party
  178: 'M',   // Billing Order
  371: 'J',   // Delivery (Outbound)
  550: 'R',   // Material Document (GI/GR)
  684: 'F',   // Order (Production/Process)
  746: 'U',   // Planned Order
  819: 'V',   // Purchase Requisition
  822: 'P',   // Purchase Order
  860: 'Q',   // Reservation (WM Transfer Order)
  926: 'M',   // Service Package (Billing-related)
};

// Dynamically build the follow-on rules from the SAP export JSON
const FOLLOWON_RULES = followOnRows
  .filter(row => row.objectKey === SALES_DOCUMENT_OBJECT_KEY)
  .map(row => ({
    targetObjectKey: row.targetObjectKey,
    name: objectLabels[row.targetObjectKey] || `Unknown (${row.targetObjectKey})`,
    mandatory: row.mandatory === true,
    vbtypN: VBTYP_N_BY_OBJECT[row.targetObjectKey] || 'J'  // default to Delivery if unknown
  }));

module.exports = { FOLLOWON_RULES, VBTYP_N_BY_OBJECT };
