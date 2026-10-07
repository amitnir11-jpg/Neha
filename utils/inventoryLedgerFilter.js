const { validScanClause } = require('./masterValidation');

const INVALID_STATES = ['FAILED', 'REJECTED', 'INVALID', 'DUPLICATE', 'DUPLICATE_BLOCKED'];
const invalidStates = INVALID_STATES.flatMap(value => [value, value.toLowerCase()]);

function testInventoryClause() {
  return { $or: [
    { dealerName: /Sync Test/i }, { deviceId: /sync-test/i }, { deviceName: /sync-test/i },
    { rawUpi: /SYNCPT|scan test/i }, { rawScan: /SYNCPT|scan test/i }, { rawScanString: /SYNCPT|scan test/i },
    { staffName: /sync test|test sync/i }, { partName: /Sync Test/i }, { partDescription: /Sync Test/i }
  ] };
}

function applyInventoryLedgerFilter(input = {}, mode = 'real') {
  const filter = { ...input };
  // Transport acknowledgements are not stock validity. Persisted accepted scans
  // remain valid with pending/missing sync flags; explicit failures are excluded.
  if (filter.syncStatus === 'synced') delete filter.syncStatus;
  const clauses = [
    validScanClause(),
    { isDeleted: { $ne: true }, deletedAt: null, isArchived: { $ne: true }, archivedAt: null, isDuplicate: { $ne: true } },
    { scanStatus: { $nin: invalidStates }, syncStatus: { $nin: invalidStates }, status: { $nin: invalidStates } },
    { $nor: [{ scanType: 'VERIFICATION' }, { type: 'VERIFICATION' }, { scanType: 'LOCAL_PART' }, { isLocalPart: true }] }
  ];
  if (mode !== 'all') clauses.push(mode === 'test' ? testInventoryClause() : { $nor: testInventoryClause().$or });
  filter.$and = (filter.$and || []).concat(clauses);
  return filter;
}

module.exports = { applyInventoryLedgerFilter, testInventoryClause, INVALID_STATES };
