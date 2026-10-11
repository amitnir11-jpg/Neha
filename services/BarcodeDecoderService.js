const { parseScannedCode } = require('../utils/scanParser');

// Authoritative server result. Client parsing is a preview only.
function decodeBarcode(rawBarcode, format) {
  const parsed = parseScannedCode(rawBarcode, format);
  return {
    ...parsed,
    rawBarcode: String(rawBarcode ?? ''),
    normalizedBarcodeIdentity: parsed.upi || parsed.normalizedValue,
    encodedQuantity: parsed.quantityProvided ? parsed.quantity : null,
    validationStatus: parsed.success ? 'VALID' : 'REJECTED',
    validationError: parsed.success ? '' : parsed.reason,
    mrp: parsed.mrp ?? null
  };
}

function applyDecodedBarcode(scan, decoded) {
  if (!decoded.success || !Number.isSafeInteger(decoded.quantity) || decoded.quantity <= 0) {
    throw new Error(decoded.validationError || 'Invalid decoded barcode quantity');
  }
  scan.quantity = scan.qty = decoded.quantity;
  scan.encodedQuantity = decoded.encodedQuantity;
  scan.transactionQuantity = decoded.quantity;
  scan.scanEventCount = 1;
  scan.quantitySource = decoded.encodedQuantity === null ? 'verified-unit-rule' : 'encoded';
  scan.rawScanString = decoded.rawBarcode;
  scan.barcodeMRP = decoded.mrp;
}

module.exports = { decodeBarcode, applyDecodedBarcode };
