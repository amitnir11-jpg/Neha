import 'package:connectivity_plus/connectivity_plus.dart';

import '../models/scan_record.dart';
import 'api_client.dart';
import 'local_database.dart';
import 'settings_store.dart';

class SyncService {
  SyncService({SettingsStore? settings, LocalDatabase? database})
      : settings = settings ?? SettingsStore(),
        database = database ?? LocalDatabase.instance;

  static bool _globalSyncInFlight = false;

  final SettingsStore settings;
  final LocalDatabase database;

  Future<bool> get hasNetwork async {
    final result = await Connectivity().checkConnectivity();
    return result != ConnectivityResult.none;
  }

  Set<String> _recordKeys(ScanRecord record) => {
        record.localId,
        record.serverSyncId,
      }.map((value) => value.trim()).where((value) => value.isNotEmpty).toSet();

  Set<String> _logKeys(Map<String, dynamic> log) {
    const fields = [
      'clientScanId',
      'clientSyncKey',
      'localId',
      'mobileScanId',
      'scanId',
      'uniqueScanId',
      'syncKey',
      'serverSyncId',
    ];
    return fields
        .map((field) => (log[field] ?? '').toString().trim())
        .where((value) => value.isNotEmpty)
        .toSet();
  }

  bool _intersects(Set<String> left, Set<String> right) =>
      left.any(right.contains);

  Future<void> _markFailuresFromResponse(List<ScanRecord> pending,
      Map<String, dynamic> data, String fallbackMessage) async {
    final failedByKey = <String, String>{};
    for (final group in [data['logs'], data['failedRows']]) {
      if (group is! List) continue;
      for (final item in group) {
        if (item is! Map) continue;
        final log = Map<String, dynamic>.from(item);
        final keys = _logKeys(log);
        final message =
            (log['errorMessage'] ?? log['reason'] ?? fallbackMessage)
                .toString();
        for (final key in keys) {
          failedByKey[key] = message;
        }
      }
    }

    var matched = false;
    for (final record in pending) {
      final keys = _recordKeys(record);
      var failedKey = '';
      for (final key in keys) {
        if (failedByKey.containsKey(key)) {
          failedKey = key;
          break;
        }
      }
      if (failedKey.isEmpty) continue;
      await database.updateStatus(record.localId, 'Failed',
          errorMessage: failedByKey[failedKey] ?? fallbackMessage);
      matched = true;
    }

    if (!matched && data['success'] == false) {
      for (final record in pending) {
        await database.updateStatus(record.localId, 'Failed',
            errorMessage: fallbackMessage);
      }
    }
  }

  Future<SyncResult> syncPending() async {
    if (_globalSyncInFlight) {
      return SyncResult(false, 'Sync already running',
          synced: 0, serverReached: false);
    }
    _globalSyncInFlight = true;
    try {
      return await _syncPendingBatch();
    } finally {
      _globalSyncInFlight = false;
    }
  }

  Future<SyncResult> _syncPendingBatch() async {
    if (!await hasNetwork) {
      return SyncResult(false, 'Offline', synced: 0, serverReached: false);
    }

    final pending = await database.pendingScans();
    if (pending.isEmpty) {
      try {
        await ApiClient(settings).health();
        return SyncResult(true, 'No pending records',
            synced: 0, serverReached: true);
      } catch (_) {
        return SyncResult(true, 'No pending records',
            synced: 0, serverReached: false);
      }
    }

    try {
      await ApiClient(settings).mobileStatus();
    } catch (_) {
      // The sync request below is the source of truth; this is only a heartbeat.
    }

    try {
      final data = await ApiClient(settings).syncBulk(pending);
      final logs = (data['logs'] ?? []) as List<dynamic>;
      var synced = 0;
      final completedKeys = <String>{};
      final failedByKey = <String, String>{};
      final touchedLocalIds = <String>{};
      final completedAt = (data['completedAt'] ?? '').toString();

      if (logs.isEmpty && data['success'] == true) {
        for (final record in pending) {
          await database.updateStatus(record.localId, 'Synced',
              serverSyncId: completedAt);
          synced += 1;
        }
      } else {
        for (final item in logs) {
          final log = Map<String, dynamic>.from(item as Map);
          final keys = _logKeys(log);
          final status = (log['status'] ?? '').toString().toLowerCase();
          if (keys.isEmpty) continue;
          if (status == 'inserted' ||
              status == 'synced' ||
              status == 'duplicate') {
            completedKeys.addAll(keys);
          } else if (status == 'failed' || status == 'invalid') {
            final message = (log['errorMessage'] ?? 'Sync failed').toString();
            for (final key in keys) {
              failedByKey[key] = message;
            }
          }
        }

        for (final record in pending) {
          final keys = _recordKeys(record);
          var failedKey = '';
          for (final key in keys) {
            if (failedByKey.containsKey(key)) {
              failedKey = key;
              break;
            }
          }
          if (failedKey.isNotEmpty) {
            await database.updateStatus(record.localId, 'Failed',
                errorMessage: failedByKey[failedKey] ?? 'Sync failed');
            touchedLocalIds.add(record.localId);
            continue;
          }
          if (_intersects(keys, completedKeys)) {
            await database.updateStatus(record.localId, 'Synced',
                serverSyncId: completedAt);
            touchedLocalIds.add(record.localId);
            synced += 1;
          }
        }

        final failedCount =
            int.tryParse('${data['failedCount'] ?? data['failed'] ?? 0}') ?? 0;
        final responseHasFailures = failedByKey.isNotEmpty || failedCount > 0;
        if (data['success'] == true &&
            !responseHasFailures &&
            pending
                .any((record) => !touchedLocalIds.contains(record.localId))) {
          for (final record in pending) {
            if (touchedLocalIds.contains(record.localId)) continue;
            await database.updateStatus(record.localId, 'Synced',
                serverSyncId: completedAt);
            synced += 1;
          }
        }
      }

      return SyncResult(true, (data['message'] ?? 'Sync completed').toString(),
          synced: synced, serverReached: true);
    } on ApiException catch (error) {
      final statusCode = error.statusCode ?? 0;
      final shouldMarkFailed =
          statusCode >= 400 && statusCode < 500 && statusCode != 408;
      if (shouldMarkFailed) {
        await _markFailuresFromResponse(pending, error.data, error.message);
      }
      return SyncResult(false, error.message,
          synced: 0, serverReached: error.statusCode != null);
    } catch (error) {
      return SyncResult(false, error.toString(),
          synced: 0, serverReached: false);
    }
  }
}

class SyncResult {
  SyncResult(this.success, this.message,
      {required this.synced, this.serverReached = false});

  final bool success;
  final String message;
  final int synced;
  final bool serverReached;
}
