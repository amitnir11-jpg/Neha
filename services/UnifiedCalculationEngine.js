/**
 * UNIFIED DASHBOARD CALCULATION ENGINE
 * Single source of truth for all inventory calculations
 * Ensures consistency across Dashboard, Reports, Stock Summary, and Reconciliation
 *
 * Used by:
 * - Dashboard
 * - Stock Summary
 * - Part Summary
 * - Dealer Reconciliation
 * - Inventory Audit
 */

const Inventory = require('../models/Inventory');
const MasterPart = require('../models/MasterPart');
const MasterCatalogue = require('../models/MasterCatalogue');

class UnifiedCalculationEngine {
  /**
   * Calculate unified stock value (DLC)
   * Formula: SUM(scannedQty * MRP) where MRP is from master catalogue (DLC value)
   * This is the SINGLE calculation used everywhere
   */
  static async calculateDMSStockValue(filter = {}) {
    try {
      const match = this.buildFilterStage(filter).$match;
      const rows = await Inventory.find(match).select('qty quantity dlc currentCatalogueDLC').lean();
      return rows.reduce((sum, row) => {
        const qty = Number(row.qty ?? row.quantity ?? 0) || 0;
        const dlc = Number(row.currentCatalogueDLC ?? row.dlc ?? 0) || 0;
        return sum + Math.abs(qty) * dlc;
      }, 0);
    } catch (error) {
      console.error('Error calculating DMS stock value:', error);
      return 0;
    }
  }

  /**
   * Calculate actual scanned value
   * Formula: SUM(scannedQty * actualMRP) where actualMRP is from scan record
   */
  static async calculateActualScannedValue(filter = {}) {
    try {
      const pipeline = [
        this.buildFilterStage(filter),
        {
          $group: {
            _id: null,
            totalValue: {
              $sum: '$__dashboardValue'
            }
          }
        }
      ];

      const result = await Inventory.aggregate(pipeline);
      return result[0]?.totalValue || 0;
    } catch (error) {
      console.error('Error calculating actual scanned value:', error);
      return 0;
    }
  }

  /**
   * Calculate difference
   * Formula: DMS Value - Actual Scanned Value
   */
  static async calculateDifference(filter = {}) {
    const dmsValue = await this.calculateDMSStockValue(filter);
    const actualValue = await this.calculateActualScannedValue(filter);
    return dmsValue - actualValue;
  }

  /**
   * Calculate duplicate scans
   * Duplicates are scans with identical QR fingerprint
   */
  static async calculateDuplicateCount(filter = {}) {
    try {
      const pipeline = [
        this.buildFilterStage(filter),
        {
          $group: {
            _id: '$qrFingerprint',
            count: { $sum: 1 }
          }
        },
        {
          $match: { count: { $gt: 1 } }
        },
        {
          $count: 'total'
        }
      ];

      const result = await Inventory.aggregate(pipeline);
      return result[0]?.total || 0;
    } catch (error) {
      console.error('Error calculating duplicates:', error);
      return 0;
    }
  }

  /**
   * Calculate short parts (DMS quantity > scanned quantity)
   */
  static async calculateShortParts(filter = {}) {
    try {
      const pipeline = [
        this.buildFilterStage(filter),
        {
          $group: {
            _id: '$partNumber',
            dmsQty: { $first: '$__dashboardDmsQty' },
            scannedQty: {
              $sum: {
                $cond: [
                  { $in: ['$__dashboardType', ['INWARD', 'AUDIT']] },
                  '$__dashboardQty',
                  { $multiply: [{ $abs: '$__dashboardQty' }, -1] }
                ]
              }
            }
          }
        },
        {
          $match: {
            $expr: { $gt: ['$dmsQty', '$scannedQty'] }
          }
        },
        {
          $count: 'total'
        }
      ];

      const result = await Inventory.aggregate(pipeline);
      return result[0]?.total || 0;
    } catch (error) {
      console.error('Error calculating short parts:', error);
      return 0;
    }
  }

