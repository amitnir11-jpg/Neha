import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'app_theme.dart';
import 'mobile_api.dart';
import 'sync_queue_provider.dart';

class ScannerScreen extends ConsumerStatefulWidget {
  const ScannerScreen({super.key, this.initialScanType = 'INWARD'});

  final String initialScanType;

  @override
  ConsumerState<ScannerScreen> createState() => _ScannerScreenState();
}

class _ScannerScreenState extends ConsumerState<ScannerScreen> {
  static const MethodChannel _feedbackChannel =
      MethodChannel('daksh/scan_feedback');
  static const Duration _duplicateCooldown = Duration(seconds: 2);

  late MobileScannerController _scannerController;

  String? _lastScannedCode;
  String _statusText = 'Ready';
  final List<Map<String, String>> _lastScans = [];
  DateTime? _lastScannedTime;
  DateTime? _scanPausedUntil;
  String? _lastRawScan;
  bool _isFlashOn = false;
  bool _syncingScan = false;
  bool _beepEnabled = true;
  bool _vibrationEnabled = true;
  late String _scanType;
  final _dealerController = TextEditingController(text: 'D001');
  final _binController = TextEditingController();

  @override
  void initState() {
    super.initState();
    _scanType = ['INWARD', 'OUTWARD', 'VERIFICATION']
            .contains(widget.initialScanType.toUpperCase())
        ? widget.initialScanType.toUpperCase()
        : 'INWARD';
    _scannerController = MobileScannerController(
      formats: const [BarcodeFormat.all],
      detectionSpeed: DetectionSpeed.normal,
      facing: CameraFacing.back,
    );
  }

  @override
  void dispose() {
    _scannerController.dispose();
    _dealerController.dispose();
    _binController.dispose();
    super.dispose();
  }

  Future<void> _successFeedback() async {
    try {
      debugPrint('SCAN_FEEDBACK Scan success received');
      if (_beepEnabled && _vibrationEnabled) {
        await _feedbackChannel.invokeMethod('playSuccessFeedback');
      } else {
        if (_beepEnabled) await _feedbackChannel.invokeMethod('playBeep');
        if (_vibrationEnabled) await _feedbackChannel.invokeMethod('vibrate');
      }
    } catch (_) {
      if (_vibrationEnabled) HapticFeedback.mediumImpact();
      if (_beepEnabled) await SystemSound.play(SystemSoundType.click);
    }
  }

  Future<void> _duplicateFeedback() async {
    if (!_vibrationEnabled) return;
    try {
      await _feedbackChannel.invokeMethod('warningVibration');
    } catch (_) {
      HapticFeedback.heavyImpact();
    }
  }

  Future<void> _errorFeedback() async {
    if (!_vibrationEnabled) return;
    try {
      await _feedbackChannel.invokeMethod('warningVibration');
    } catch (_) {
      HapticFeedback.vibrate();
    }
  }

  Future<void> _testBeep() async {
    if (!_beepEnabled) return;
    try {
      await _feedbackChannel.invokeMethod('playBeep');
    } catch (_) {
      await SystemSound.play(SystemSoundType.click);
    }
  }

  Future<void> _testVibration() async {
    if (_vibrationEnabled) await _duplicateFeedback();
  }

  Map<String, String> _scanRow({
    required String status,
    required String raw,
    String qty = '1',
  }) {
    final parsedPart = _partFromScan(raw);
    return {
      'status': status,
      'part': parsedPart,
      'qty': qty,
      'bin': _binController.text.trim().toUpperCase(),
      'type': _scanType,
      'time': TimeOfDay.now().format(context),
    };
  }

  void _addLastScan(Map<String, String> scan) {
    _lastScans.insert(0, scan);
    if (_lastScans.length > 10) _lastScans.removeLast();
  }

