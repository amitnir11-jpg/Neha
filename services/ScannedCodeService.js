const { normalizeDecodedValue } = require('../utils/scanParser');
const { decodeBarcode } = require('./BarcodeDecoderService');
const { getPriceFromPartMaster } = require('../utils/partMasterPrice');

async function resolveScannedCode(rawValue, barcodeFormat, dealerCode) {
  const normalizedValue = normalizeDecodedValue(rawValue);
  const raw = String(rawValue === undefined || rawValue === null ? '' : rawValue);
  const directPrice = normalizedValue && normalizedValue.length <= 80
    ? await getPriceFromPartMaster(normalizedValue, dealerCode, { exact: true }) : null;
  const parsed = decodeBarcode(rawValue, barcodeFormat);
  if (!parsed.success) {
    const reason = parsed.reason === 'EMPTY_SCAN' ? 'Barcode is empty.' : `Barcode rejected: ${parsed.validationError}. Manual review required.`;
    return { ...parsed, rawValue: raw, reason, failureReason: reason, message: `Raw barcode: ${raw || '(empty)'}. Reason: ${reason}` };
  }
  const price = directPrice || await getPriceFromPartMaster(parsed.partNumber, dealerCode, { exact: true });
  if (!price) {
    const reason = `Part ${parsed.partNumber} not found in Part Master for dealer ${dealerCode || '(unknown)'}.`;
    return { ...parsed, success: false, reason: 'PART_NOT_FOUND', failureReason: reason,
      message: `Raw barcode: ${raw || '(empty)'}. Reason: ${reason}` };
  }
  return { ...parsed, price, pricingRule: 'PART_MASTER_MRP_DLC',
    priceMismatch: parsed.mrp !== null && Number(price.mrp) !== parsed.mrp };
}

module.exports = { resolveScannedCode };
