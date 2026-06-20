const { createModel } = require('./prismaModel');
const { cleanText, normalizePartNumber } = require('../utils/normalize');
const { canonicalizePartCategory } = require('../utils/categoryResolver');
const { globalUpiKey, rawUpiHash } = require('../utils/scanDuplicatePolicy');

function trim(value) {
  return String(value || '').trim();
}

function upper(value) {
  return trim(value).toUpperCase();
}

function lower(value) {
  return trim(value).toLowerCase();
}

function syncAliases(data, pairs) {
  pairs.forEach(([left, right]) => {
    if ((data[left] === undefined || data[left] === null || data[left] === '') && data[right] !== undefined && data[right] !== null && data[right] !== '') data[left] = data[right];
    if ((data[right] === undefined || data[right] === null || data[right] === '') && data[left] !== undefined && data[left] !== null && data[left] !== '') data[right] = data[left];
  });
}

function uppercaseFields(data, fields) {
  fields.forEach((field) => {
    if (data[field] !== undefined && data[field] !== null && data[field] !== '') data[field] = upper(data[field]);
  });
}

function lowercaseFields(data, fields) {
  fields.forEach((field) => {
    if (data[field] !== undefined && data[field] !== null && data[field] !== '') data[field] = lower(data[field]);
  });
}

function prepareUser(data) {
  lowercaseFields(data, ['username', 'email']);
  syncAliases(data, [['active', 'isActive'], ['passwordHash', 'password'], ['pinHash', 'pin']]);
  if (!data.role) data.role = 'staff';
  if (!data.name) data.name = 'Staff';
  if (data.active === undefined) data.active = true;
  if (data.isActive === undefined) data.isActive = data.active !== false;
  if (data.approved === undefined) data.approved = false;
  if (!data.permissions) {
    data.permissions = {
      canScanInward: true,
      canScanOutward: true,
      canScanFitted: true,
      canScanDamage: true,
      canVerifyParts: true,
      canViewReports: true,
      canDeleteScanData: false,
      canExportExcel: false,
      canManageUsers: false
    };
  }
}

function prepareDealer(data) {
  uppercaseFields(data, ['dealerName', 'dealerCode', 'brand', 'location', 'auditName', 'auditorName', 'generalManager', 'spmName', 'currentAuditId']);
  lowercaseFields(data, ['auditorUsername']);
  if (data.active === undefined) data.active = true;
}

function prepareAudit(data) {
  uppercaseFields(data, ['dealerName', 'dealerCode', 'brand', 'location', 'auditName', 'auditorName', 'generalManager', 'spmName']);
  lowercaseFields(data, ['auditorUsername']);
  if (!data.status) data.status = 'IN_PROGRESS';
  if (!data.auditStatus) data.auditStatus = 'IN_PROGRESS';
}

function prepareBin(data) {
  uppercaseFields(data, ['binCode', 'dealerCode']);
  if (!data.binName && data.binCode) data.binName = data.binCode;
  if (data.active === undefined) data.active = true;
}

function prepareMasterPart(data) {
  syncAliases(data, [['partNumber', 'partNo'], ['partDescription', 'partName'], ['productCategory', 'category'], ['manufacturingYear', 'year'], ['binLocation', 'bin'], ['qty', 'quantity']]);
  const partNo = normalizePartNumber(data.normalizedPartNumber || data.partNumber || data.partNo || '');
  if (partNo) {
    data.partNo = partNo;
    data.partNumber = partNo;
    data.normalizedPartNumber = partNo;
  }
  const category = canonicalizePartCategory(data.productCategory || data.category || '');
  if (category) {
    data.category = category;
    data.productCategory = category;
  }
  if (!data.openingStockQty && (data.quantity || data.qty)) data.openingStockQty = data.quantity || data.qty;
  uppercaseFields(data, ['dealerCode']);
  if (data.activeStatus === undefined) data.activeStatus = true;
}

function prepareMasterCatalogue(data) {
  const partNo = normalizePartNumber(data.normalizedPartNumber || data.partNumber || '');
  if (partNo) {
    data.partNumber = partNo;
    data.normalizedPartNumber = partNo;
  }
  const category = canonicalizePartCategory(data.productCategory || data.category || '');
  if (category) {
    data.category = category;
    data.productCategory = category;
  }
  [
    'partDescription',
    'activeFlag',
    'productCategory',
    'productGroup',
    'model',
    'year',
    'manufacturingYear',
    'productType',
    'superceededBy',
    'partGroup',
    'partSubGroup',
    'gstCategory',
    'splitFlag'
  ].forEach((field) => {
    if (data[field] !== undefined && data[field] !== null) data[field] = cleanText(data[field]).toUpperCase();
  });
  syncAliases(data, [['manufacturingYear', 'year']]);
  if (data.activeStatus === undefined) data.activeStatus = true;
  if (!data.uploadedAt) data.uploadedAt = new Date();
}