  Future<void> _handleScanResult({
    required Map<String, dynamic> result,
    required String raw,
    required String normalizedRaw,
    String qty = '1',
    bool manualEntry = false,
  }) async {
    debugPrint('SCAN_FEEDBACK Scan success received');
    final duplicateCount = int.tryParse(
            '${result['duplicateCount'] ?? result['duplicates'] ?? 0}') ??
        0;
    final effectiveDuplicateCount = manualEntry ? 0 : duplicateCount;
    final statusText = _statusFromSyncResult(result, effectiveDuplicateCount);
    final rejected =
        RegExp(r'not found|failed|invalid|reject', caseSensitive: false)
            .hasMatch(statusText);
    final success =
        effectiveDuplicateCount == 0 && result['success'] == true && !rejected;
    if (effectiveDuplicateCount > 0) {
      await _duplicateFeedback();
    } else if (success) {
      await _successFeedback();
    } else {
      await _errorFeedback();
    }
    if (!mounted) return;
    setState(() {
      _statusText = statusText;
      _lastRawScan = normalizedRaw;
      _lastScannedTime = DateTime.now();
      _addLastScan(_scanRow(
        status: effectiveDuplicateCount > 0
            ? 'Duplicate'
            : success
                ? 'Unique'
                : 'Rejected',
        raw: raw,
        qty: qty,
      ));
    });
  }

  String _partFromScan(String value) {
    final raw = value.trim().toUpperCase();
    final slashParts = raw.split('/');
    if (slashParts.length >= 4 && slashParts[3].trim().isNotEmpty) {
      return slashParts[3].trim().replaceAll(RegExp(r'\s+'), '');
    }
    final match = RegExp(r'(?:PART\s*NO|PART|PN|SKU)[:=#-]?\s*([A-Z0-9._/-]+)')
        .firstMatch(raw);
    return match != null ? match.group(1)!.trim().toUpperCase() : raw;
  }

  String _normalizedScanKey(String value) {
    return value.trim().toUpperCase();
  }

  void _onDetect(BarcodeCapture capture) async {
    final List<Barcode> barcodes = capture.barcodes;
    if (barcodes.isEmpty) return;

    final String? code = barcodes.first.rawValue;
    final rawCode = code?.trim() ?? '';
    if (rawCode.isEmpty) return;
    final normalizedRawCode = _normalizedScanKey(rawCode);

    final now = DateTime.now();
    if (_scanPausedUntil != null && now.isBefore(_scanPausedUntil!)) return;
    if (_lastRawScan == normalizedRawCode &&
        _lastScannedTime != null &&
        now.difference(_lastScannedTime!) < _duplicateCooldown) {
      return;
    }
    if (_syncingScan) return;

    final bin = _binController.text.trim().toUpperCase();
    if (bin.isEmpty) {
      setState(() => _statusText = 'Please enter/select bin location first.');
      await _errorFeedback();
      return;
    }

    setState(() {
      _lastScannedCode = rawCode;
      _lastScannedTime = now;
      _syncingScan = true;
      _statusText = 'Saving scan...';
    });

    try {
      final result = await ref.read(syncQueueProvider.notifier).addScan(
            rawCode,
            scanType: _scanType,
            dealerCode: _dealerController.text.trim().toUpperCase(),
            binLocation: bin,
            syncNow: true,
          );
      await _handleScanResult(
        result: result,
        raw: rawCode,
        normalizedRaw: normalizedRawCode,
      );
    } catch (error) {
      await _errorFeedback();
      if (mounted) {
        setState(() =>
            _statusText = error.toString().replaceFirst('Exception: ', ''));
      }
    } finally {
      if (mounted) setState(() => _syncingScan = false);
    }
  }

  bool _validManualPart(String value) {
    return RegExp(r'^[A-Z0-9][A-Z0-9._/-]{2,39}$')
        .hasMatch(value.trim().toUpperCase());
  }

  String _statusFromSyncResult(
      Map<String, dynamic> result, int duplicateCount) {
    if (duplicateCount > 0) return 'Duplicate scan';
    if (result['success'] != true) {
      final failedRows = result['failedRows'];
      if (failedRows is List && failedRows.isNotEmpty) {
        final firstRow = failedRows.first;
        final firstPart = firstRow is Map
            ? '${firstRow['partNumber'] ?? firstRow['part'] ?? ''}'.trim()
            : '';
        final reason = failedRows
            .map((row) => row is Map
                ? '${row['reason'] ?? row['message'] ?? row['errorMessage'] ?? ''}'
                : '$row')
            .where((text) => text.isNotEmpty)
            .join(', ');
        if (RegExp(r'not found|reject', caseSensitive: false)
            .hasMatch(reason)) {
          return firstPart.isEmpty
              ? 'Part not found in master. Scan rejected.'
              : 'Part $firstPart not in master. Scan rejected.';
        }
        if (reason.isNotEmpty) return reason;
      }
      return result['message']?.toString() ?? 'Scan rejected';
    }
    final inserted = result['insertedRecords'];
    if (inserted is List && inserted.isNotEmpty) {
      final first = inserted.first;
      if (first is Map) {
        final warnings = first['warnings'];
        final warningText =
            warnings is List ? warnings.join(', ') : '$warnings';
        if (warningText.toLowerCase().contains('not found')) {
          return 'Part not found in master';
        }
      }
    }
    return 'Unique scan saved successfully';
  }

