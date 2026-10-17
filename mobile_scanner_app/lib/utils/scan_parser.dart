import 'dart:convert';

const invalidScannerSequenceTitle = 'Invalid Barcode / QR Sequence';
const invalidScannerSequenceMessage =
    'Only valid 1D barcode or 2D QR sequences are allowed here. To enter a part number, use Manual Entry, Local Part, or Excel Stock Upload.';

/// A capture guard for offline queues. Final part/UPI mapping and inventory
/// validation remain authoritative in the shared backend parser.
bool isSupportedScannerSequence(String raw, String format) {
  final value = normalizeDecodedValue(raw);
  if (value.isEmpty) return false;
  bool quantity(String token) => RegExp(r'^\d{1,7}$').hasMatch(token) &&
      int.parse(token) > 0 && int.parse(token) <= 999999;
  bool part(String token) => RegExp(r'^[A-Z0-9][A-Z0-9._-]{2,79}$').hasMatch(token);
  final fields = value.split('/').map((field) => field.trim()).toList();
  if (fields.first == 'D') {
    if (fields.length == 11) {
      return part(fields[3]) && quantity(fields[4]) && part(fields[2]) &&
          RegExp(r'^\d+\.\d{2}$').hasMatch(fields[5]);
    }
    if (fields.length == 8) {
      return part(fields[4]) && quantity(fields[5]) && part(fields[3]) &&
          RegExp(r'^\d{14}$').hasMatch(fields[6]);
    }
    return false;
  }
  if (RegExp(r'^\d{5}[A-Z0-9]{6,8}/G\d{13}$').hasMatch(value) ||
      RegExp(r'^\d{5}[A-Z0-9]{7,9}/[A-Z0-9]\d{13}$').hasMatch(value) ||
      RegExp(r'^[A-Z0-9._-]{3,79}/UPI[A-Z0-9._-]+$').hasMatch(value)) {
    return true;
  }
  if (fields.length >= 5) {
    for (var i = 1; i < fields.length - 1; i++) {
      if (part(fields[i]) && !RegExp(r'^\d+$').hasMatch(fields[i]) &&
          quantity(fields[i + 1])) return true;
    }
  }
  final keyed = <String, dynamic>{};
  try {
    final decoded = jsonDecode(value);
    if (decoded is Map) keyed.addAll(decoded.map((key, val) =>
        MapEntry(key.toString().replaceAll(RegExp(r'[^A-Z0-9]'), ''), val)));
  } catch (_) {}
  if (keyed.isEmpty) {
    final query = value.contains('?') ? value.substring(value.indexOf('?') + 1) : value;
    if (query.contains('=')) {
      try {
        keyed.addAll(Uri.splitQueryString(query.replaceAll(RegExp(r'[|;]'), '&')));
      } catch (_) {}
    }
    for (final match in RegExp(r'(?:^|[|;,\s])([A-Z][A-Z0-9 _-]{0,24})\s*[:=]\s*([^|;,\r\n]+)').allMatches(value)) {
      keyed[match[1]!.replaceAll(RegExp(r'[^A-Z0-9]'), '')] = match[2];
    }
  }
  if (['PARTNUMBER', 'PARTNO', 'PART', 'PN', 'SKU', 'ITEMCODE']
      .any((key) => keyed.containsKey(key))) {
    final qty = keyed['QTY'] ?? keyed['QUANTITY'] ?? keyed['Q'];
    return qty == null || quantity(qty.toString());
  }
  if (RegExp(r'^(?=.*[A-Z])(?:\d{2}[A-Z]\d{3,4}S|\d{5}[A-Z0-9]{5,10}|K\d{5}[A-Z0-9]{5,10})$').hasMatch(value)) return false;
  if (!RegExp(r'^[A-Z0-9][A-Z0-9._-]{2,79}$').hasMatch(value)) return false;
  final normalizedFormat = format.replaceAllMapped(RegExp(r'([a-z])([A-Z])'),
      (match) => '${match[1]}_${match[2]}').toUpperCase();
  final barcodeFormat = {'CODE128': 'CODE_128', 'CODE39': 'CODE_39',
    'CODE93': 'CODE_93', 'EAN13': 'EAN_13', 'EAN8': 'EAN_8',
    'UPCA': 'UPC_A', 'UPCE': 'UPC_E'}[normalizedFormat] ?? normalizedFormat;
  bool checksum() {
    if (!RegExp(r'^\d+$').hasMatch(value)) return false;
    final digits = value.split('').map(int.parse).toList();
    final check = digits.removeLast();
    var sum = 0;
    for (var i = 0; i < digits.length; i++) {
      sum += digits[digits.length - i - 1] * (i.isEven ? 3 : 1);
    }
    return (10 - sum % 10) % 10 == check;
  }
  final length = {'EAN_8': 8, 'EAN_13': 13, 'UPC_A': 12}[barcodeFormat];
  if (length != null) return value.length == length && checksum();
  if (['CODE_128', 'CODE_39', 'CODE_93', 'ITF', 'UPC_E', 'RSS_14', 'CODABAR']
      .contains(barcodeFormat)) return true;
  return barcodeFormat == 'UNKNOWN' &&
      (([8, 12, 13].contains(value.length) && checksum()) ||
          RegExp(r'^[A-D][0-9$+./:-]{4,}[A-D]$').hasMatch(value));
}

/// Camera transport normalization only.
String normalizeDecodedValue(String raw) =>
    raw.replaceAll(RegExp(r'[\r\n\t]'), '').trim().toUpperCase();

class CameraFrameGuard {
  CameraFrameGuard(
      {this.window = const Duration(milliseconds: 1800),
      DateTime Function()? clock})
      : _clock = clock ?? DateTime.now;
  final Duration window;
  final DateTime Function() _clock;
  final Map<String, DateTime> _lastSeen = {};
  final Map<String, DateTime> _lastObserved = {};

  bool accept(String key) {
    final now = _clock();
    final observed = _lastObserved[key];
    _lastObserved[key] = now;
    if (observed != null && now.difference(observed) < const Duration(seconds: 1)) {
      return false;
    }
    final previous = _lastSeen[key];
    if (previous != null && now.difference(previous) < window) return false;
    _lastSeen[key] = now;
    _lastSeen.removeWhere(
        (_, seen) => now.difference(seen) > const Duration(seconds: 30));
    _lastObserved.removeWhere(
        (_, seen) => now.difference(seen) > const Duration(seconds: 30));
    return true;
  }
}
