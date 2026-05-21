import 'package:sqflite/sqflite.dart';
import 'package:path/path.dart';

class DatabaseService {
  static final DatabaseService _instance = DatabaseService._internal();
  factory DatabaseService() => _instance;
  DatabaseService._internal();

  static Database? _database;

  Future<Database> get database async {
    if (_database != null) return _database!;
    _database = await _initDatabase();
    return _database!;
  }

  Future<Database> _initDatabase() async {
    final dbPath = await getDatabasesPath();
    final path = join(dbPath, 'daksh_scanner.db');

    return await openDatabase(
      path,
      version: 4,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE sync_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            part_number TEXT NOT NULL,
            scan_type TEXT DEFAULT 'INWARD',
            dealer_code TEXT DEFAULT '',
            bin_location TEXT DEFAULT '',
            raw_scan TEXT DEFAULT '',
            upi_no TEXT DEFAULT '',
            qty REAL DEFAULT 1,
            mrp REAL DEFAULT 0,
            source TEXT DEFAULT 'mobile',
            scanned_at TEXT NOT NULL,
            status TEXT DEFAULT 'pending'
          )
        ''');
      },
      onUpgrade: (db, oldVersion, version) async {
        if (oldVersion < 2) {
          await _addColumnIfMissing(
              db, 'sync_queue', 'scan_type', "TEXT DEFAULT 'INWARD'");
          await _addColumnIfMissing(
              db, 'sync_queue', 'dealer_code', "TEXT DEFAULT ''");
          await _addColumnIfMissing(
              db, 'sync_queue', 'bin_location', "TEXT DEFAULT ''");
        }
        if (oldVersion < 3) {
          await _addColumnIfMissing(
              db, 'sync_queue', 'raw_scan', "TEXT DEFAULT ''");
          await _addColumnIfMissing(
              db, 'sync_queue', 'upi_no', "TEXT DEFAULT ''");
          await _addColumnIfMissing(db, 'sync_queue', 'qty', "REAL DEFAULT 1");
          await _addColumnIfMissing(db, 'sync_queue', 'mrp', "REAL DEFAULT 0");
        }
        if (oldVersion < 4) {
          await _addColumnIfMissing(
              db, 'sync_queue', 'source', "TEXT DEFAULT 'mobile'");
        }
      },
    );
  }

  Future<void> _addColumnIfMissing(
      Database db, String table, String column, String definition) async {
    final columns = await db.rawQuery('PRAGMA table_info($table)');
    final exists = columns.any((item) => item['name'] == column);
    if (!exists) {
      await db.execute('ALTER TABLE $table ADD COLUMN $column $definition');
    }
  }

  Future<int> insertScan(Map<String, dynamic> scan) async {
    final db = await database;
    return await db.insert('sync_queue', scan);
  }

  Future<List<Map<String, dynamic>>> getPendingScans() async {
    final db = await database;
    return await db.query('sync_queue',
        where: 'status = ?',
        whereArgs: ['pending'],
        orderBy: 'scanned_at DESC');
  }

  Future<int> deleteScan(int id) async {
    final db = await database;
    return await db.delete('sync_queue', where: 'id = ?', whereArgs: [id]);
  }
}
