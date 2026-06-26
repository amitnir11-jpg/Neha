import 'dart:convert';

class ScanRecord {
  ScanRecord({
    required this.localId,
    required this.rawValue,
    required this.partNumber,
    required this.quantity,
    required this.binLocation,
    required this.scanType,
    required this.dealerCode,
    required this.userId,
    required this.userName,
    required this.deviceId,
    required this.createdAt,
    required this.status,
    this.source = 'mobile',
    this.serverSyncId = '',
    this.errorMessage = '',
    this.metadata = const {},
  });

  final String localId;
  final String rawValue;
  final String partNumber;
  final int quantity;
  final String binLocation;
  final String scanType;
  final String dealerCode;
  final String userId;
  final String userName;
  final String deviceId;
  final DateTime createdAt;
  final String status;
  final String source;
  final String serverSyncId;
  final String errorMessage;
  final Map<String, dynamic> metadata;

  ScanRecord copyWith(
      {String? status,
      String? serverSyncId,
      String? errorMessage,
      String? binLocation,
      Map<String, dynamic>? metadata}) {
    return ScanRecord(
      localId: localId,
      rawValue: rawValue,
      partNumber: partNumber,
      quantity: quantity,
      binLocation: binLocation ?? this.binLocation,
      scanType: scanType,
      dealerCode: dealerCode,
      userId: userId,
      userName: userName,
      deviceId: deviceId,
      createdAt: createdAt,
      status: status ?? this.status,
      source: source,
      serverSyncId: serverSyncId ?? this.serverSyncId,
      errorMessage: errorMessage ?? this.errorMessage,
      metadata: metadata ?? this.metadata,
    );
  }

  Map<String, Object?> toMap() => {
        'localId': localId,
        'rawValue': rawValue,
        'partNumber': partNumber,
        'quantity': quantity,
        'binLocation': binLocation,
        'scanType': scanType,
        'dealerCode': dealerCode,
        'userId': userId,
        'userName': userName,
        'deviceId': deviceId,
        'createdAt': createdAt.toUtc().toIso8601String(),
        'status': status,
        'source': source,
        'serverSyncId': serverSyncId,
        'errorMessage': errorMessage,
        'metadata': jsonEncode(metadata),
      };

  factory ScanRecord.fromMap(Map<String, Object?> map) {
    return ScanRecord(
      localId: (map['localId'] ?? '').toString(),
      rawValue: (map['rawValue'] ?? '').toString(),
      partNumber: (map['partNumber'] ?? '').toString(),
      quantity: int.tryParse((map['quantity'] ?? '1').toString()) ?? 1,
      binLocation: (map['binLocation'] ?? '').toString(),
      scanType: (map['scanType'] ?? 'INWARD').toString(),
      dealerCode: (map['dealerCode'] ?? '').toString(),
      userId: (map['userId'] ?? '').toString(),
      userName: (map['userName'] ?? '').toString(),
      deviceId: (map['deviceId'] ?? '').toString(),
      createdAt: DateTime.tryParse((map['createdAt'] ?? '').toString()) ??
          DateTime.now(),
      status: (map['status'] ?? 'Pending').toString(),
      source: (map['source'] ?? 'mobile').toString(),
      serverSyncId: (map['serverSyncId'] ?? '').toString(),
      errorMessage: (map['errorMessage'] ?? '').toString(),
      metadata: _metadataMap(map['metadata']),
    );
  }

  factory ScanRecord.fromServerMap(Map<String, dynamic> map) {
    final rawValue = _string(map['rawScanString'] ??
        map['rawScan'] ??
        map['rawBarcode'] ??
        map['rawQR'] ??
        map['rawUpi'] ??
        map['rawScannedValue'] ??
        map['rawScanValue']);
    final serverStatus = _serverStatus(map);
    final timestamp = _dateTime(map['timestamp'] ??
        map['scanTime'] ??
        map['time'] ??
        map['dateTime'] ??
        map['createdAt']);
    return ScanRecord(
      localId: _string(map['scanId'] ??
          map['uniqueScanId'] ??
          map['clientScanId'] ??
          map['localId'] ??
          rawValue),
      rawValue: rawValue,
      partNumber: _string(map['partNumber'] ??
          map['part'] ??
          map['normalizedPartNumber'] ??
          map['extractedPartNumber'] ??
          map['partNo']),
      quantity: _int(map['qty'] ?? map['quantity'] ?? map['count'], 1),
      binLocation: _string(map['binLocation'] ?? map['bin'] ?? ''),
      scanType: _string(map['scanType'] ?? map['type'] ?? 'INWARD'),
      dealerCode: _string(map['dealerCode'] ?? map['dealer'] ?? ''),
      userId: _string(map['userId'] ?? map['loginId'] ?? ''),
      userName: _string(map['userName'] ?? map['staffName'] ?? map['scannedBy'] ?? ''),
      deviceId: _string(map['deviceId'] ?? map['deviceName'] ?? ''),
      createdAt: timestamp,
      status: serverStatus,
      source: _string(map['source'] ?? map['scanMode'] ?? map['entryMode'] ?? 'mobile'),
      serverSyncId: _string(map['syncKey'] ?? map['scanId'] ?? map['uniqueScanId'] ?? ''),
      errorMessage: _string(map['reason'] ?? ''),
      metadata: _serverMetadata(map),
    );
  }

