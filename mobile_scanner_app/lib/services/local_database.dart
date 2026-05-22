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
      version: 2,
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
            userId TEXT NOT NULL,
            userName TEXT NOT NULL,
            deviceId TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            status TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'mobile',
            serverSyncId TEXT DEFAULT '',
            errorMessage TEXT DEFAULT ''
          )
        ''');
        await db.execute(
            'CREATE INDEX idx_scans_status_created ON scans(status, createdAt)');
        await db.execute(
            'CREATE INDEX idx_scans_duplicate ON scans(rawValue, scanType, dealerCode, userId, createdAt)');
      },
      onUpgrade: (db, oldVersion, newVersion) async {
        if (oldVersion < 2) {
          await db.execute(
              "ALTER TABLE scans ADD COLUMN source TEXT NOT NULL DEFAULT 'mobile'");
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

  Future<void> updateStatus(String localId, String status,
      {String serverSyncId = '', String errorMessage = ''}) async {
    final db = await database;
    await db.update(
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

  Future<List<ScanRecord>> pendingScans({int limit = 200}) async {
    final db = await database;
    final rows = await db.query(
      'scans',
      where: 'status IN (?, ?)',
      whereArgs: ['Pending', 'Failed'],
      orderBy: 'createdAt ASC',
      limit: limit,
    );
    return rows.map(ScanRecord.fromMap).toList();
  }

  Future<List<ScanRecord>> lastScans({int limit = 10}) async {
    final db = await database;
    final rows =
        await db.query('scans', orderBy: 'createdAt DESC', limit: limit);
    return rows.map(ScanRecord.fromMap).toList();
  }

  Future<int> countByStatus(String status) async {
    final db = await database;
    final result = Sqflite.firstIntValue(await db
        .rawQuery('SELECT COUNT(*) FROM scans WHERE status = ?', [status]));
    return result ?? 0;
  }

  Future<bool> hasRecentDuplicate({
    required String rawValue,
    required String scanType,
    required String dealerCode,
    required String userId,
    required DateTime since,
  }) async {
    final db = await database;
    final rows = await db.query(
      'scans',
      columns: ['localId'],
      where:
          'rawValue = ? AND scanType = ? AND dealerCode = ? AND userId = ? AND createdAt >= ?',
      whereArgs: [
        rawValue,
        scanType,
        dealerCode,
        userId,
        since.toIso8601String()
      ],
      limit: 1,
    );
    return rows.isNotEmpty;
  }

  Future<String> exportJson() async {
    final db = await database;
    final rows = await db.query('scans', orderBy: 'createdAt ASC');
    return const JsonEncoder.withIndent('  ').convert(rows);
  }
}