function preparePartPriceHistory(data) {
  const partNo = normalizePartNumber(data.normalizedPartNumber || data.partNumber || '');
  if (partNo) {
    data.partNumber = partNo;
    data.normalizedPartNumber = partNo;
  }
  const effectiveTo = data.effectiveTo ? new Date(data.effectiveTo) : null;
  data.isCurrentPrice = !effectiveTo || (!Number.isNaN(effectiveTo.getTime()) && effectiveTo >= new Date());
  if (!data.uploadedAt) data.uploadedAt = new Date();
}

function prepareInventory(data) {
  syncAliases(data, [
    ['uniqueScanId', 'scanId'],
    ['partNumber', 'part'],
    ['partDescription', 'partName'],
    ['productCategory', 'category'],
    ['manufacturingYear', 'year'],
    ['timestamp', 'scanTime'],
    ['upiNo', 'upiId']
  ]);
  if (!data.uniqueScanId) data.uniqueScanId = data.scanId || cryptoRandom();
  if (!data.scanId) data.scanId = data.uniqueScanId;
  const partNo = normalizePartNumber(data.normalizedPartNumber || data.partNumber || data.part || '');
  if (partNo) {
    data.normalizedPartNumber = partNo;
    data.partNumber = partNo;
    data.part = partNo;
  }
  const category = canonicalizePartCategory(data.productCategory || data.category || '');
  if (category) {
    data.category = category;
    data.productCategory = category;
  }
  uppercaseFields(data, [
    'productGroup',
    'productType',
    'superceededBy',
    'partGroup',
    'partSubGroup',
    'gstCategory',
    'bin',
    'binLocation',
    'stockDeductedFromBin',
    'regdNo',
    'jobCardNo',
    'fittedLocation',
    'status',
    'dealerCode',
    'dealerName',
    'staffName',
    'scanType',
    'type'
  ]);
  data.masterMatch = Boolean(data.masterMatch || data.isMasterMatched);
  data.isMasterMatched = Boolean(data.isMasterMatched || data.masterMatch);
  data.masterFound = Boolean(data.masterFound || data.masterMatch || data.isMasterMatched);
  if (!data.timestamp) data.timestamp = new Date();
  if (!data.scanTime) data.scanTime = data.timestamp;
  if (!data.serverReceivedAt) data.serverReceivedAt = new Date();
  if (!data.rawUpi && (data.rawScan || data.rawScanString)) data.rawUpi = data.rawScan || data.rawScanString;
  if (!data.rawBarcode && (data.rawScan || data.rawScanString)) data.rawBarcode = data.rawScan || data.rawScanString;
  if (!data.rawQR && (data.rawScan || data.rawScanString)) data.rawQR = data.rawScan || data.rawScanString;
  if (!data.rawUpiHash) data.rawUpiHash = rawUpiHash(data);
  if (!data.globalUpiKey) data.globalUpiKey = globalUpiKey(data);
  if (!data.scanStatus) data.scanStatus = 'ACCEPTED';
  if (!data.syncStatus) data.syncStatus = 'pending';
  if (data.synced === undefined) data.synced = false;
  if (data.isSynced === undefined) data.isSynced = false;
}

function cryptoRandom() {
  return require('crypto').randomUUID();
}

function prepareDevice(data) {
  if (!data.deviceName) data.deviceName = 'Scanner Device';
  if (!data.deviceType) data.deviceType = 'unknown';
  if (!data.connectionMethod) data.connectionMethod = 'unknown';
  if (!data.status) data.status = 'online';
  if (!data.lastSeen) data.lastSeen = new Date();
  if (data.approved === undefined) data.approved = true;
  uppercaseFields(data, ['dealerCode', 'lastScanPartNumber']);
  lowercaseFields(data, ['role']);
}

function prepareCommonLog(data) {
  uppercaseFields(data, ['dealerCode', 'auditId', 'partNumber', 'normalizedPartNumber', 'bin', 'binLocation', 'scanType', 'type', 'status']);
  if (!data.timestamp && !data.time && !data.dateTime) data.timestamp = new Date();
}

function model(name, delegate, tableName, extra = {}) {
  return createModel({ name, delegate, tableName, ...extra });
}