  Map<String, dynamic> toApiPayload() => {
        'localId': localId,
        'mobileScanId': localId,
        'clientScanId': localId,
        'clientSyncKey': localId,
        'localSyncKey': localId,
        'uniqueScanId': localId,
        'scanId': localId,
        'serverSyncId': serverSyncId,
        'syncKey': localId,
        'dealerCode': dealerCode,
        'userId': userId,
        'loginId': userId,
        'userName': userName,
        'staffName': userName,
        'deviceId': deviceId,
        'partNumber': partNumber,
        'part': partNumber,
        'qty': quantity,
        'quantity': quantity,
        'binLocation': binLocation,
        'bin': binLocation,
        'scanType': scanType,
        'type': scanType,
        'rawScan': rawValue,
        'rawScanString': rawValue,
        'rawUpi': rawValue,
        'timestamp': createdAt.toUtc().toIso8601String(),
        'source': source,
        'scanMode':
            source == 'manual' ? 'Mobile Manual Entry' : 'Mobile Scanner',
        'syncStatus': status.toLowerCase(),
        ...metadata,
      };
}

String _string(Object? value) => value == null ? '' : value.toString().trim();

int _int(Object? value, int fallback) => int.tryParse(_string(value)) ?? fallback;

DateTime _dateTime(Object? value) =>
    DateTime.tryParse(_string(value)) ?? DateTime.now();

Map<String, dynamic> _metadataMap(Object? value) {
  if (value is Map<String, dynamic>) return Map<String, dynamic>.from(value);
  if (value is Map) {
    return value.map((key, entry) => MapEntry(key.toString(), entry));
  }
  if (value is String && value.isNotEmpty) {
    try {
      final parsed = jsonDecode(value);
      if (parsed is Map) {
        return parsed.map((key, entry) => MapEntry(key.toString(), entry));
      }
    } catch (_) {}
  }
  return <String, dynamic>{};
}

Map<String, dynamic> _serverMetadata(Map<String, dynamic> map) {
  final metadata = <String, dynamic>{};
  final direct = _metadataMap(map['metadata']);
  metadata.addAll(direct);
  for (final key in [
    'smartBinDecision',
    'smartBinReason',
    'smartBinSuggestedBin',
    'smartBinSelectedBin',
    'smartBinCurrentBin',
    'smartBinAllowMultipleLocations',
    'smartBinMaxAllowedLocationsPerPart',
    'smartBinReasonRequired',
    'smartBinCheckedAt',
    'smartBinDecisionAt',
    'smartBinDecisionBy',
    'smartBinLocationType',
    'smartBinIsSecondaryLocation',
    'smartBinAuditTrail'
  ]) {
    if (map.containsKey(key) && map[key] != null) {
      metadata[key] = map[key];
    }
  }
  return metadata;
}

String _serverStatus(Map<String, dynamic> map) {
  final syncStatus = _string(map['syncStatus']).toLowerCase();
  if (syncStatus == 'failed') return 'Failed';
  if (syncStatus == 'pending') return 'Pending';
  if (syncStatus == 'duplicate') return 'Duplicate';
  if (syncStatus == 'rejected') return 'Rejected';
  if (syncStatus == 'synced' || syncStatus == 'accepted') return 'Synced';

  final scanStatus = _string(map['scanStatus']).toLowerCase();
  if (scanStatus == 'duplicate') return 'Duplicate';
  if (scanStatus.contains('reject')) return 'Rejected';
  if (scanStatus.contains('fail')) return 'Failed';
  if (scanStatus == 'accepted' ||
      scanStatus == 'outward_done' ||
      scanStatus == 'supervisor_approved') {
    return 'Synced';
  }

  if (map['synced'] == true || map['isSynced'] == true) return 'Synced';
  return 'Synced';
}
