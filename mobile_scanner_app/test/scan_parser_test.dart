import 'package:flutter_test/flutter_test.dart';
import 'package:daksh_mobile_scanner/utils/scan_parser.dart';

void main() {
  const cases = <String, List<Object>>{
    'D/132/HE5B0199510/EBHPE5EQTWD4/44831KVH900S      /001/20170505125743/00': [
      '44831KVH900S',
      'EBHPE5EQTWD4',
      1,
    ],
    'D/130/JABC0040512/ABJP5929U2C7/19510KTP900S      /001/20180111081312/00': [
      '19510KTP900S',
      'ABJP5929U2C7',
      1,
    ],
    'D/GCJG0000991624/CCGGT289DMFE/K99996ABSE001S    /000001/0000349.00/AAC/1/G/000/00': [
      'K99996ABSE001S',
      'CCGGT289DMFE',
      1,
    ],
    'D/GCSG0000272850/CCG8FN2C6D4C/957010805000S     /000010/0000011.00/AAB/1/G/000/00': [
      '957010805000S',
      'CCG8FN2C6D4C',
      10,
    ],
    'D/FDWG0000852103/DCF7PL8MCW8A/957010805000S     /000010/0000011.00/AAB/1/G/000/00': [
      '957010805000S',
      'DCF7PL8MCW8A',
      10,
    ],
    'D/BCSG0000693868/CCBWR5ZSBY3Y/14610AAT001S      /000005/0000025.00/AAA/1/G/000/00': [
      '14610AAT001S',
      'CCBWR5ZSBY3Y',
      5,
    ],
  };

  for (final entry in cases.entries) {
    test('parses ${entry.value[0]} from its slash QR', () {
      final parsed = parseSlashScan(entry.key);
      expect(parsed, isNotNull);
      expect(parsed!.partNumber, entry.value[0]);
      expect(parsed.uniqueId, entry.value[1]);
      expect(parsed.quantity, entry.value[2]);
    });
  }

  test('normalizes QR part-number padding and scanner control characters', () {
    final parsed = parseSlashScan(
      'D/132/HE5B0199510/EBHPE5EQTWD4/\r\n 44831KVH900S\t /001/20170505125743/00',
    );
    expect(parsed?.partNumber, '44831KVH900S');
    expect(parsed?.uniqueId, 'EBHPE5EQTWD4');
  });

  test('returns null for an unstructured slash value', () {
    expect(parseSlashScan('UPI/NOT-A-PART/OTHER'), isNull);
  });
}