  Future<void> _manualEntry() async {
    final partController = TextEditingController();
    final qtyController = TextEditingController(text: '1');
    final value = await showDialog<Map<String, String>>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Manual Part Entry'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: partController,
              autofocus: true,
              textCapitalization: TextCapitalization.characters,
              decoration:
                  const InputDecoration(labelText: 'Part number / raw scan'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: qtyController,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [
                FilteringTextInputFormatter.allow(RegExp(r'^\d*\.?\d{0,2}')),
              ],
              decoration: const InputDecoration(
                labelText: 'Quantity',
                prefixIcon: Icon(Icons.numbers_rounded),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(context, {
                    'part': partController.text,
                    'qty': qtyController.text,
                  }),
              child: const Text('Save')),
        ],
      ),
    );
    partController.dispose();
    qtyController.dispose();
    final text = value?['part']?.trim();
    if (text == null || text.isEmpty) return;
    final qty = double.tryParse(value?['qty']?.trim() ?? '') ?? 0;
    if (qty <= 0) {
      setState(() => _statusText = 'Enter valid quantity.');
      await _errorFeedback();
      return;
    }
    if (_binController.text.trim().isEmpty) {
      setState(() => _statusText = 'Please enter/select bin location first.');
      await _errorFeedback();
      return;
    }
    if (!_validManualPart(text)) {
      setState(() => _statusText = 'Invalid part number format');
      await _errorFeedback();
      return;
    }
    try {
      final result = await ref.read(syncQueueProvider.notifier).addScan(
            text,
            scanType: _scanType,
            dealerCode: _dealerController.text.trim().toUpperCase(),
            binLocation: _binController.text.trim().toUpperCase(),
            quantity: qty,
            source: 'manual',
            syncNow: true,
          );
      await _handleScanResult(
        result: result,
        raw: text,
        normalizedRaw: _normalizedScanKey(text),
        qty: qty.toString(),
        manualEntry: true,
      );
      if (mounted) {
        setState(() {
          _lastScannedCode = text;
        });
      }
    } catch (error) {
      await _errorFeedback();
      if (mounted) {
        setState(() =>
            _statusText = error.toString().replaceFirst('Exception: ', ''));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final connection = ref.watch(mobileConnectionProvider);
    if (connection.dealerCode.isNotEmpty &&
        _dealerController.text.toUpperCase() !=
            connection.dealerCode.toUpperCase()) {
      _dealerController.text = connection.dealerCode.toUpperCase();
    }

    return Scaffold(
      backgroundColor: Colors.black,
      body: LayoutBuilder(
        builder: (context, constraints) {
          final topHeight =
              (constraints.maxHeight * 0.40).clamp(230.0, 330.0).toDouble();
          final localScanWindow = Rect.fromCenter(
            center: Offset(constraints.maxWidth / 2, topHeight / 2 + 16),
            width: constraints.maxWidth * 0.72,
            height: topHeight * 0.58,
          );
          return Column(
            children: [
              SizedBox(
                height: topHeight,
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    MobileScanner(
                      controller: _scannerController,
                      scanWindow: localScanWindow,
                      onDetect: _onDetect,
                      errorBuilder: (context, error, child) {
                        return const Center(
                          child: Text(
                            'Camera Initialization Failed.\nPlease check permissions.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: Colors.white, fontSize: 16),
                          ),
                        );
                      },
                    ),
                    CustomPaint(
                      painter:
                          _ScannerOverlayPainter(scanWindow: localScanWindow),
                    ),
                    Positioned(
                      top: MediaQuery.of(context).padding.top + 10,
                      left: 12,
                      right: 12,
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          IconButton(
                            style: IconButton.styleFrom(
                                backgroundColor:
                                    AppTheme.surfaceColor.withOpacity(0.8)),
                            icon: const Icon(Icons.arrow_back_rounded,
                                color: Colors.white),
                            onPressed: () => Navigator.of(context).pop(),
                          ),
                          IconButton(
                            style: IconButton.styleFrom(
                                backgroundColor:
                                    AppTheme.surfaceColor.withOpacity(0.8)),
                            icon: Icon(
                              _isFlashOn
                                  ? Icons.flash_on_rounded
                                  : Icons.flash_off_rounded,
                              color: _isFlashOn
                                  ? AppTheme.secondaryColor
                                  : Colors.white,
                            ),
                            onPressed: () {
                              _scannerController.toggleTorch();
                              setState(() => _isFlashOn = !_isFlashOn);
                            },
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: Container(
                  width: double.infinity,
                  color: const Color(0xFFF6F7FB),
                  child: SafeArea(
                    top: false,
                    minimum: const EdgeInsets.only(bottom: 16),
                    child: LayoutBuilder(
                      builder: (context, panelConstraints) {
                        final listHeight = (panelConstraints.maxHeight * 0.22)
                            .clamp(72.0, 120.0)
                            .toDouble();

                        return SingleChildScrollView(
                          keyboardDismissBehavior:
                              ScrollViewKeyboardDismissBehavior.onDrag,
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding: const EdgeInsets.fromLTRB(12, 10, 12, 20),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              _ScanOptions(
                                scanType: _scanType,
                                onScanTypeChanged: (value) =>
                                    setState(() => _scanType = value),
                                dealerController: _dealerController,
                                binController: _binController,
                                beepEnabled: _beepEnabled,
                                vibrationEnabled: _vibrationEnabled,
                                onBeepChanged: (value) =>
                                    setState(() => _beepEnabled = value),
                                onVibrationChanged: (value) =>
                                    setState(() => _vibrationEnabled = value),
                                onTestBeep: _testBeep,
                                onTestVibration: _testVibration,
                              ),
                              const SizedBox(height: 8),
                              SizedBox(
                                width: double.infinity,
                                height: 52,
                                child: ElevatedButton.icon(
                                  style: ElevatedButton.styleFrom(
                                    backgroundColor: AppTheme.primaryColor,
                                    foregroundColor: Colors.white,
                                    shape: RoundedRectangleBorder(
                                      borderRadius: BorderRadius.circular(10),
                                    ),
                                  ),
                                  icon: const Icon(Icons.keyboard_rounded),
                                  label: const Text(
                                    'MANUAL PART ENTRY',
                                    style: TextStyle(
                                      fontSize: 15,
                                      fontWeight: FontWeight.bold,
                                    ),
                                  ),
                                  onPressed: _manualEntry,
                                ),
                              ),
                              const SizedBox(height: 8),
                              _LastScanSummary(
                                statusText: _statusText,
                                lastCode: _lastScannedCode,
                                scanType: _scanType,
                                bin: _binController.text.toUpperCase(),
                              ),
                              const SizedBox(height: 8),
                              SizedBox(
                                height: listHeight,
                                child: _LastScanList(scans: _lastScans),
                              ),
                            ],
                          ),
                        );
                      },
                    ),
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

class _ScanOptions extends StatelessWidget {
  const _ScanOptions({
    required this.scanType,
    required this.onScanTypeChanged,
    required this.dealerController,
    required this.binController,
    required this.beepEnabled,
    required this.vibrationEnabled,
    required this.onBeepChanged,
    required this.onVibrationChanged,
    required this.onTestBeep,
    required this.onTestVibration,
  });

  final String scanType;
  final ValueChanged<String> onScanTypeChanged;
  final TextEditingController dealerController;
  final TextEditingController binController;
  final bool beepEnabled;
  final bool vibrationEnabled;
  final ValueChanged<bool> onBeepChanged;
  final ValueChanged<bool> onVibrationChanged;
  final VoidCallback onTestBeep;
  final VoidCallback onTestVibration;

  @override
  Widget build(BuildContext context) {
    Widget typeButton(String value, String label, Color color) {
      final selected = scanType == value;
      return Expanded(
        child: GestureDetector(
          onTap: () => onScanTypeChanged(value),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 180),
            padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
            decoration: BoxDecoration(
              color: selected ? color : Colors.white,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: color, width: 1.5),
            ),
            child: Center(
              child: Text(
                label,
                style: TextStyle(
                  color: selected ? Colors.white : color,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
          ),
        ),
      );
    }

    return Card(
      color: Colors.white.withOpacity(0.92),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                typeButton('INWARD', 'Inward', const Color(0xFF15803D)),
                const SizedBox(width: 8),
                typeButton('OUTWARD', 'Outward', const Color(0xFFB91C1C)),
                const SizedBox(width: 8),
                typeButton('VERIFICATION', 'Verify', const Color(0xFF0F4C81)),
              ],
            ),
            const SizedBox(height: 10),
            TextField(
              controller: dealerController,
              readOnly: true,
              style: const TextStyle(
                  color: Colors.white, fontWeight: FontWeight.w700),
              decoration: const InputDecoration(
                labelText: 'Dealer Code',
                labelStyle: TextStyle(color: Colors.white70),
                floatingLabelStyle: TextStyle(color: Colors.white70),
                prefixIcon: Icon(Icons.store_rounded, color: Colors.white70),
              ),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: binController,
              textCapitalization: TextCapitalization.characters,
              style: const TextStyle(
                  color: Colors.white, fontWeight: FontWeight.w700),
              decoration: const InputDecoration(
                labelText: 'Bin Location',
                labelStyle: TextStyle(color: Colors.white70),
                floatingLabelStyle: TextStyle(color: Colors.white70),
                prefixIcon: Icon(Icons.location_on, color: Colors.white70),
              ),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: SwitchListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Beep Sound'),
                    value: beepEnabled,
                    onChanged: onBeepChanged,
                  ),
                ),
                TextButton(
                  onPressed: beepEnabled ? onTestBeep : null,
                  child: const Text('Test Beep'),
                ),
              ],
            ),
            Row(
              children: [
                Expanded(
                  child: SwitchListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Vibration'),
                    value: vibrationEnabled,
                    onChanged: onVibrationChanged,
                  ),
                ),
                TextButton(
                  onPressed: vibrationEnabled ? onTestVibration : null,
                  child: const Text('Test Vibration'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _LastScanSummary extends StatelessWidget {
  const _LastScanSummary({
    required this.statusText,
    required this.lastCode,
    required this.scanType,
    required this.bin,
  });

  final String statusText;
  final String? lastCode;
  final String scanType;
  final String bin;

  @override
  Widget build(BuildContext context) {
    final success = RegExp(r'saved|unique|success', caseSensitive: false)
        .hasMatch(statusText);
    final duplicate =
        RegExp(r'duplicate', caseSensitive: false).hasMatch(statusText);
    final rejected =
        RegExp(r'not found|failed|invalid|reject', caseSensitive: false)
            .hasMatch(statusText);
    final color = duplicate
        ? Colors.orange.shade700
        : rejected
            ? Colors.red.shade700
            : success
                ? AppTheme.successColor
                : AppTheme.primaryColor;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: color.withOpacity(0.55), width: 1.3),
      ),
      child: Row(
        children: [
          Icon(
            duplicate
                ? Icons.copy_rounded
                : rejected
                    ? Icons.error_rounded
                    : success
                        ? Icons.check_circle_rounded
                        : Icons.info_rounded,
            color: color,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(statusText,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style:
                        TextStyle(color: color, fontWeight: FontWeight.w800)),
                const SizedBox(height: 2),
                Text(
                  '${lastCode ?? '-'} | $scanType | Bin ${bin.isEmpty ? '-' : bin}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Colors.black54, fontSize: 12),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _LastScanList extends StatelessWidget {
  const _LastScanList({required this.scans});

  final List<Map<String, String>> scans;

  @override
  Widget build(BuildContext context) {
    if (scans.isEmpty) {
      return const Center(
        child: Text('No scans yet', style: TextStyle(color: Colors.black45)),
      );
    }
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: Colors.black12),
      ),
      child: ListView.separated(
        padding: EdgeInsets.zero,
        itemCount: scans.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, index) {
          final scan = scans[index];
          final duplicate = scan['status'] == 'Duplicate';
          final rejected = scan['status'] == 'Rejected';
          return ListTile(
            dense: true,
            visualDensity: VisualDensity.compact,
            leading: Icon(
              duplicate
                  ? Icons.copy_rounded
                  : rejected
                      ? Icons.error_outline_rounded
                      : Icons.check_rounded,
              color: duplicate
                  ? Colors.orange.shade700
                  : rejected
                      ? Colors.red.shade700
                      : AppTheme.successColor,
            ),
            title: Text(
              scan['part'] ?? '',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: Colors.black87,
                fontWeight: FontWeight.w700,
              ),
            ),
            subtitle: Text(
              '${scan['status']} | Qty ${scan['qty']} | Bin ${scan['bin']} | ${scan['type']}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(color: Colors.black54),
            ),
            trailing: Text(
              scan['time'] ?? '',
              style: const TextStyle(color: Colors.black54, fontSize: 11),
            ),
          );
        },
      ),
    );
  }
}

class _ScannerOverlayPainter extends CustomPainter {
  final Rect scanWindow;
  final double borderRadius = 12.0;

  _ScannerOverlayPainter({required this.scanWindow});

  @override
  void paint(Canvas canvas, Size size) {
    final backgroundPaint = Paint()
      ..color = Colors.black.withOpacity(0.65)
      ..style = PaintingStyle.fill;

    final borderPaint = Paint()
      ..color = AppTheme.primaryColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = 4.0
      ..strokeCap = StrokeCap.round;

    final backgroundPath = Path()
      ..addRect(Rect.fromLTWH(0, 0, size.width, size.height))
      ..addRRect(
          RRect.fromRectAndRadius(scanWindow, Radius.circular(borderRadius)))
      ..fillType = PathFillType.evenOdd;

    canvas.drawPath(backgroundPath, backgroundPaint);

    // Draw custom bracket corners around the scan window cutout
    const double cornerLength = 35.0;

    // Top Left
    canvas.drawLine(scanWindow.topLeft.translate(0, borderRadius),
        scanWindow.topLeft.translate(0, cornerLength), borderPaint);
    canvas.drawLine(scanWindow.topLeft.translate(borderRadius, 0),
        scanWindow.topLeft.translate(cornerLength, 0), borderPaint);
    canvas.drawArc(
        Rect.fromLTWH(scanWindow.left, scanWindow.top, borderRadius * 2,
            borderRadius * 2),
        3.14,
        1.57,
        false,
        borderPaint);

    // Top Right
    canvas.drawLine(scanWindow.topRight.translate(0, borderRadius),
        scanWindow.topRight.translate(0, cornerLength), borderPaint);
    canvas.drawLine(scanWindow.topRight.translate(-borderRadius, 0),
        scanWindow.topRight.translate(-cornerLength, 0), borderPaint);
    canvas.drawArc(
        Rect.fromLTWH(scanWindow.right - borderRadius * 2, scanWindow.top,
            borderRadius * 2, borderRadius * 2),
        -1.57,
        1.57,
        false,
        borderPaint);

    // Bottom Left
    canvas.drawLine(scanWindow.bottomLeft.translate(0, -borderRadius),
        scanWindow.bottomLeft.translate(0, -cornerLength), borderPaint);
    canvas.drawLine(scanWindow.bottomLeft.translate(borderRadius, 0),
        scanWindow.bottomLeft.translate(cornerLength, 0), borderPaint);
    canvas.drawArc(
        Rect.fromLTWH(scanWindow.left, scanWindow.bottom - borderRadius * 2,
            borderRadius * 2, borderRadius * 2),
        1.57,
        1.57,
        false,
        borderPaint);

    // Bottom Right
    canvas.drawLine(scanWindow.bottomRight.translate(0, -borderRadius),
        scanWindow.bottomRight.translate(0, -cornerLength), borderPaint);
    canvas.drawLine(scanWindow.bottomRight.translate(-borderRadius, 0),
        scanWindow.bottomRight.translate(-cornerLength, 0), borderPaint);
    canvas.drawArc(
        Rect.fromLTWH(
            scanWindow.right - borderRadius * 2,
            scanWindow.bottom - borderRadius * 2,
            borderRadius * 2,
            borderRadius * 2),
        0,
        1.57,
        false,
        borderPaint);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