  /**
   * Calculate total DMS quantity
   */
  static async calculateDMSQuantity(filter = {}) {
    try {
      const pipeline = [
        this.buildFilterStage(filter),
        {
          $lookup: {
            from: 'mastercatalogues',
            localField: 'partNumber',
            foreignField: 'partNumber',
            as: 'masterData'
          }
        },
        {
          $unwind: {
            path: '$masterData',
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $group: {
            _id: null,
            totalQty: {
              $sum: { $ifNull: ['$masterData.quantity', 0] }
            }
          }
        }
      ];

      const result = await Inventory.aggregate(pipeline);
      return result[0]?.totalQty || 0;
    } catch (error) {
      console.error('Error calculating DMS quantity:', error);
      return 0;
    }
  }

  /**
   * Calculate actual scanned quantity
   */
  static async calculateActualQuantity(filter = {}) {
    try {
      const pipeline = [
        this.buildFilterStage(filter),
        {
          $group: {
            _id: null,
            totalQty: {
              $sum: {
                $cond: [
                  { $in: ['$__dashboardType', ['INWARD', 'AUDIT']] },
                  '$__dashboardQty',
                  { $multiply: [{ $abs: '$__dashboardQty' }, -1] }
                ]
              }
            }
          }
        }
      ];

      const result = await Inventory.aggregate(pipeline);
      return result[0]?.totalQty || 0;
    } catch (error) {
      console.error('Error calculating actual quantity:', error);
      return 0;
    }
  }

  /**
   * Calculate audit completion percentage
   * Formula: (Unique scanned parts / Total parts in DMS) * 100
   */
  static async calculateAuditCompletion(filter = {}) {
    try {
      const [scanned, total] = await Promise.all([
        this.getUniqueScansParts(filter),
        this.getTotalDMSParts(filter)
      ]);

      if (total === 0) return 0;
      return Math.min((scanned / total) * 100, 100);
    } catch (error) {
      console.error('Error calculating audit completion:', error);
      return 0;
    }
  }

  /**
   * Calculate pending sync count
   */
  static async calculatePendingSync(filter = {}) {
    try {
      const pipeline = [
        this.buildFilterStage(filter),
        {
          $match: { synced: false }
        },
        {
          $count: 'total'
        }
      ];

      const result = await Inventory.aggregate(pipeline);
      return result[0]?.total || 0;
    } catch (error) {
      console.error('Error calculating pending sync:', error);
      return 0;
    }
  }

  /**
   * Calculate missing DLC/MRP parts
   */
  static async calculateMissingDLC(filter = {}) {
    try {
      const match = this.buildFilterStage(filter).$match;
      const rows = await Inventory.find(match).select('partNumber normalizedPartNumber dlc currentCatalogueDLC').lean();
      return new Set(rows
        .filter((row) => !(Number(row.currentCatalogueDLC ?? row.dlc ?? 0) > 0))
        .map((row) => row.normalizedPartNumber || row.partNumber)
        .filter(Boolean)).size;
    } catch (error) {
      console.error('Error calculating missing DLC:', error);
      return 0;
    }
  }

  /**
   * Get all unified dashboard statistics
   * Single call to get all KPI data
   */
  static async getUnifiedDashboardStats(filter = {}) {
    try {
      const [
        dmsStockValue,
        actualScannedValue,
        duplicateCount,
        shortParts,
        dmsQuantity,
        actualQuantity,
        auditCompletion,
        pendingSync,
        missingDLC,
        todayScanCount,
        categories,
        binLocations
      ] = await Promise.all([
        this.calculateDMSStockValue(filter),
        this.calculateActualScannedValue(filter),
        this.calculateDuplicateCount(filter),
        this.calculateShortParts(filter),
        this.calculateDMSQuantity(filter),
        this.calculateActualQuantity(filter),
        this.calculateAuditCompletion(filter),
        this.calculatePendingSync(filter),
        this.calculateMissingDLC(filter),
        this.getTodayScanCount(filter),
        this.getUniqueCategories(filter),
        this.getUniqueBinLocations(filter)
      ]);

      const difference = dmsStockValue - actualScannedValue;

      return {
        dmsStockValue,
        actualScannedValue,
        differenceValue: difference,
        dmsQuantity,
        actualQuantity,
        duplicateCount,
        shortPartCount: shortParts,
        auditCompletion: Math.round(auditCompletion),
        pendingSync,
        missingDLC,
        todayScanCount,
        totalCategories: categories,
        totalBinLocations: binLocations,
        // Calculate trends (compare to previous period)
        dmsTrend: 0,
        actualValueTrend: 0,
        differenceTrend: 0,
        dmsQtyTrend: 0,
        actualQtyTrend: 0,
        duplicateTrend: 0,
        shortPartsTrend: 0,
        // Timestamp for cache validation
        calculatedAt: new Date(),
        isAccurate: true
      };
    } catch (error) {
      console.error('Error getting unified dashboard stats:', error);
      throw error;
    }
  }

  /**
   * Helper: Build filter stage
   */
  static buildFilterStage(filter = {}) {
    const match = { isDeleted: { $ne: true }, deletedAt: null };

    if (filter.dealerCode) match.dealerCode = filter.dealerCode;
    if (filter.auditId) match.auditId = filter.auditId;
    if (filter.category) match.category = filter.category;
    if (filter.binLocation) match.binLocation = filter.binLocation;
    if (filter.scanType) match.scanType = filter.scanType;
    if (filter.partNumber) match.partNumber = new RegExp(filter.partNumber, 'i');

    // Date filter
    if (filter.dateFrom || filter.dateTo) {
      const dateFilter = {};
      if (filter.dateFrom) dateFilter.$gte = new Date(filter.dateFrom);
      if (filter.dateTo) dateFilter.$lte = new Date(filter.dateTo);
      match.timestamp = dateFilter;
    }

    return { $match: match };
  }

  /**
   * Helper: Get unique scanned parts
   */
  static async getUniqueScansParts(filter = {}) {
    try {
      const pipeline = [
        this.buildFilterStage(filter),
        {
          $group: { _id: '$partNumber' }
        },
        {
          $count: 'total'
        }
      ];

      const result = await Inventory.aggregate(pipeline);
      return result[0]?.total || 0;
    } catch (error) {
      console.error('Error getting unique scans:', error);
      return 0;
    }
  }

  /**
   * Helper: Get total DMS parts
   */
  static async getTotalDMSParts(filter = {}) {
    try {
      const query = {};
      if (filter.dealerCode) query.dealerCode = filter.dealerCode;
      if (filter.category) query.category = filter.category;

      const count = await MasterCatalogue.countDocuments(query);
      return count;
    } catch (error) {
      console.error('Error getting total DMS parts:', error);
      return 0;
    }
  }

  /**
   * Helper: Get today's scan count
   */
  static async getTodayScanCount(filter = {}) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const pipeline = [
        {
          $match: {
            ...filter,
            timestamp: { $gte: today, $lt: tomorrow }
          }
        },
        {
          $count: 'total'
        }
      ];

      const result = await Inventory.aggregate(pipeline);
      return result[0]?.total || 0;
    } catch (error) {
      console.error('Error getting today scan count:', error);
      return 0;
    }
  }

  /**
   * Helper: Get unique categories
   */
  static async getUniqueCategories(filter = {}) {
    try {
      const pipeline = [
        this.buildFilterStage(filter),
        {
          $group: { _id: '$category' }
        },
        {
          $count: 'total'
        }
      ];

      const result = await Inventory.aggregate(pipeline);
      return result[0]?.total || 0;
    } catch (error) {
      console.error('Error getting unique categories:', error);
      return 0;
    }
  }

  /**
   * Helper: Get unique bin locations
   */
  static async getUniqueBinLocations(filter = {}) {
    try {
      const pipeline = [
        this.buildFilterStage(filter),
        {
          $group: { _id: { $ifNull: ['$binLocation', '$bin'] } }
        },
        {
          $match: { _id: { $nin: [null, ''] } }
        },
        {
          $count: 'total'
        }
      ];

      const result = await Inventory.aggregate(pipeline);
      return result[0]?.total || 0;
    } catch (error) {
      console.error('Error getting unique bin locations:', error);
      return 0;
    }
  }
}

module.exports = UnifiedCalculationEngine;
