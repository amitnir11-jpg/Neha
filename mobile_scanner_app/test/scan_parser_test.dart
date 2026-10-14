import 'package:flutter_test/flutter_test.dart';
import 'package:daksh_mobile_scanner/utils/scan_parser.dart';
import 'package:daksh_mobile_scanner/models/scan_record.dart';

void main() {
  test('scanner guard rejects plain parts even with a decoder format', () {
    for (final value in ['20K211S', '20K411S', '41241AAN410S']) {
      for (final format in ['UNKNOWN', 'code128', 'qrCode']) {
        expect(isSupportedScannerSequence(value, format), isFalse);
      }
    }
    expect(isSupportedScannerSequence('D/TEST/UPI/PART/BAD/PRICE/A/1/G/000/00', 'qrCode'), isFalse);
  });
  test('offline scanner guard preserves Hero formats, padding and quantities', () {
    for (final value in ['77238KTC900ZCS/G3122000021001', '61108AACH40ZCS/D3533000166001']) {
      expect(isSupportedScannerSequence(value, 'code128'), isTrue);
    }
    for (final qty in [1, 2, 4, 5, 10, 20]) {
      final raw = 'D/TEST0000000002/TESTUPI00002/12395AANB00S /${qty.toString().padLeft(6, '0')}/0000010.00/AAA/1/G/000/00';
      expect(isSupportedScannerSequence(raw, 'qrCode'), isTrue);
    }
    expect(isSupportedScannerSequence('4006381333931', 'UNKNOWN'), isTrue);
    expect(isSupportedScannerSequence('4006381333932', 'ean13'), isFalse);
    expect(isSupportedScannerSequence('ABC12345', 'code128'), isTrue);
    expect(isSupportedScannerSequence('{"partNumber":"20K211S","qty":4}', 'qrCode'), isTrue);
  });
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
