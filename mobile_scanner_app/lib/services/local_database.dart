import 'dart:convert';

import 'package:path/path.dart' as p;
import 'package:sqflite/sqflite.dart';

import '../models/scan_record.dart';

class LocalDatabase {
  LocalDatabase._();
  static final LocalDatabase instance = LocalDatabase._();

  Database? _database;

  Future<Database> get database async {
    if (_database != null) return _database!;
    final path = p.join(await getDatabasesPath(), 'daksh_mobile_scanner.db');
    _database = await openDatabase(
      path,
      version: 5,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE scans (
            localId TEXT PRIMARY KEY,
            rawValue TEXT NOT NULL,
            partNumber TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            binLocation TEXT NOT NULL,
            scanType TEXT NOT NULL,
            dealerCode TEXT NOT NULL,
            auditId TEXT NOT NULL DEFAULT '',
            userId TEXT NOT NULL,
            userName TEXT NOT NULL,
            deviceId TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            status TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'mobile',
            serverSyncId TEXT DEFAULT '',
            errorMessage TEXT DEFAULT '',
            metadata TEXT NOT NULL DEFAULT '{}'
          )
        ''');
        await db.execute(
            'CREATE INDEX idx_scans_status_created ON scans(status, createdAt)');
        await db.execute(
            'CREATE INDEX idx_scans_duplicate ON scans(rawValue, scanType, dealerCode, userId, createdAt)');
        await db.execute(
            'CREATE INDEX idx_scans_duplicate_audit ON scans(rawValue, scanType, dealerCode, auditId, userId, status, createdAt)');
      },
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          await db.execute(
              "ALTER TABLE scans ADD COLUMN source TEXT NOT NULL DEFAULT 'mobile'");
        }
        if (oldVersion < 3) {
          await db.execute(
              "ALTER TABLE scans ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
        }
        if (oldVersion < 4) {
          await db.execute(
              "ALTER TABLE scans ADD COLUMN auditId TEXT NOT NULL DEFAULT ''");
        }
        if (oldVersion < 5) {
          await db.execute(
              'CREATE INDEX idx_scans_duplicate_audit ON scans(rawValue, scanType, dealerCode, auditId, userId, status, createdAt)');
        }
      },
    );
    return _database!;
  }

  Future<void> insertScan(ScanRecord record) async {
    final db = await database;
    await db.insert('scans', record.toMap(),
        conflictAlgorithm: ConflictAlgorithm.ignore);
  }

  Future<int> updateStatus(String localId, String status,
      {String serverSyncId = '', String errorMessage = ''}) async {
    final db = await database;
    return db.update(
      'scans',
      {
        'status': status,
        'serverSyncId': serverSyncId,
        'errorMessage': errorMessage
      },
      where: 'localId = ?',
      whereArgs: [localId],
    );
  }

  Future<void> updateResolvedScan(ScanRecord record) async {
    final db = await database;
    await db.update('scans', record.toMap(),
        where: 'localId = ?', whereArgs: [record.localId]);
  }

  Future<List<ScanRecord>> pendingScans(
      {required String dealerCode,
      required String auditId,
      required String userId,
      int limit = 200,
      bool includeFailed = false}) async {
    if (dealerCode.isEmpty || auditId.isEmpty || userId.isEmpty) return [];
    final db = await database;
    final rows = await db.query(
      'scans',
      where: includeFailed
          ? 'status IN (?, ?) AND scanType != ? AND dealerCode = ? AND auditId = ? AND userId = ?'
          : 'status = ? AND scanType != ? AND dealerCode = ? AND auditId = ? AND userId = ?',
      whereArgs: includeFailed
          ? ['Pending', 'Failed', 'VERIFICATION', dealerCode, auditId, userId]
          : ['Pending', 'VERIFICATION', dealerCode, auditId, userId],
      orderBy: 'createdAt ASC',
      limit: limit,
    );
    return rows.map(ScanRecord.fromMap).toList();
  }

  Future<List<ScanRecord>> lastScans(
      {required String dealerCode,
      required String auditId,
      required String userId,
      int limit = 10}) async {
    if (dealerCode.isEmpty || auditId.isEmpty || userId.isEmpty) return [];
    final db = await database;
    final rows = await db.query('scans',
        where:
            'scanType != ? AND dealerCode = ? AND auditId = ? AND userId = ?',
        whereArgs: ['VERIFICATION', dealerCode, auditId, userId],
        orderBy: 'createdAt DESC',
        limit: limit);
    return rows.map(ScanRecord.fromMap).toList();
  }

  Future<int> countByStatus(String status,
      {required String dealerCode,
      required String auditId,
      required String userId}) async {
    if (dealerCode.isEmpty || auditId.isEmpty || userId.isEmpty) return 0;
    final db = await database;
    final result = Sqflite.firstIntValue(await db.rawQuery(
        'SELECT COUNT(*) FROM scans WHERE status = ? AND scanType != ? AND dealerCode = ? AND auditId = ? AND userId = ?',
        [status, 'VERIFICATION', dealerCode, auditId, userId]));
    return result ?? 0;
  }

  Future<bool> hasRecentDuplicate({
    required String rawValue,
    required String scanType,
    required String dealerCode,
    required String auditId,
    required String userId,
    required DateTime since,
  }) async {
    final db = await database;
    final rows = await db.query(
      'scans',
      columns: ['localId'],
      where:
          'rawValue = ? AND scanType = ? AND dealerCode = ? AND auditId = ? AND userId = ? AND createdAt >= ?',
      whereArgs: [
        rawValue,
        scanType,
        dealerCode,
        auditId,
        userId,
        since.toIso8601String()
      ],
      limit: 1,
    );
    return rows.isNotEmpty;
  }

  Future<ScanRecord?> latestMatchingScan({
    required String rawValue,
    required String scanType,
    required String dealerCode,
    required String auditId,
    required String userId,
  }) async {
    final db = await database;
    final rows = await db.query(
      'scans',
      where:
          'rawValue = ? AND scanType = ? AND dealerCode = ? AND auditId = ? AND userId = ? AND status = ?',
      // A Pending/Failed row only exists on this phone.  It must not be used
      // as proof that the part is already in the central inventory.
      whereArgs: [rawValue, scanType, dealerCode, auditId, userId, 'Synced'],
      orderBy: 'createdAt DESC, localId DESC',
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return ScanRecord.fromMap(rows.first);
  }

  Future<String> exportJson(
      {required String dealerCode,
      required String auditId,
      required String userId}) async {
    if (dealerCode.isEmpty || auditId.isEmpty || userId.isEmpty) return '[]';
    final db = await database;
    final rows = await db.query('scans',
        where: 'dealerCode = ? AND auditId = ? AND userId = ?',
        whereArgs: [dealerCode, auditId, userId],
        orderBy: 'createdAt ASC');
    return const JsonEncoder.withIndent('  ').convert(rows);
  }
}
