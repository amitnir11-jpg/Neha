import 'package:connectivity_plus/connectivity_plus.dart';

import 'api_client.dart';
import 'local_database.dart';
import 'settings_store.dart';

class SyncService {
  SyncService({SettingsStore? settings, LocalDatabase? database})
      : settings = settings ?? SettingsStore(),
        database = database ?? LocalDatabase.instance;

  final SettingsStore settings;
  final LocalDatabase database;

  Future<bool> get hasNetwork async {
    final result = await Connectivity().checkConnectivity();
    return result != ConnectivityResult.none;
  }

  Future<SyncResult> syncPending() async {
    if (!await hasNetwork) return SyncResult(false, 'Offline', synced: 0);
    final pending = await database.pendingScans();
    if (pending.isEmpty) {
      return SyncResult(true, 'No pending records', synced: 0);
    }

    try {
      final data = await ApiClient(settings).syncBulk(pending);
      final logs = (data['logs'] ?? []) as List<dynamic>;
      var synced = 0;
      if (logs.isEmpty && data['success'] == true) {
        for (final record in pending) {
          await database.updateStatus(record.localId, 'Synced',
              serverSyncId: (data['completedAt'] ?? '').toString());
          synced += 1;
        }
      } else {
        final completedKeys = <String>{};
        for (final item in logs) {
          final log = Map<String, dynamic>.from(item as Map);
          final key = (log['syncKey'] ?? '').toString();
          final status = (log['status'] ?? '').toString().toLowerCase();
          if (key.isEmpty) continue;
          if (status == 'inserted' ||
              status == 'synced' ||
              status == 'duplicate') {
            completedKeys.add(key);
            await database.updateStatus(key, 'Synced',
                serverSyncId: (data['completedAt'] ?? '').toString());
            synced += 1;
          } else if (status == 'failed' || status == 'invalid') {
            await database.updateStatus(key, 'Failed',
                errorMessage:
                    (log['errorMessage'] ?? 'Sync failed').toString());
          }
        }
        if (completedKeys.isEmpty && data['success'] == true) {
          for (final record in pending) {
            await database.updateStatus(record.localId, 'Synced',
                serverSyncId: (data['completedAt'] ?? '').toString());
            synced += 1;
          }
        }
      }
      return SyncResult(true, (data['message'] ?? 'Sync completed').toString(),
          synced: synced);
    } catch (error) {
      return SyncResult(false, error.toString(), synced: 0);
    }
  }
}

class SyncResult {
  SyncResult(this.success, this.message, {required this.synced});

  final bool success;
  final String message;
  final int synced;
}
