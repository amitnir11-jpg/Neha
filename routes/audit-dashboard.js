/**
 * OPTIMIZED AUDIT DASHBOARD API ROUTES
 * Premium dashboard endpoints with performance optimizations
 * Uses unified calculation engine for consistency
 */

const express = require('express');
const auth = require('./auth');
const UnifiedCalculationEngine = require('../services/UnifiedCalculationEngine');
const Inventory = require('../models/Inventory');
const { applyCacheHeaders, getCachedResponse } = require('../utils/safeCache');

const router = express.Router();

/**
 * Get unified dashboard data (optimized, cached)
 * Single endpoint returning all KPI data
 *
 * Query params:
 * - dealerCode: Filter by dealer
 * - auditId: Filter by audit
 * - category: Filter by category
 * - binLocation: Filter by bin
 * - scanType: Filter by scan type
 * - limit: Number of recent scans (default: 20, max: 100)
 */
router.get('/audit-dashboard/unified', auth.requireAuth, async (req, res) => {
  try {
    return await sendCachedDashboard(res, req.query, async (filters) => {
      const limit = Math.min(Number(filters.limit || 20), 100);

      // Get all stats in parallel
      const [stats, recentScans, filterOptions] = await Promise.all([
        UnifiedCalculationEngine.getUnifiedDashboardStats(filters),
        getDashboardRecentScans(filters, limit),
        getFilterOptions(filters)
      ]);

      return {
        success: true,
        stats,
        recentScans,
        filterOptions,
        timestamp: new Date().toISOString()
      };
    });
  } catch (error) {
    console.error('Error fetching unified dashboard:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Get filter options for dashboard filters
 */
router.get('/audit-dashboard/filter-options', auth.requireAuth, async (req, res) => {
  try {
    const filters = extractFilters(req.query);
    const options = await getFilterOptions(filters);

    return res.json({
      success: true,
      data: options
    });
  } catch (error) {
    console.error('Error fetching filter options:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch filter options' });
  }
});

/**
 * Get KPI cards data only
 */
router.get('/audit-dashboard/kpi', auth.requireAuth, async (req, res) => {
  try {
    const filters = extractFilters(req.query);
    const stats = await UnifiedCalculationEngine.getUnifiedDashboardStats(filters);

    res.json({
      success: true,
      kpi: {
        dmsStockValue: stats.dmsStockValue,
        actualScannedValue: stats.actualScannedValue,
        differenceValue: stats.differenceValue,
        dmsQuantity: stats.dmsQuantity,
        actualQuantity: stats.actualQuantity,
        duplicateCount: stats.duplicateCount,
        shortPartCount: stats.shortPartCount,
        auditCompletion: stats.auditCompletion,
        pendingSync: stats.pendingSync,
        missingDLC: stats.missingDLC
      }
    });
  } catch (error) {
    console.error('Error fetching KPI:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch KPI data' });
  }
});

/**
 * Get recent scans with pagination
 */
router.get('/audit-dashboard/scans', auth.requireAuth, async (req, res) => {
  try {
    const filters = extractFilters(req.query);
    const limit = Math.min(Number(req.query.limit || 20), 100);
    const page = Math.max(Number(req.query.page || 1), 1);

    const scans = await getDashboardRecentScans(filters, limit * page);
    const paginatedScans = scans.slice((page - 1) * limit, page * limit);

    res.json({
      success: true,
      scans: paginatedScans,
      pagination: {
        page,
        limit,
        total: scans.length,
        hasMore: paginatedScans.length === limit
      }
    });
  } catch (error) {
    console.error('Error fetching scans:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch scans' });
  }
});

/**
 * Get part detail (for modal)
 */
router.get('/audit-dashboard/part/:partNumber', auth.requireAuth, async (req, res) => {
  try {
    const partNumber = req.params.partNumber;
    const filters = extractFilters(req.query);

    const part = await Inventory.aggregate([
      {
        $match: {
          partNumber: new RegExp(`^${partNumber}$`, 'i'),
          ...extractFilters(filters)
        }
      },
      {
        $lookup: {
          from: 'mastercatalogues',
          localField: 'partNumber',
          foreignField: 'partNumber',
          as: 'masterData'
        }
      },
      {
        $group: {
          _id: '$partNumber',
          partNumber: { $first: '$partNumber' },
          partDescription: { $first: '$partDescription' },
          category: { $first: '$category' },
          dmsQuantity: { $first: { $ifNull: ['$masterData.0.quantity', 0] } },
          scannedQuantity: {
            $sum: {
              $cond: [
                { $in: ['$scanType', ['INWARD', 'AUDIT']] },
                '$quantity',
                { $multiply: [{ $abs: '$quantity' }, -1] }
              ]
            }
          },
          dmsValue: { $first: { $ifNull: ['$masterData.0.dlcPrice', 0] } },
          scannedValue: { $sum: '$finalInventoryValue' },
          scanHistory: {
            $push: {
              time: '$timestamp',
              type: '$scanType',
              qty: '$quantity',
              bin: '$bin',
              user: '$userId'
            }
          }
        }
      },
      { $limit: 1 }
    ]);

    if (!part.length) {
      return res.status(404).json({ success: false, message: 'Part not found' });
    }

    res.json({
      success: true,
      part: {
        ...part[0],
        difference: part[0].dmsQuantity - part[0].scannedQuantity,
        valueDifference: (part[0].dmsQuantity * part[0].dmsValue) - part[0].scannedValue
      }
    });
  } catch (error) {
    console.error('Error fetching part details:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch part details' });
  }
});

