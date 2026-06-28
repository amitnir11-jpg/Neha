const { normalizePartNumber } = require('./normalize');

const COUNTED_SCAN_STATUSES = new Set(['ACCEPTED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE']);
const IGNORED_STATUS_PATTERN = /(VOID|CANCEL|CANCELED|CANCELLED|DELETED|REJECTED|FAILED)/i;
const EMPTY_LOCATION_PATTERN = /^(?:NULL|UNDEFINED|N\/A|NA|-)?$/i;

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function normalizeBinLocation(value) {
  const text = upper(value);
  return EMPTY_LOCATION_PATTERN.test(text) ? '' : text;
}

function scanMoment(scan = {}) {
  const value = scan.timestamp || scan.scanTime || scan.createdAt || scan.updatedAt || scan.time || scan.dateTime || 0;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function actorName(scan = {}) {
  return clean(
    scan.smartBinDecisionBy ||
    scan.lastScannedBy ||
    scan.userName ||
    scan.staffName ||
    scan.loginId ||
    scan.username ||
    scan.userId ||
    scan.deviceName ||
    ''
  );
}

function reasonText(scan = {}) {
  return clean(
    scan.smartBinReason ||
    scan.smartBinDecisionReason ||
    scan.reason ||
    scan.remarks ||
    scan.comment ||
    scan.comments ||
    ''
  );
}

function scanType(scan = {}) {
  return upper(scan.scanType || scan.type || scan.movementType || 'INWARD');
}

function movementQty(scan = {}) {
  const rawQty = scan.qty !== undefined && scan.qty !== null && scan.qty !== ''
    ? scan.qty
    : scan.quantity;
  const qty = Math.abs(Number(rawQty || 0));
  const type = scanType(scan);
  if (type === 'VERIFICATION') return 0;
  if (type === 'INWARD' || type === 'AUDIT') return qty;
  if (['OUTWARD', 'FITTED', 'DAMAGE'].includes(type)) return -qty;
  return qty;
}

function isIgnoredScan(scan = {}) {
  if (!scan || scan.deletedAt) return true;
  const syncStatus = upper(scan.syncStatus);
  const scanStatus = upper(scan.scanStatus);
  const status = upper(scan.status);
  return [syncStatus, scanStatus, status].some((value) => value && IGNORED_STATUS_PATTERN.test(value));
}

function isCountedScan(scan = {}) {
  if (!scan || isIgnoredScan(scan)) return false;
  const scanStatus = upper(scan.scanStatus);
  const syncStatus = clean(scan.syncStatus).toLowerCase();
  if (scanStatus && COUNTED_SCAN_STATUSES.has(scanStatus)) return true;
  if (syncStatus === 'synced' && !scanStatus && scanType(scan) !== 'VERIFICATION') return true;
  return false;
}

function partKey(scan = {}) {
  return normalizePartNumber(scan.normalizedPartNumber || scan.partNumber || scan.part || '');
}

function binKey(scan = {}) {
  return normalizeBinLocation(scan.binLocation || scan.bin || '');
}

function smartBinSort(a = {}, b = {}) {
  const qtyDiff = Number(b.qty || 0) - Number(a.qty || 0);
  if (qtyDiff) return qtyDiff;
  const timeDiff = Number(b.lastScanMoment || 0) - Number(a.lastScanMoment || 0);
  if (timeDiff) return timeDiff;
  return String(a.binLocation || '').localeCompare(String(b.binLocation || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function buildBinLocationGroups(scans = []) {
  const byBin = new Map();
  scans.forEach((scan) => {
    if (!isCountedScan(scan)) return;
    const partNumber = partKey(scan);
    const binLocation = binKey(scan);
    if (!partNumber || !binLocation) return;
    const qty = movementQty(scan);
    if (!qty) return;
    const key = `${partNumber}::${binLocation}`;
    const lastScanMoment = scanMoment(scan);
    const entry = byBin.get(key) || {
      dealerCode: upper(scan.dealerCode),
      auditId: clean(scan.auditId),
      partNumber,
      partDescription: clean(scan.partDescription || scan.partName || ''),
      binLocation,
      qty: 0,
      lastScanMoment: 0,
      lastScanTime: '',
      lastScannedBy: '',
      reason: ''
    };
    entry.qty += qty;
    if (!entry.partDescription) entry.partDescription = clean(scan.partDescription || scan.partName || '');
    if (lastScanMoment >= entry.lastScanMoment) {
      entry.lastScanMoment = lastScanMoment;
      entry.lastScanTime = lastScanMoment ? new Date(lastScanMoment).toISOString() : '';
      entry.lastScannedBy = actorName(scan) || entry.lastScannedBy;
      entry.reason = reasonText(scan) || entry.reason;
      entry.dealerCode = entry.dealerCode || upper(scan.dealerCode);
      entry.auditId = entry.auditId || clean(scan.auditId);
    }
    byBin.set(key, entry);
  });
  return Array.from(byBin.values())
    .filter((row) => row.qty > 0)
    .sort(smartBinSort);
}

function formatQty(value) {
  const qty = Number(value || 0);
  return Number.isInteger(qty) ? String(qty) : String(Math.round(qty * 1000) / 1000);
}

function buildMultipleBinLocationAlertRows(scans = []) {
  const binGroups = buildBinLocationGroups(scans);
  const byPart = new Map();

  binGroups.forEach((binGroup) => {
    const entry = byPart.get(binGroup.partNumber) || {
      dealerCode: binGroup.dealerCode,
      auditId: binGroup.auditId,
      partNumber: binGroup.partNumber,
      partDescription: binGroup.partDescription || '',
      bins: [],
      totalQty: 0,
      lastScanMoment: 0,
      lastScannedBy: '',
      reasonForMultipleLocation: ''
    };
    entry.bins.push(binGroup);
    entry.totalQty += Number(binGroup.qty || 0);
    if (binGroup.lastScanMoment >= entry.lastScanMoment) {
      entry.lastScanMoment = binGroup.lastScanMoment;
      entry.lastScannedBy = binGroup.lastScannedBy || entry.lastScannedBy;
      entry.reasonForMultipleLocation = binGroup.reason || entry.reasonForMultipleLocation;
    }
    if (!entry.partDescription) entry.partDescription = binGroup.partDescription || '';
    if (!entry.dealerCode) entry.dealerCode = binGroup.dealerCode || '';
    if (!entry.auditId) entry.auditId = binGroup.auditId || '';
    byPart.set(binGroup.partNumber, entry);
  });

  const rows = Array.from(byPart.values())
    .filter((entry) => entry.bins.length > 1)
    .sort((a, b) => String(a.partNumber).localeCompare(String(b.partNumber), undefined, { numeric: true, sensitivity: 'base' }));

  return {
    rows: rows.map((entry) => ({
      dealerCode: entry.dealerCode || '',
      auditId: entry.auditId || '',
      partNumber: entry.partNumber || '',
      partDescription: entry.partDescription || '',
      primaryBin: entry.bins[0] ? entry.bins[0].binLocation : '',
      secondaryBinLocations: entry.bins.slice(1).map((bin) => bin.binLocation).join('\n'),
      primaryBinQty: entry.bins[0] ? formatQty(entry.bins[0].qty) : '',
      secondaryBinQty: entry.bins.slice(1).map((bin) => formatQty(bin.qty)).join('\n'),
      existingBinLocations: entry.bins.map((bin) => bin.binLocation).join('\n'),
      quantityInEachBin: entry.bins.map((bin) => formatQty(bin.qty)).join('\n'),
      locationTypeSummary: entry.bins.map((bin, index) => `${index === 0 ? 'PRIMARY' : 'SECONDARY'}: ${bin.binLocation}`).join('\n'),
      binDetails: entry.bins.map((bin) => `${bin.binLocation} : Qty ${formatQty(bin.qty)}`).join('\n'),
      totalQty: Number(entry.totalQty || 0),
      lastScannedBy: entry.lastScannedBy || '',
      lastScanDateTime: entry.lastScanMoment ? new Date(entry.lastScanMoment).toISOString() : '',
      reasonForMultipleLocation: entry.reasonForMultipleLocation || '',
      multipleBinCount: entry.bins.length
    })),
    summary: {
      multipleBinPartCount: rows.length,
      totalQty: rows.reduce((sum, entry) => sum + Number(entry.totalQty || 0), 0),
      totalBinLocations: rows.reduce((sum, entry) => sum + entry.bins.length, 0)
    }
  };
}

function buildSmartBinSuggestion(scans = [], currentBin = '') {
  const existingBins = buildBinLocationGroups(scans);
  const normalizedCurrentBin = normalizeBinLocation(currentBin);
  const totalQty = existingBins.reduce((sum, row) => sum + Number(row.qty || 0), 0);
  const sameBinExists = Boolean(normalizedCurrentBin && existingBins.some((row) => row.binLocation === normalizedCurrentBin));
  const shouldPrompt = Boolean(existingBins.length && normalizedCurrentBin && !sameBinExists);
  const suggestedBin = existingBins[0] ? existingBins[0].binLocation : normalizedCurrentBin;
  const partNumber = existingBins[0] ? existingBins[0].partNumber : '';
  const dealerCode = existingBins[0] ? existingBins[0].dealerCode : '';
  const auditId = existingBins[0] ? existingBins[0].auditId : '';
  const existingBinText = existingBins.length === 1
    ? existingBins[0].binLocation
    : existingBins.map((row) => row.binLocation).join(', ');
  const message = `PART ${partNumber || '-'} IS AVAILABLE IN ${existingBinText || '-'}\n\nWhat do you want to do?`;

  return {
    shouldPrompt,
    sameBinExists,
    currentBin: normalizedCurrentBin,
    suggestedBin: suggestedBin || normalizedCurrentBin,
    existingBins: existingBins.map((row) => ({
      binLocation: row.binLocation,
      qty: Number(row.qty || 0),
      locationType: row.binLocation === suggestedBin ? 'PRIMARY' : 'SECONDARY',
      lastScanTime: row.lastScanTime || '',
      lastScannedBy: row.lastScannedBy || '',
      partDescription: row.partDescription || ''
    })),
    primaryBin: suggestedBin || normalizedCurrentBin,
    secondaryBins: existingBins.slice(1).map((row) => row.binLocation),
    totalQty,
    existingBinCount: existingBins.length,
    partNumber,
    dealerCode,
    auditId,
    message
  };
}

module.exports = {
  buildBinLocationGroups,
  buildMultipleBinLocationAlertRows,
  buildSmartBinSuggestion,
  formatQty,
  isCountedScan,
  isIgnoredScan,
  movementQty,
  normalizeBinLocation
};
