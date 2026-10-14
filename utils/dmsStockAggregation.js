const { normalizePartNumber } = require('./normalize');

function numeric(value) {
  const number = Number(String(value === undefined || value === null || value === '' ? 0 : value).replace(/,/g, '').trim());
  return Number.isFinite(number) ? number : 0;
}

// DealerStock is normally unique by audit and part number, but older uploads
// can contain more than one persisted row for the same normalized part. Every
// financial report must add those rows instead of silently retaining the last.
function aggregateDealerStockRows(rows = []) {
  const byPart = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const partNumber = normalizePartNumber(row && (row.normalizedPartNumber || row.partNumber || row.partNo || row.part));
    if (!partNumber) continue;
    const current = byPart.get(partNumber);
    const quantity = numeric(row.dmsStock ?? row.systemQty ?? row.qty ?? row.quantity);
    if (!current) {
      byPart.set(partNumber, {
        ...row,
        partNumber,
        normalizedPartNumber: partNumber,
        dmsStock: quantity,
        systemQty: quantity,
        sourceRowCount: 1,
        sourceRowIds: row._id ? [String(row._id)] : []
      });
      continue;
    }
    current.dmsStock += quantity;
    current.systemQty += quantity;
    current.sourceRowCount += 1;
    if (row._id) current.sourceRowIds.push(String(row._id));
  }
  return Array.from(byPart.values());
}

module.exports = { aggregateDealerStockRows };
