const fs = require('fs');
const express = require('express');
const multer = require('multer');
const MasterCatalogue = require('../models/MasterCatalogue');
const PartPriceHistory = require('../models/PartPriceHistory');
const Inventory = require('../models/Inventory');
const auth = require('./auth');
const { cleanText, normalizePartNumber } = require('../utils/normalize');
const { cataloguePayload } = require('../utils/catalogue');
const { applyCacheHeaders, getCachedResponse, invalidateCache } = require('../utils/safeCache');
const {
  MAX_UPLOAD_BYTES,
  appendUploadLog,
  catalogueFieldReference,
  createCatalogueTemplateWorkbook,
  failureFilePath,
  importCatalogue,
  purgeFailureFiles
} = require('../utils/catalogueUpload');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter(req, file, callback) {
    const name = cleanText(file && file.originalname).toLowerCase();
    if (/\.(xlsx|xls|csv)$/.test(name)) return callback(null, true);
    const error = new Error('Only .xlsx, .xls, and .csv catalogue files are supported');
    error.statusCode = 400;
    return callback(error);
  }
});

function uploadCatalogueFile(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) return next();
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : Number(error.statusCode || 400);
    return res.status(status).json({ success: false, message: error.message });
  });
}

function nonVerificationScanClause() {
  return { $nor: [{ scanType: 'VERIFICATION' }, { type: 'VERIFICATION' }] };
}

function prepareLongUpload(req, res) {
  if (typeof req.setTimeout === 'function') req.setTimeout(0);
  if (typeof res.setTimeout === 'function') res.setTimeout(0);
}

function emitCatalogueUploadProgress(io, uploadId, progress = {}) {
  const id = cleanText(uploadId);
  if (!io || !id) return;
  io.emit('catalogue:upload:progress', { uploadId: id, ...progress });
}

async function sendCachedJson(res, namespace, query, builder, options = {}) {
  const result = await getCachedResponse(namespace, query, builder, options);
  applyCacheHeaders(res, result);
  return res.json(result.data);
}

function invalidateCatalogueCaches(scope = {}) {
  invalidateCache({
    tags: ['catalogue', 'master', 'search', 'report', 'dashboard', 'dealer', 'bin', 'audit'],
    scope
  });
}

async function uploadErrorResponse(res, error, sourceFileName = '', extra = {}) {
  console.error('Master catalogue upload failed:', error);
  await appendUploadLog({
    event: 'catalogue-upload-error',
    sourceFileName,
    message: error.message,
    code: error.code || '',
    missingColumns: error.missingColumns || [],
    duplicateColumns: error.duplicateColumns || []
  });
  return res.status(Number(error.statusCode || 500)).json({
    success: false,
    message: error.message,
    missingColumns: error.missingColumns || undefined,
    duplicateColumns: error.duplicateColumns || undefined,
    ...extra
  });
}

router.post('/upload', auth.requireAuth, auth.requireAdmin, uploadCatalogueFile, async (req, res) => {
  prepareLongUpload(req, res);
  const uploadId = cleanText(req.body && req.body.uploadId);
  const emitProgress = (progress = {}) => emitCatalogueUploadProgress(req.io, uploadId, progress);
  try {
    emitProgress({
      stage: 'received',
      percent: 0,
      message: 'File received. Preparing upload...'
    });
    const result = await importCatalogue(req.file, { onProgress: emitProgress });
    emitProgress({
      stage: 'completed',
      percent: 100,
      message: 'Upload completed',
      ...result
    });
    req.io?.emit('master:update');
    invalidateCatalogueCaches();
    return res.json({ success: true, uploadId, ...result });
  } catch (error) {
    emitProgress({
      stage: 'error',
      percent: 100,
      message: error.message || 'Upload failed'
    });
    return uploadErrorResponse(res, error, req.file && req.file.originalname);
  }
});

router.get('/required-columns', auth.requireAuth, (_req, res) => {
  return res.json({
    success: true,
    columns: catalogueFieldReference(),
    message: 'Download the template first, then keep the first row as headers. The template uses the latest accepted master format.'
  });
});

