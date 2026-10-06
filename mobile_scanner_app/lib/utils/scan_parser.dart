class ParsedSlashScan {
  const ParsedSlashScan({
    required this.partNumber,
    required this.uniqueId,
    required this.quantity,
  });

  final String partNumber;
  final String uniqueId;
  final int quantity;
}

String _cleanScanField(String value) =>
    value.replaceAll(RegExp(r'[\u0000-\u001F\u007F]'), '').trim();

String _normalizeScanField(String value) =>
    _cleanScanField(value).replaceAll(RegExp(r'\s+'), '').toUpperCase();

bool _isScanQuantity(String value) {
  final token = _cleanScanField(value);
  if (!RegExp(r'^\d{1,7}$').hasMatch(token)) return false;
  final quantity = int.tryParse(token);
  return quantity != null && quantity > 0 && quantity <= 999999;
}

ParsedSlashScan? parseSlashScan(String rawValue) {
  final raw = _cleanScanField(rawValue);
  if (!raw.contains('/')) return null;
  final fields = raw.split('/').map(_cleanScanField).toList();
  final isDakshQr = fields.isNotEmpty && _normalizeScanField(fields.first) == 'D';

  for (var index = 1; index < fields.length - 1; index += 1) {
    final candidate = _normalizeScanField(fields[index]);
    if (!RegExp(r'^[A-Z0-9][A-Z0-9._/-]{2,79}$').hasMatch(candidate) ||
        RegExp(r'^\d+$').hasMatch(candidate) ||
        !_isScanQuantity(fields[index + 1])) {
      continue;
    }
    return ParsedSlashScan(
      partNumber: candidate,
      uniqueId: isDakshQr
          ? (index > 0 ? _normalizeScanField(fields[index - 1]) : '')
          : _normalizeScanField(fields.length > 1 ? fields[1] : ''),
      quantity: int.parse(_cleanScanField(fields[index + 1]), radix: 10),
    );
  }

  if (isDakshQr) return null;
  return null;
}