/**
 * Get alerts detail (duplicates, short parts, etc)
 */
router.get('/audit-dashboard/alerts/:type', auth.requireAuth, async (req, res) => {
  try {
    const alertType = req.params.type;
    const filters = extractFilters(req.query);
    const limit = Math.min(Number(req.query.limit || 50), 200);

    let query;
    switch (alertType) {
      case 'duplicates':
        query = await getDuplicateScans(filters, limit);
        break;
      case 'short-parts':
        query = await getShortParts(filters, limit);
        break;
      case 'pending-sync':
        query = await getPendingSyncScans(filters, limit);
        break;
      case 'missing-dlc':
        query = await getMissingDLCParts(filters, limit);
        break;
      default:
        return res.status(400).json({ success: false, message: 'Invalid alert type' });
    }

    res.json({
      success: true,
      type: alertType,
      count: query.length,
      items: query
    });
  } catch (error) {
    console.error('Error fetching alert details:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch alert details' });
  }
});

/* ============================================================================
   HELPER FUNCTIONS
   ============================================================================ */

/**
 * Send cached dashboard response
 */
async function sendCachedDashboard(res, query, builder) {
  const result = await getCachedResponse('audit-dashboard', query, builder, {
    ttl: 30 // Cache for 30 seconds
  });
  applyCacheHeaders(res, result);
  return res.json(result.data);
}

/**
 * Extract and validate filters
 */
function extractFilters(query) {
  return {
    dealerCode: query.dealerCode || '',
    auditId: query.auditId || '',
    category: query.category || '',
    binLocation: query.binLocation || '',
    scanType: query.scanType || '',
    partNumber: query.partNumber || '',
    dateFrom: query.dateFrom || '',
    dateTo: query.dateTo || ''
  };
}

/**
 * Get recent scans with master data
 */
async function getDashboardRecentScans(filters, limit) {
  try {
    const match = {
      ...buildDashboardMatch(filters),
      scanStatus: { $in: ['valid', 'verification', 'duplicate', 'outward', 'synced'] }
    };

    const scans = await Inventory.aggregate([
      { $match: match },
      { $sort: { timestamp: -1, _id: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'mastercatalogues',
          localField: 'partNumber',
          foreignField: 'partNumber',
          as: 'masterData'
        }
      },
      {
        $project: {
          _id: 1,
          timestamp: 1,
          partNumber: 1,
          partDescription: 1,
          category: 1,
          bin: { $ifNull: ['$binLocation', '$bin'] },
          scanType: 1,
          scanStatus: 1,
          userId: 1,
          quantity: 1,
          finalInventoryValue: 1,
          dlcPrice: { $ifNull: ['$masterData.0.dlcPrice', 0] },
          synced: 1
        }
      }
    ]);

    return scans;
  } catch (error) {
    console.error('Error getting recent scans:', error);
    return [];
  }
}

/**
 * Get filter options
 */
async function getFilterOptions(filters) {
  try {
    const match = buildDashboardMatch(filters);

    const [categories, bins, scanTypes] = await Promise.all([
      Inventory.distinct('category', match),
      Inventory.distinct('binLocation', { ...match, binLocation: { $nin: [null, ''] } }),
      Inventory.distinct('scanType', match)
    ]);

    return {
      categories: categories.filter(Boolean).sort(),
      bins: bins.filter(Boolean).sort(),
      scanTypes: (scanTypes || []).filter(Boolean)
    };
  } catch (error) {
    console.error('Error getting filter options:', error);
    return { categories: [], bins: [], scanTypes: [] };
  }
}

