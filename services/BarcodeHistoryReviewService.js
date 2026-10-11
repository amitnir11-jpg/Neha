const { decodeBarcode } = require('./BarcodeDecoderService');

function reviewBarcodeHistory(records) {
  const result = { discrepancies: [], review: [], syntheticCandidates: [], priceMismatches: [] };
  for (const record of records) {
    const row = { ...record.data, ...record };
    const raw = ['rawDecodedValue', 'rawBarcode', 'rawScanString', 'rawScan', 'rawUpi', 'rawQR']
      .map(key => row[key]).find(value => typeof value === 'string' && value.trim());
    const decoded = decodeBarcode(raw, row.barcodeFormat);
    const stored = row.qty ?? row.quantity;
    const storedValid = stored != null && stored !== '' && Number.isSafeInteger(Number(stored)) && Number(stored) > 0;
    const detail = {
      collection: row.collection || 'inventories', id: row.id || row._id,
      dealer: row.dealerCode, part: row.partNumber || row.part,
      upi: row.upiNo || row.upiId || decoded.upi, bin: row.binLocation || row.bin,
      date: row.timestamp || row.scanTime || row.createdAt, movement: row.scanType || row.type,
      storedQuantity: stored ?? null, expectedQuantity: decoded.encodedQuantity,
      difference: storedValid && decoded.success && decoded.encodedQuantity !== null ? decoded.encodedQuantity - Number(stored) : null,
      rawBarcode: raw || '', format: decoded.manufacturerFormat || decoded.type,
      storedMRP: row.mrp ?? null, barcodeMRP: decoded.mrp,
      excludedFromStock: row.isDeleted === true || Boolean(row.deletedAt) || row.isDuplicate === true
    };
    const fields = String(raw || '').split('/');
    const synthetic = fields[0]?.trim().toUpperCase() === 'D' && fields.slice(1, 3).some(field => /^TEST/i.test(field.trim()));
    if (synthetic) result.syntheticCandidates.push({ ...detail, reason: 'TEST identifier candidate; requires administrator review, no stock changed.' });
    if (!decoded.success || decoded.encodedQuantity === null || !storedValid) {
      result.review.push({ ...detail, reason: !raw ? 'Missing original barcode' : !storedValid ? 'Missing or invalid stored quantity' : decoded.validationError || 'No verified encoded quantity; do not infer historical quantity.' });
      continue;
    }
    if (detail.difference !== 0) result.discrepancies.push(detail);
    if (decoded.mrp !== null && row.mrp != null && Number(row.mrp) !== decoded.mrp) {
      result.priceMismatches.push({ ...detail, reason: 'Part Master price is authoritative; barcode mismatch is separate from quantity.' });
    }
  }
  return result;
}

async function writeReviewWorkbook(review, output) {
  // Use the application's existing Excel export dependency. Never write back to the source DB.
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Daksh Inventory';
  for (const [key, name] of [['discrepancies', 'Quantity discrepancies'], ['review', 'Manual review'], ['syntheticCandidates', 'Test record candidates'], ['priceMismatches', 'Price mismatches']]) {
    const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    const fields = ['collection', 'id', 'dealer', 'part', 'upi', 'bin', 'date', 'movement', 'storedQuantity', 'expectedQuantity', 'difference', 'format', 'excludedFromStock', 'storedMRP', 'barcodeMRP', 'reason', 'rawBarcode'];
    sheet.columns = fields.map(field => ({ header: field, key: field, width: field === 'rawBarcode' ? 80 : field === 'reason' ? 60 : 22 }));
    for (const row of review[key]) sheet.addRow(row);
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17365D' } };
    sheet.autoFilter = { from: 'A1', to: 'Q1' };
  }
  await workbook.xlsx.writeFile(output);
}

module.exports = { reviewBarcodeHistory, writeReviewWorkbook };
