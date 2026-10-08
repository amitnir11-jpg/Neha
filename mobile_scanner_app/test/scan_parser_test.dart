import 'package:flutter_test/flutter_test.dart';
import 'package:daksh_mobile_scanner/utils/scan_parser.dart';
import 'package:daksh_mobile_scanner/models/scan_record.dart';

void main() {
  test('a held SKU label cannot keep adding pieces as camera time passes', () {
    var time = DateTime.utc(2026);
    final guard = CameraFrameGuard(clock: () => time);
    expect(guard.accept('PHONE1|INWARD|32410KTC920S/G3223000065001'), isTrue);
    for (var frame = 0; frame < 30; frame++) {
      time = time.add(const Duration(milliseconds: 200));
      expect(guard.accept('PHONE1|INWARD|32410KTC920S/G3223000065001'), isFalse);
    }
    time = time.add(const Duration(milliseconds: 2000));
    expect(guard.accept('PHONE1|INWARD|32410KTC920S/G3223000065001'), isTrue);
  });
  test('camera normalization never guesses barcode contents from printed text',
      () {
    expect(normalizeDecodedValue(' \r\n32410ktc920s\t '), '32410KTC920S');
    expect(normalizeDecodedValue('INTERNAL-UNKNOWN'), 'INTERNAL-UNKNOWN');
  });
  test(
      'frame guard ignores fast repeats but permits later scans and another device',
      () {
    var time = DateTime.utc(2026);
    final guard = CameraFrameGuard(clock: () => time);
    expect(guard.accept('PHONE1|INWARD|RAW'), isTrue);
    time = time.add(const Duration(milliseconds: 500));
    expect(guard.accept('PHONE1|INWARD|RAW'), isFalse);
    expect(guard.accept('PHONE2|INWARD|RAW'), isTrue);
    time = time.add(const Duration(milliseconds: 1500));
    expect(guard.accept('PHONE1|INWARD|RAW'), isTrue);
  });
  test(
      'offline queue retains exact decoded text and format for shared backend parsing',
      () {
    const raw =
        'D/132/HE5B0199510/EBHPE5EQTWD4/44831KVH900S      /001/20170505125743/00\r\n';
    final record = ScanRecord(
        localId: 'OFFLINE1',
        rawValue: raw,
        partNumber: '',
        quantity: 1,
        binLocation: 'A1',
        scanType: 'INWARD',
        dealerCode: 'D01',
        auditId: 'AUD1',
        userId: 'USER1',
        userName: 'Operator',
        deviceId: 'PHONE1',
        createdAt: DateTime.utc(2026),
        status: 'Pending',
        metadata: {
          'cameraDecoded': true,
          'rawDecodedValue': raw,
          'barcodeFormat': 'qrCode'
        });
    final restored = ScanRecord.fromMap(record.toMap());
    expect(restored.rawValue, raw);
    expect(restored.partNumber, isEmpty);
    expect(restored.toApiPayload()['rawDecodedValue'], raw);
    expect(restored.toApiPayload()['barcodeFormat'], 'qrCode');
    expect(restored.toApiPayload()['cameraDecoded'], isTrue);
    final resolved =
        restored.copyWith(partNumber: '44831KVH900S', status: 'Synced');
    expect(resolved.partNumber, '44831KVH900S');
    expect(resolved.rawValue, raw);
  });
}