const inventoryIndexes = [
  [{ globalUpiKey: 1 }, { name: 'global_upi_key_unique', unique: true, partialFilterExpression: { globalUpiKey: { $type: 'string', $gt: '' } } }],
  [{ dealerCode: 1, auditId: 1, upiNo: 1 }, { name: 'dealer_audit_upi_unique', unique: true, partialFilterExpression: { dealerCode: { $type: 'string', $gt: '' }, auditId: { $type: 'string', $gt: '' }, upiNo: { $type: 'string', $gt: '' }, scanStatus: { $in: ['ACCEPTED', 'SUPERVISOR_APPROVED', 'OUTWARD_DONE'] }, syncStatus: 'synced' } }],
  [{ dealerCode: 1, auditId: 1, partNumber: 1 }, { name: 'scan_part_scope_lookup' }],
  [{ dealerCode: 1, auditId: 1, timestamp: -1, createdAt: -1 }, { name: 'scan_history_scope_time' }]
];

const scanIndexes = [
  [{ dealerCode: 1, auditId: 1, partNumber: 1 }, { name: 'scan_part_scope_lookup' }]
];

module.exports = {
  Audit: model('Audit', 'audit', 'audits', { prepare: prepareAudit }),
  AuditLog: model('AuditLog', 'auditLog', 'auditlogs', { prepare: prepareCommonLog }),
  AuditRestoreLog: model('AuditRestoreLog', 'auditRestoreLog', 'auditrestorelogs', { prepare: prepareCommonLog }),
  Bin: model('Bin', 'bin', 'bins', { prepare: prepareBin, indexes: [[{ binCode: 1, dealerCode: 1 }, { unique: true }]] }),
  BinLabelPrintLog: model('BinLabelPrintLog', 'binLabelPrintLog', 'binlabelprintlogs', { prepare: prepareCommonLog }),
  BinTransferHistory: model('BinTransferHistory', 'binTransferHistory', 'bintransferhistories', { prepare: prepareCommonLog }),
  BluetoothDevice: model('BluetoothDevice', 'bluetoothDevice', 'bluetoothdevices', { prepare: prepareDevice }),
  BluetoothScanLog: model('BluetoothScanLog', 'bluetoothScanLog', 'bluetoothscanlogs', { prepare: prepareCommonLog }),
  Dealer: model('Dealer', 'dealer', 'dealers', { prepare: prepareDealer }),
  DealerStock: model('DealerStock', 'dealerStock', 'dealer_stock_master', { prepare: prepareCommonLog }),
  DeletedScanLog: model('DeletedScanLog', 'deletedScanLog', 'deletedscanlogs', { prepare: prepareCommonLog }),
  Device: model('Device', 'device', 'devices', { prepare: prepareDevice }),
  DuplicateScanLog: model('DuplicateScanLog', 'duplicateScanLog', 'duplicatescanlogs', { prepare: prepareCommonLog }),
  FailedScan: model('FailedScan', 'failedScan', 'failedscans', { prepare: prepareCommonLog }),
  Inventory: model('Inventory', 'inventory', 'inventories', { prepare: prepareInventory, indexes: inventoryIndexes }),
  MasterCatalogue: model('MasterCatalogue', 'masterCatalogue', 'mastercatalogues', { prepare: prepareMasterCatalogue }),
  MasterPart: model('MasterPart', 'masterPart', 'masterparts', { prepare: prepareMasterPart }),
  OfflineQueue: model('OfflineQueue', 'offlineQueue', 'offlinequeues', { prepare: prepareCommonLog }),
  PartPriceHistory: model('PartPriceHistory', 'partPriceHistory', 'partpricehistories', { prepare: preparePartPriceHistory }),
  RejectedScan: model('RejectedScan', 'rejectedScan', 'rejectedscans', { prepare: prepareCommonLog }),
  ReportFilterSetting: model('ReportFilterSetting', 'reportFilterSetting', 'reportfiltersettings', { prepare: prepareCommonLog }),
  ReportSnapshot: model('ReportSnapshot', 'reportSnapshot', 'reportsnapshots', { prepare: prepareCommonLog }),
  Scan: model('Scan', 'scan', 'scans', { prepare: prepareInventory, indexes: scanIndexes }),
  ScannerLog: model('ScannerLog', 'scannerLog', 'scannerlogs', { prepare: prepareCommonLog }),
  ScannerSession: model('ScannerSession', 'scannerSession', 'scannersessions', { prepare: prepareCommonLog }),
  Setting: model('Setting', 'setting', 'settings', { prepare: prepareCommonLog }),
  SkewEvent: model('SkewEvent', 'skewEvent', 'skewevents', { prepare: prepareCommonLog }),
  SyncLog: model('SyncLog', 'syncLog', 'synclogs', { prepare: prepareCommonLog }),
  User: model('User', 'user', 'users', { prepare: prepareUser }),
  UserDealerMapping: model('UserDealerMapping', 'userDealerMapping', 'userdealermappings', { prepare: prepareCommonLog }),
  VerificationLog: model('VerificationLog', 'verificationLog', 'verificationlogs', { prepare: prepareCommonLog })
};
