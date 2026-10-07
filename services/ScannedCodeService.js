const { parseScannedCode, normalizeDecodedValue } = require('../utils/scanParser');
const { getPriceFromPartMaster } = require('../utils/partMasterPrice');

async function resolveScannedCode(rawValue, barcodeFormat, dealerCode) {
  const normalizedValue = normalizeDecodedValue(rawValue);
  const directPrice = normalizedValue && normalizedValue.length <= 80
    ? await getPriceFromPartMaster(normalizedValue, dealerCode, { exact: true }) : null;
  const parsed = parseScannedCode(rawValue, barcodeFormat, directPrice ? [normalizedValue] : []);
  if (!parsed.success) return { ...parsed, message: 'Unsupported barcode / Part not found' };
  const price = directPrice || await getPriceFromPartMaster(parsed.partNumber, dealerCode, { exact: true });
  if (!price) return { ...parsed, success: false, reason: 'PART_NOT_FOUND', message: `Part ${parsed.partNumber} not found in Part Master` };
  return { ...parsed, price };
}

module.exports = { resolveScannedCode };