router.get('/template', auth.requireAuth, auth.requireAdmin, async (_req, res) => {
  try {
    const workbook = await createCatalogueTemplateWorkbook();
    const buffer = await workbook.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Part_Master_Catalogue_Template.xlsx"');
    return res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('Catalogue template generation failed:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/upload-failures/:downloadId', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  const file = failureFilePath(req.params.downloadId);
  if (!file || !fs.existsSync(file)) {
    return res.status(404).json({ success: false, message: 'Failed-row workbook has expired or does not exist' });
  }
  return res.download(file, 'Master_Catalogue_Failed_Rows.xlsx');
});

router.delete('/', auth.requireAuth, auth.requireAdmin, async (req, res) => {
  try {
    const [result, priceResult] = await Promise.all([
      MasterCatalogue.deleteMany({}),
      PartPriceHistory.deleteMany({})
    ]);
    await purgeFailureFiles();
    req.io?.emit('master:update');
    invalidateCatalogueCaches();
    return res.json({
      success: true,
      deletedOldRowsCount: result.deletedCount || 0,
      deletedPriceHistoryRowsCount: priceResult.deletedCount || 0,
      currentMasterRecordCount: 0,
      masterCatalogueCount: 0
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/delete-and-reupload', auth.requireAuth, auth.requireAdmin, uploadCatalogueFile, async (req, res) => {
  prepareLongUpload(req, res);
  const uploadId = cleanText(req.body && req.body.uploadId);
  const emitProgress = (progress = {}) => emitCatalogueUploadProgress(req.io, uploadId, progress);
  let deletedOldRowsCount = 0;
  let deletedPriceHistoryRowsCount = 0;
  try {
    emitProgress({
      stage: 'deleting-old-catalogue',
      percent: 0,
      message: 'Deleting old catalogue...'
    });
    const [deletedRows, deletedPriceRows] = await Promise.all([
      MasterCatalogue.deleteMany({}),
      PartPriceHistory.deleteMany({})
    ]);
    deletedOldRowsCount = deletedRows.deletedCount || 0;
    deletedPriceHistoryRowsCount = deletedPriceRows.deletedCount || 0;
    await purgeFailureFiles();
    emitProgress({
      stage: 'deleted-old-catalogue',
      percent: 35,
      deletedOldRowsCount,
      deletedPriceHistoryRowsCount,
      message: `Old catalogue deleted: ${deletedOldRowsCount} rows`
    });
    const result = await importCatalogue(req.file, { onProgress: emitProgress });
    emitProgress({
      stage: 'completed',
      percent: 100,
      deletedOldRowsCount,
      deletedPriceHistoryRowsCount,
      message: 'Delete and reupload completed',
      ...result
    });
    req.io?.emit('master:update');
    invalidateCatalogueCaches();
    return res.json({
      success: true,
      uploadId,
      deletedOldRowsCount,
      deletedPriceHistoryRowsCount,
      ...result
    });
  } catch (error) {
    emitProgress({
      stage: 'error',
      percent: 100,
      message: error.message || 'Delete and reupload failed'
    });
    return uploadErrorResponse(res, error, req.file && req.file.originalname, {
      deletedOldRowsCount,
      deletedPriceHistoryRowsCount
    });
  }
});

router.get('/search', auth.requireAuth, async (req, res) => {
  try {
    return await sendCachedJson(res, 'search', req.query, async (normalizedQuery) => {
      const q = cleanText(normalizedQuery.q);
      const page = Math.max(Number(normalizedQuery.page || 1), 1);
      const limit = Math.min(Math.max(Number(normalizedQuery.limit || 50), 1), 50);
      const skip = (page - 1) * limit;
      const normalized = normalizePartNumber(q);
      const safeText = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const safePart = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const filter = q ? {
        $or: [
          { partNumber: { $regex: safePart, $options: 'i' } },
          { normalizedPartNumber: { $regex: safePart, $options: 'i' } },
          { partDescription: { $regex: safeText, $options: 'i' } },
          { productCategory: { $regex: safeText, $options: 'i' } },
          { model: { $regex: safeText, $options: 'i' } },
          { year: { $regex: safeText, $options: 'i' } },
          { manufacturingYear: { $regex: safeText, $options: 'i' } },
          { productGroup: { $regex: safeText, $options: 'i' } },
          { partSubGroup: { $regex: safeText, $options: 'i' } },
          { dlc: Number.isFinite(Number(q)) ? Number(q) : -1 }
        ]
      } : { _id: null };
      const [total, records] = await Promise.all([
        MasterCatalogue.countDocuments(filter),
        MasterCatalogue.find(filter).sort({ partNumber: 1 }).skip(skip).limit(limit).lean()
      ]);
      return { success: true, records, parts: records.map(cataloguePayload), page, limit, total, totalPages: Math.ceil(total / limit) };
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/unmatched-parts', auth.requireAuth, async (req, res) => {
  try {
    return await sendCachedJson(res, 'search', req.query, async () => {
      const rows = await Inventory.aggregate([
        { $match: { ...nonVerificationScanClause(), $or: [{ masterMatch: false }, { isMasterMatched: false }, { warnings: /Invalid part number - not found in master catalogue|Part not found in Master Catalogue|Not Found in Master/i }] } },
        { $group: { _id: '$normalizedPartNumber', partNumber: { $first: '$partNumber' }, scanCount: { $sum: 1 }, lastScanTime: { $max: '$timestamp' } } },
        { $sort: { lastScanTime: -1 } }
      ]);
      return { success: true, rows: rows.map((row) => ({ partNumber: row.partNumber || row._id, scanCount: row.scanCount, lastScanTime: row.lastScanTime })) };
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
