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
  failureFilePath,
  importCatalogue
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

async function uploadErrorResponse(res, error, sourceFileName = '') {
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
    duplicateColumns: error.duplicateColumns || undefined
  });
}

router.post('/upload', auth.requireAuth, auth.requireAdmin, uploadCatalogueFile, async (req, res) => {
  prepareLongUpload(req, res);
  try {
    const result = await importCatalogue(req.file);
    req.io?.emit('master:update');
    invalidateCatalogueCaches();
    return res.json({ success: true, ...result });
  } catch (error) {
    return uploadErrorResponse(res, error, req.file && req.file.originalname);
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
  try {
    const result = await importCatalogue(req.file, { replaceExisting: true, rejectOnValidationIssues: true });
    if (result.blocked) {
      return res.status(422).json({
        success: false,
        message: 'Old catalogue was not deleted because the uploaded file contains failed or duplicate rows',
        ...result
      });
    }
    req.io?.emit('master:update');
    invalidateCatalogueCaches();
    return res.json({ success: true, ...result });
  } catch (error) {
    return uploadErrorResponse(res, error, req.file && req.file.originalname);
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
        { $match: { ...nonVerificationScanClause(), $or: [{ masterMatch: false }, { isMasterMatched: false }, { warnings: /Part not found in Master Catalogue|Not Found in Master/i }] } },
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
