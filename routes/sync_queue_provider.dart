import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'database_service.dart';
import 'mobile_api.dart';

final syncQueueProvider =
    StateNotifierProvider<SyncQueueNotifier, List<Map<String, dynamic>>>((ref) {
  return SyncQueueNotifier(ref.read(mobileApiProvider));
});

class SyncQueueNotifier extends StateNotifier<List<Map<String, dynamic>>> {
  SyncQueueNotifier(this._api) : super([]) {
    loadQueue();
  }

  final MobileApi _api;
  final _dbService = DatabaseService();

  Map<String, dynamic> _parseScanValue(String value) {
    final rawOriginal = value.trim();
    final raw = rawOriginal.toUpperCase();
    final slashParts = raw.split('/');
    if (slashParts.length >= 6 && slashParts[3].isNotEmpty) {
      return {
        'rawScan': rawOriginal,
        'upiNo': slashParts[1].trim().toUpperCase(),
        'partNumber': slashParts[3].trim().replaceAll(RegExp(r'\s+'), '').toUpperCase(),
        'qty': double.tryParse(slashParts[4].trim()) ?? 1,
        'mrp': double.tryParse(slashParts[5].trim()) ?? 0,
      };
    }
    final match = RegExp(r'(?:PART\s*NO|PART|PN|SKU)[:=#-]?\s*([A-Z0-9._/-]+)')
        .firstMatch(raw);
    final part = match != null ? match.group(1)!.trim().toUpperCase() : raw;
    return {
      'rawScan': rawOriginal,
      'upiNo': '',
      'partNumber': part,
      'qty': 1.0,
      'mrp': 0.0,
    };
  }

  Future<void> loadQueue() async {
    final scans = await _dbService.getPendingScans();
    state = scans;
  }

  Future<Map<String, dynamic>> addScan(
    String scanValue, {
    String scanType = 'INWARD',
    String dealerCode = '',
    String binLocation = '',
    String source = 'QR',
    num? quantity,
    num? mrp,
    bool syncNow = true,
  }) async {
    final parsed = _parseScanValue(scanValue);
    final cleanPart = parsed['partNumber'] as String;
    final cleanBin = binLocation.trim().toUpperCase();
    if (cleanBin.isEmpty) {
      throw Exception('Please enter/select bin location first.');
    }
    if (!RegExp(r'^[A-Z0-9][A-Z0-9._/-]{2,39}$').hasMatch(cleanPart)) {
      throw Exception('Invalid part number format');
    }
    final scan = {
      'part_number': cleanPart,
      'scan_type': scanType,
      'dealer_code': dealerCode,
      'bin_location': cleanBin,
      'raw_scan': parsed['rawScan'],
      'upi_no': parsed['upiNo'],
      'qty': quantity ?? parsed['qty'],
      'mrp': mrp ?? parsed['mrp'],
      'scan_source': source,
      'scanned_at': DateTime.now().toIso8601String(),
      'status': 'pending',
    };
    await _dbService.insertScan(scan);
    await loadQueue();
    if (syncNow) return syncPendingScans();
    return {'success': true, 'queued': true};
  }

  Future<Map<String, dynamic>> syncPendingScans() async {
    if (state.isEmpty) return {'success': true, 'message': 'No pending scans'};
    final deviceId = await _api.deviceId();
    final records = state
        .map((scan) => {
              'localId': scan['id']?.toString() ?? '',
              'deviceId': deviceId,
              'rawScan': scan['raw_scan']?.toString() ??
                  scan['part_number']?.toString() ??
                  '',
              'rawScanString': scan['raw_scan']?.toString() ??
                  scan['part_number']?.toString() ??
                  '',
              'upiNo': scan['upi_no']?.toString() ?? '',
              'upiId': scan['upi_no']?.toString() ?? '',
              'partNumber': scan['part_number']?.toString() ?? '',
              'qty': scan['qty'] ?? 1,
              'mrp': scan['mrp'] ?? 0,
              'source': scan['scan_source']?.toString() ?? 'QR',
              'scanSource': scan['scan_source']?.toString() ?? 'QR',
              'scanType': scan['scan_type']?.toString() ?? 'INWARD',
              'type': scan['scan_type']?.toString() ?? 'INWARD',
              'dealerCode': scan['dealer_code']?.toString() ?? '',
              'binLocation': scan['bin_location']?.toString() ?? '',
              'bin': scan['bin_location']?.toString() ?? '',
              'timestamp': scan['scanned_at']?.toString() ??
                  DateTime.now().toIso8601String(),
            })
        .toList();

    final result = await _api.sync(records);
    if (result['success'] != true) return result;

    for (var scan in state) {
      await _dbService.deleteScan(scan['id'] as int);
    }

    await loadQueue();
    return result;
  }
}
