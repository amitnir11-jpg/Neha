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

  ScanRecord copyWith(
      {String? status, String? serverSyncId, String? errorMessage}) {
    return ScanRecord(
      localId: localId,
      rawValue: rawValue,
      partNumber: partNumber,
      quantity: quantity,
      binLocation: binLocation,
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
        'createdAt': createdAt.toIso8601String(),
        'status': status,
        'source': source,
        'serverSyncId': serverSyncId,
        'errorMessage': errorMessage,
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
        'timestamp': createdAt.toIso8601String(),
        'source': source,
        'scanMode':
            source == 'manual' ? 'Mobile Manual Entry' : 'Mobile Scanner',
        'syncStatus': status.toLowerCase(),
      };
}
