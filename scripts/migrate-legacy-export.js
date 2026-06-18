require('dotenv').config();

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { connectDatabase, disconnectDatabase } = require('../services/prisma');
const models = require('../models/registry');

const EXPORT_DIR = path.resolve(process.env.LEGACY_EXPORT_DIR || path.join(__dirname, '..', 'legacy-export'));
const LOG_DIR = path.resolve(__dirname, '..', 'logs');
const BATCH_SIZE = Math.max(1, Math.min(Number(process.env.LEGACY_IMPORT_BATCH_SIZE || 500), 5000));

const COLLECTIONS = [
  { key: 'users', model: models.User, identities: ['username', 'email'] },
  { key: 'dealers', model: models.Dealer, identities: ['dealerCode'] },
  { key: 'audits', model: models.Audit, identities: ['auditId'] },
  { key: 'bins', model: models.Bin, identities: ['dealerCode', 'binCode'] },
  { key: 'mastercatalogues', model: models.MasterCatalogue, identities: ['normalizedPartNumber', 'partNumber'] },
  { key: 'masterparts', model: models.MasterPart, identities: ['dealerCode', 'normalizedPartNumber', 'partNumber', 'partNo'] },
  { key: 'partpricehistories', model: models.PartPriceHistory, identities: ['normalizedPartNumber', 'partNumber', 'mrp', 'effectiveFrom', 'effectiveTo'] },
  { key: 'inventories', model: models.Inventory, identities: ['uniqueScanId', 'scanId'] },
  { key: 'reportsnapshots', model: models.ReportSnapshot, identities: ['reportId', 'dealerCode', 'auditId', 'reportType'] },
  { key: 'dealer_stock_master', model: models.DealerStock, identities: ['dealerCode', 'auditId', 'normalizedPartNumber', 'partNumber'] },
  { key: 'verificationlogs', model: models.VerificationLog, identities: ['dealerCode', 'auditId', 'partNumber', 'time'] },
  { key: 'duplicatescanlogs', model: models.DuplicateScanLog, identities: ['uniqueScanId', 'scanId'] },
  { key: 'deletedscanlogs', model: models.DeletedScanLog, identities: ['scanId', 'deletedTime', 'dateDeleted'] },
  { key: 'rejectedscans', model: models.RejectedScan, identities: ['dealerCode', 'rawScannedValue', 'extractedPartNumber', 'dateTime'] },
  { key: 'settings', model: models.Setting, identities: ['key'] },
  { key: 'devices', model: models.Device, identities: ['deviceId'] },
  { key: 'bluetoothdevices', model: models.BluetoothDevice, identities: ['deviceId'] },
  { key: 'bluetoothscanlogs', model: models.BluetoothScanLog, identities: ['deviceId', 'scanTime', 'rawBarcode'] },
  { key: 'scannerlogs', model: models.ScannerLog, identities: ['deviceId', 'createdAt', 'message'] },
  { key: 'scannersessions', model: models.ScannerSession, identities: ['sessionId', 'deviceId'] },
  { key: 'bintransferhistories', model: models.BinTransferHistory, identities: ['transferId', 'dealerCode', 'partNumber', 'createdAt'] },
  { key: 'binlabelprintlogs', model: models.BinLabelPrintLog, identities: ['dealerCode', 'binCode', 'createdAt'] },
  { key: 'synclogs', model: models.SyncLog, identities: ['syncBatchId', 'deviceId', 'createdAt'] },
  { key: 'auditlogs', model: models.AuditLog, identities: ['dealerCode', 'auditId', 'createdAt'] },
  { key: 'auditrestorelogs', model: models.AuditRestoreLog, identities: ['archiveId', 'dealerCode', 'createdAt'] },
  { key: 'offlinequeues', model: models.OfflineQueue, identities: ['queueId', 'deviceId', 'createdAt'] },
  { key: 'skewevents', model: models.SkewEvent, identities: ['deviceId', 'createdAt'] }
];

function cleanId(value) {
  if (!value) return '';
  if (typeof value === 'object' && value.$oid) return String(value.$oid);
  return String(value);
}

function cleanDocument(input = {}) {
  const doc = { ...input };
  const id = cleanId(doc._id || doc.id);
  if (id) {
    doc._id = id;
    doc.id = id;
  }
  delete doc.__v;
  return doc;
}

function identityFilter(doc, identities = []) {
  const filter = {};
  for (const field of identities) {
    const value = doc[field];
    if (value !== undefined && value !== null && String(value).trim() !== '') filter[field] = value;
  }
  if (Object.keys(filter).length) return filter;
  return doc._id ? { _id: doc._id } : null;
}

async function readCollectionFile(key) {
  const candidates = [
    path.join(EXPORT_DIR, `${key}.json`),
    path.join(EXPORT_DIR, `${key}.ndjson`)
  ];
  const filePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!filePath) return { filePath: '', rows: [] };
  const text = await fsp.readFile(filePath, 'utf8');
  if (/\.ndjson$/i.test(filePath)) {
    return {
      filePath,
      rows: text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))
    };
  }
  const parsed = JSON.parse(text);
  return { filePath, rows: Array.isArray(parsed) ? parsed : [] };
}

async function countImported(Model, ids) {
  const cleanIds = Array.from(new Set(ids.filter(Boolean)));
  let count = 0;
  for (let index = 0; index < cleanIds.length; index += BATCH_SIZE) {
    const chunk = cleanIds.slice(index, index + BATCH_SIZE);
    count += await Model.countDocuments({ _id: { $in: chunk } });
  }
  return count;
}

async function importCollection(config) {
  const { filePath, rows } = await readCollectionFile(config.key);
  const summary = {
    collection: config.key,
    filePath,
    sourceCount: rows.length,
    importedCount: 0,
    verifiedCount: 0,
    skippedCount: 0,
    errors: []
  };
  const importedIds = [];

  for (const raw of rows) {
    const doc = cleanDocument(raw);
    const filter = identityFilter(doc, config.identities);
    if (!filter) {
      summary.skippedCount += 1;
      continue;
    }
    try {
      const saved = await config.model.findOneAndUpdate(filter, doc, { upsert: true, new: true, setDefaultsOnInsert: false }).lean();
      summary.importedCount += 1;
      if (saved && saved._id) importedIds.push(saved._id);
    } catch (error) {
      summary.errors.push({ id: doc._id || '', message: error.message });
    }
  }

  summary.verifiedCount = await countImported(config.model, importedIds);
  summary.ok = summary.sourceCount === 0 || (summary.importedCount > 0 && summary.verifiedCount === importedIds.length && summary.errors.length === 0);
  return summary;
}

async function main() {
  await fsp.mkdir(LOG_DIR, { recursive: true });
  await connectDatabase();
  const startedAt = new Date();
  const summaries = [];

  for (const config of COLLECTIONS) {
    const summary = await importCollection(config);
    summaries.push(summary);
    process.stdout.write(`${summary.collection}: source=${summary.sourceCount} imported=${summary.importedCount} verified=${summary.verifiedCount} errors=${summary.errors.length}\n`);
  }

  const finishedAt = new Date();
  const report = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    exportDir: EXPORT_DIR,
    database: 'railway-postgresql',
    success: summaries.every((summary) => summary.ok),
    summaries
  };
  const stamp = finishedAt.toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(LOG_DIR, `legacy-import-verification-${stamp}.json`);
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`Verification summary: ${reportPath}\n`);
  if (!report.success) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectDatabase().catch(() => undefined);
  });