/**
 * Get duplicate scans
 */
async function getDuplicateScans(filters, limit) {
  try {
    const pipeline = [
      { $match: buildDashboardMatch(filters) },
      {
        $group: {
          _id: '$qrFingerprint',
          count: { $sum: 1 },
          scans: { $push: { partNumber: '$partNumber', time: '$timestamp', user: '$userId' } }
        }
      },
      {
        $match: { count: { $gt: 1 } }
      },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          duplicateGroup: '$_id',
          count: 1,
          scans: 1
        }
      }
    ];

    return await Inventory.aggregate(pipeline);
  } catch (error) {
    console.error('Error getting duplicates:', error);
    return [];
  }
}

/**
 * Get short parts
 */
async function getShortParts(filters, limit) {
  try {
    const pipeline = [
      { $match: buildDashboardMatch(filters) },
      {
        $lookup: {
          from: 'mastercatalogues',
          localField: 'partNumber',
          foreignField: 'partNumber',
          as: 'masterData'
        }
      },
      {
        $group: {
          _id: '$partNumber',
          partDescription: { $first: '$partDescription' },
          dmsQuantity: { $first: { $ifNull: ['$masterData.0.quantity', 0] } },
          scannedQuantity: {
            $sum: {
              $cond: [
                { $in: ['$scanType', ['INWARD', 'AUDIT']] },
                '$quantity',
                { $multiply: [{ $abs: '$quantity' }, -1] }
              ]
            }
          }
        }
      },
      {
        $match: {
          $expr: { $gt: ['$dmsQuantity', '$scannedQuantity'] }
        }
      },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          partNumber: '$_id',
          description: '$partDescription',
          dmsQty: '$dmsQuantity',
          scannedQty: '$scannedQuantity',
          shortQty: { $subtract: ['$dmsQuantity', '$scannedQuantity'] }
        }
      }
    ];

    return await Inventory.aggregate(pipeline);
  } catch (error) {
    console.error('Error getting short parts:', error);
    return [];
  }
}

/**
 * Get pending sync scans
 */
async function getPendingSyncScans(filters, limit) {
  try {
    const scans = await Inventory.find({
      ...buildDashboardMatch(filters),
      synced: false
    })
      .select('timestamp partNumber bin scanType userId quantity')
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    return scans;
  } catch (error) {
    console.error('Error getting pending sync:', error);
    return [];
  }
}

/**
 * Get missing DLC parts
 */
async function getMissingDLCParts(filters, limit) {
  try {
    const pipeline = [
      { $match: buildDashboardMatch(filters) },
      {
        $lookup: {
          from: 'mastercatalogues',
          localField: 'partNumber',
          foreignField: 'partNumber',
          as: 'masterData'
        }
      },
      {
        $match: {
          $or: [
            { masterData: [] },
            { 'masterData.0.dlcPrice': { $in: [null, 0, undefined] } }
          ]
        }
      },
      { $limit: limit },
      {
        $project: {
          _id: 0,
          partNumber: 1,
          partDescription: 1,
          timestamp: 1,
          userId: 1,
          hasData: { $ne: ['$masterData', []] }
        }
      }
    ];

    return await Inventory.aggregate(pipeline);
  } catch (error) {
    console.error('Error getting missing DLC:', error);
    return [];
  }
}

/**
 * Build MongoDB match query
 */
function buildDashboardMatch(filters) {
  const match = { isDeleted: { $ne: true }, deletedAt: null };

  if (filters.dealerCode) match.dealerCode = filters.dealerCode;
  if (filters.auditId) match.auditId = filters.auditId;
  if (filters.category) match.category = filters.category;
  if (filters.binLocation) match.binLocation = filters.binLocation;
  if (filters.scanType) match.scanType = filters.scanType;
  if (filters.partNumber) match.partNumber = new RegExp(filters.partNumber, 'i');

  if (filters.dateFrom || filters.dateTo) {
    const dateMatch = {};
    if (filters.dateFrom) dateMatch.$gte = new Date(filters.dateFrom);
    if (filters.dateTo) {
      const dateTo = new Date(filters.dateTo);
      dateTo.setHours(23, 59, 59, 999);
      dateMatch.$lte = dateTo;
    }
    match.timestamp = dateMatch;
  }

  return match;
}

module.exports = router;
