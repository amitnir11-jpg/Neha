import 'dart:async';
import 'dart:convert';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:uuid/uuid.dart';

import '../models/scan_record.dart';
import '../services/api_client.dart';
import '../services/local_database.dart';
import '../services/settings_store.dart';
import '../services/sync_service.dart';
import '../widgets/status_chip.dart';
import 'pending_sync_screen.dart';
import 'settings_screen.dart';

class ScannerHomeScreen extends StatefulWidget {
  const ScannerHomeScreen({super.key, required this.onLogout});

  final VoidCallback onLogout;

  @override
  State<ScannerHomeScreen> createState() => _ScannerHomeScreenState();
}

class _ScannerHomeScreenState extends State<ScannerHomeScreen>
    with WidgetsBindingObserver {
  static const _duplicateWindow = Duration(milliseconds: 1400);
  static const _backgroundSyncInterval = Duration(minutes: 2);

  final _settings = SettingsStore();
  final _database = LocalDatabase.instance;
  final _syncService = SyncService();
  final _defaultBinController = TextEditingController();
  final _cameraController = MobileScannerController(
    cameraResolution: const Size(640, 480),
    detectionSpeed: DetectionSpeed.normal,
    detectionTimeoutMs: 80,
    facing: CameraFacing.back,
    formats: const [
      BarcodeFormat.qrCode,
      BarcodeFormat.code128,
      BarcodeFormat.code39,
      BarcodeFormat.code93,
      BarcodeFormat.ean13,
      BarcodeFormat.ean8,
      BarcodeFormat.upcA,
      BarcodeFormat.upcE,
      BarcodeFormat.itf,
      BarcodeFormat.codabar,
      BarcodeFormat.dataMatrix,
      BarcodeFormat.pdf417,
      BarcodeFormat.aztec,
    ],
  );

  Timer? _foregroundSyncTimer;
  StreamSubscription<ConnectivityResult>? _connectivitySub;
  List<ScanRecord> _lastScans = [];
  String _scanType = 'INWARD';
  String _dealerCode = '';
  String _dealerName = '';
  String _deviceId = '';
  String _userId = '';
  String _userName = '';
  String _role = '';
  String _lastRaw = '';
  DateTime _lastRawAt = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _lastSyncAt = DateTime.fromMillisecondsSinceEpoch(0);
  final Map<String, DateTime> _recentScanCache = {};
  bool _online = false;
  bool _serverConnected = false;
  bool _savingScan = false;
  bool _syncInFlight = false;
  int _pendingCount = 0;
  int _failedCount = 0;
  String _statusText = 'Ready';
  Color _statusColor = Colors.blue;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _loadState();
    _connectivitySub = Connectivity().onConnectivityChanged.listen((result) {
      final hasNetwork = result != ConnectivityResult.none;
      if (mounted) setState(() => _online = hasNetwork);
      if (hasNetwork) _setStatus('Online - background sync ready', Colors.blue);
    });
    _foregroundSyncTimer = Timer.periodic(_backgroundSyncInterval, (_) {
      if (!_online || _syncInFlight) return;
      if (_pendingCount > 0 || _failedCount > 0) {
        unawaited(_syncPending(silent: true));
      } else {
        unawaited(_testServer(silent: true));
      }
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _foregroundSyncTimer?.cancel();
    _connectivitySub?.cancel();
    _defaultBinController.dispose();
    _cameraController.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.inactive ||
        state == AppLifecycleState.detached) {
      unawaited(_cameraController.stop());
    } else if (state == AppLifecycleState.resumed) {
      unawaited(_cameraController.start());
      _testServer(silent: true);
    }
  }

  Future<void> _loadState() async {
    final session = await _settings.session;
    final network = await Connectivity().checkConnectivity();
    final dealerCode = await _settings.dealerCode;
    final dealerName = await _settings.dealerName;
    final deviceId = await _settings.deviceId;
    if (!mounted) return;
    setState(() {
      _online = network != ConnectivityResult.none;
      _dealerCode = dealerCode;
      _dealerName = dealerName;
      _deviceId = deviceId;
      _userId = session['loginId'] ?? session['userId'] ?? '';
      _userName = session['userName'] ?? session['loginId'] ?? '';
      _role = session['role'] ?? '';
    });
    await _refreshLocalState();
    await _testServer(silent: true);
    await _registerDevice();
  }

  Future<void> _refreshLocalState() async {
    final rows = await _database.lastScans();
    final pending = await _database.countByStatus('Pending');
    final failed = await _database.countByStatus('Failed');
    if (!mounted) return;
    setState(() {
      _lastScans = rows;
      _pendingCount = pending;
      _failedCount = failed;
    });
  }

  Future<void> _registerDevice() async {
    if (_deviceId.isEmpty || _dealerCode.isEmpty) return;
    try {
      await ApiClient(_settings).registerDevice(
        deviceId: _deviceId,
        dealerCode: _dealerCode,
        pendingCount: _pendingCount.toString(),
        failedCount: _failedCount.toString(),
      );
      if (mounted) setState(() => _serverConnected = true);
    } catch (_) {
      // Device registration is refreshed on the next successful sync/heartbeat.
    }
  }

  Future<void> _testServer({bool silent = false}) async {
    try {
      await ApiClient(_settings).health();
      if (!mounted) return;
      setState(() {
        _serverConnected = true;
        _online = true;
        if (!silent) {
          _statusText = 'Server connected';
          _statusColor = Colors.green;
        }
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _serverConnected = false;
        if (!silent) {
          _statusText = 'Server offline';
          _statusColor = Colors.orange;
        }
      });
    }
  }

  Future<void> _syncPending({bool silent = false}) async {
    if (_syncInFlight) return;
    setState(() => _syncInFlight = true);
    try {
      final result = await _syncService.syncPending();
      final syncedAt = DateTime.now();
      await _refreshLocalState();
      await _registerDevice();
      if (!mounted) return;
      setState(() {
        _lastSyncAt = syncedAt;
        if (result.serverReached) _serverConnected = true;
        if (silent) return;
        _statusText = result.success
            ? result.message
            : (result.message.trim().isEmpty ? 'Sync failed' : result.message);
        _statusColor = result.success ? Colors.green : Colors.red;
      });
    } finally {
      _syncInFlight = false;
      if (mounted) setState(() {});
    }
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    final raw = capture.barcodes
        .map((barcode) => barcode.rawValue)
        .whereType<String>()
        .map((value) => value.trim())
        .firstWhere((value) => value.isNotEmpty, orElse: () => '');
    if (raw.isEmpty) return;

    final now = DateTime.now();
    _recentScanCache.removeWhere(
        (_, seenAt) => now.difference(seenAt) > _duplicateWindow);
    if ((_lastRaw == raw && now.difference(_lastRawAt) < _duplicateWindow) ||
        (_recentScanCache[raw] != null &&
            now.difference(_recentScanCache[raw]!) < _duplicateWindow)) {
      _setStatus('Duplicate skipped', Colors.orange);
      return;
    }
    _lastRaw = raw;
    _lastRawAt = now;
    _recentScanCache[raw] = now;
    unawaited(_handleDraft(
        _ScanDraft.fromRaw(raw, fallbackBin: _defaultBinController.text),
        source: 'mobile'));
  }

  Future<void> _handleDraft(_ScanDraft draft, {required String source}) async {
    if (_dealerCode.isEmpty) {
      _setStatus('Dealer code required', Colors.red);
      return;
    }
    if (_userId.isEmpty) {
      _setStatus('Login required', Colors.red);
      return;
    }
    if (draft.partNumber.isEmpty || draft.binLocation.isEmpty) {
      _setStatus('Invalid QR', Colors.red);
      return;
    }

    try {
      final now = DateTime.now();
      final record = ScanRecord(
        localId: 'MOB-${const Uuid().v4()}',
        rawValue: draft.rawValue,
        partNumber: draft.partNumber,
        quantity: draft.quantity,
        binLocation: draft.binLocation,
        scanType: _scanType,
        dealerCode: _dealerCode,
        userId: _userId,
        userName: _userName,
        deviceId: _deviceId,
        createdAt: now,
        status: 'Pending',
        source: source,
      );

      _showInstantScan(record);
      unawaited(SystemSound.play(SystemSoundType.click));
      unawaited(HapticFeedback.mediumImpact());
      unawaited(_saveScanLocally(record));
    } catch (error) {
      _setStatus(error.toString(), Colors.red);
    }
  }

  void _showInstantScan(ScanRecord record) {
    if (!mounted) return;
    setState(() {
      _savingScan = true;
      _statusText = 'Saved locally';
      _statusColor = Colors.green;
      _pendingCount += 1;
      _lastScans = [record, ..._lastScans].take(10).toList();
    });
    Future.delayed(const Duration(milliseconds: 180), () {
      if (mounted) setState(() => _savingScan = false);
    });
  }

  Future<void> _saveScanLocally(ScanRecord record) async {
    try {
      await _database.insertScan(record);
      await _refreshLocalState();
      if (!_online && mounted) _setStatus('Offline saved', Colors.orange);
    } catch (error) {
      if (mounted) _setStatus('Local save failed', Colors.red);
    }
  }

  void _setStatus(String text, Color color) {
    if (!mounted) return;
    setState(() {
      _statusText = text;
      _statusColor = color;
    });
  }

  Future<void> _openManualEntry() async {
    final draft = await showDialog<_ScanDraft>(
      context: context,
      builder: (_) => _ManualEntryDialog(
          scanType: _scanType, fallbackBin: _defaultBinController.text),
    );
    if (draft != null) await _handleDraft(draft, source: 'manual');
  }

  Future<void> _openPendingSync() async {
    await Navigator.of(context)
        .push(MaterialPageRoute(builder: (_) => const PendingSyncScreen()));
    await _refreshLocalState();
  }

  Future<void> _openSettings() async {
    await Navigator.of(context)
        .push(MaterialPageRoute(builder: (_) => const SettingsScreen()));
    await _loadState();
  }

  Future<void> _verifyLastScan() async {
    final value = _lastScans.isNotEmpty ? _lastScans.first.rawValue : '';
    final controller = TextEditingController(text: value);
    final query = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Last Scan Verification'),
        content: TextField(
          controller: controller,
          textCapitalization: TextCapitalization.characters,
          decoration:
              const InputDecoration(labelText: 'QR / Barcode / Part Number'),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(context, controller.text.trim()),
              child: const Text('Verify')),
        ],
      ),
    );
    controller.dispose();
    if (query == null || query.isEmpty) return;
    try {
      final result =
          await ApiClient(_settings).verifyScan(query, dealerCode: _dealerCode);
      _setStatus(result['scanned'] == true ? 'Success' : 'Invalid QR',
          result['scanned'] == true ? Colors.green : Colors.red);
    } catch (_) {
      _setStatus('Sync failed', Colors.red);
    }
  }

  Future<void> _logout() async {
    await _settings.clearSession();
    widget.onLogout();
  }

  Color _recordColor(ScanRecord record) {
    if (record.status == 'Synced') return Colors.green;
    if (record.status == 'Failed') return Colors.red;
    return Colors.orange;
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Daksh Scanner'),
        actions: [
          IconButton(onPressed: _openPendingSync, icon: const Icon(Icons.sync)),
          IconButton(
              onPressed: _openSettings, icon: const Icon(Icons.settings)),
          IconButton(onPressed: _logout, icon: const Icon(Icons.logout)),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            _StatusHeader(
              dealerCode: _dealerCode,
              dealerName: _dealerName,
              userName: _userName,
              role: _role,
              online: _online,
              serverConnected: _serverConnected,
              pendingCount: _pendingCount,
              failedCount: _failedCount,
              syncRunning: _syncInFlight,
              lastSyncAt: _lastSyncAt,
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
              child: Row(
                children: [
                  Expanded(
                      child: _ModeButton(
                          label: 'Inward',
                          selected: _scanType == 'INWARD',
                          onTap: () => setState(() => _scanType = 'INWARD'))),
                  const SizedBox(width: 8),
                  Expanded(
                      child: _ModeButton(
                          label: 'Outward',
                          selected: _scanType == 'OUTWARD',
                          onTap: () => setState(() => _scanType = 'OUTWARD'))),
                  const SizedBox(width: 8),
                  Expanded(
                      child: _ModeButton(
                          label: 'Verify',
                          selected: _scanType == 'VERIFICATION',
                          onTap: () =>
                              setState(() => _scanType = 'VERIFICATION'))),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              child: TextField(
                controller: _defaultBinController,
                textCapitalization: TextCapitalization.characters,
                decoration: const InputDecoration(
                  labelText: 'Default Bin Location',
                  prefixIcon: Icon(Icons.inventory_2),
                  isDense: true,
                ),
                onChanged: (value) {
                  final upper = value.toUpperCase();
                  if (value != upper) {
                    _defaultBinController.value = TextEditingValue(
                        text: upper,
                        selection:
                            TextSelection.collapsed(offset: upper.length));
                  }
                },
              ),
            ),
            Container(
              height: MediaQuery.of(context).size.height * 0.38,
              margin: const EdgeInsets.fromLTRB(12, 10, 12, 8),
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                  color: Colors.black, borderRadius: BorderRadius.circular(8)),
              child: Stack(
                fit: StackFit.expand,
                children: [
                  MobileScanner(
                      controller: _cameraController, onDetect: _onDetect),
                  AnimatedOpacity(
                    opacity: _savingScan ? 1 : 0,
                    duration: const Duration(milliseconds: 120),
                    child: Container(color: Colors.green.withOpacity(0.22)),
                  ),
                  Center(
                    child: Container(
                      width: 220,
                      height: 150,
                      decoration: BoxDecoration(
                        border: Border.all(
                            color: Colors.white.withOpacity(0.85), width: 2),
                        borderRadius: BorderRadius.circular(8),
                      ),
                    ),
                  ),
                  Positioned(
                    left: 12,
                    right: 12,
                    bottom: 12,
                    child: Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 12, vertical: 10),
                      decoration: BoxDecoration(
                          color: Colors.black.withOpacity(0.72),
                          borderRadius: BorderRadius.circular(8)),
                      child: Row(
                        children: [
                          Icon(
                              _statusColor == Colors.green
                                  ? Icons.check_circle
                                  : _statusColor == Colors.red
                                      ? Icons.error
                                      : Icons.info,
                              color: _statusColor),
                          const SizedBox(width: 8),
                          Expanded(
                              child: Text(_statusText,
                                  style: const TextStyle(
                                      color: Colors.white,
                                      fontWeight: FontWeight.w900))),
                          if (_savingScan)
                            const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                    strokeWidth: 2, color: Colors.white)),
                        ],
                      ),
                    ),
                  ),
                  Positioned(
                    top: 10,
                    right: 10,
                    child: Row(
                      children: [
                        IconButton.filledTonal(
                            onPressed: () => _cameraController.toggleTorch(),
                            icon: const Icon(Icons.flash_on)),
                        const SizedBox(width: 8),
                        IconButton.filledTonal(
                            onPressed: () => _cameraController.switchCamera(),
                            icon: const Icon(Icons.cameraswitch)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
              child: Row(
                children: [
                  Expanded(
                      child: OutlinedButton.icon(
                          onPressed: _openManualEntry,
                          icon: const Icon(Icons.keyboard),
                          label: const Text('Manual Entry'))),
                  const SizedBox(width: 8),
                  Expanded(
                      child: OutlinedButton.icon(
                          onPressed: _verifyLastScan,
                          icon: const Icon(Icons.fact_check),
                          label: const Text('Last Verify'))),
                  const SizedBox(width: 8),
                  Expanded(
                      child: FilledButton.icon(
                          onPressed: _syncInFlight ? null : () => _syncPending(),
                          icon: const Icon(Icons.sync),
                          label: Text(_syncInFlight ? 'Syncing' : 'Manual Sync'))),
                ],
              ),
            ),
            Expanded(
              child: Container(
                width: double.infinity,
                color: Colors.white,
                child: _lastScans.isEmpty
                    ? const Center(
                        child: Text('No scans yet',
                            style: TextStyle(fontWeight: FontWeight.w800)))
                    : ListView.separated(
                        itemCount: _lastScans.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (_, index) {
                          final scan = _lastScans[index];
                          final color = _recordColor(scan);
                          return ListTile(
                            dense: true,
                            leading: Icon(
                                scan.source == 'manual'
                                    ? Icons.keyboard
                                    : Icons.qr_code_scanner,
                                color: color),
                            title: Text('${scan.partNumber}  x${scan.quantity}',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w900)),
                            subtitle: Text(
                                '${scan.scanType} | ${scan.binLocation} | ${scan.rawValue}',
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis),
                            trailing: Text(scan.status,
                                style: TextStyle(
                                    color: color, fontWeight: FontWeight.w900)),
                          );
                        },
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusHeader extends StatelessWidget {
  const _StatusHeader({
    required this.dealerCode,
    required this.dealerName,
    required this.userName,
    required this.role,
    required this.online,
    required this.serverConnected,
    required this.pendingCount,
    required this.failedCount,
    required this.syncRunning,
    required this.lastSyncAt,
  });

  final String dealerCode;
  final String dealerName;
  final String userName;
  final String role;
  final bool online;
  final bool serverConnected;
  final int pendingCount;
  final int failedCount;
  final bool syncRunning;
  final DateTime lastSyncAt;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 8),
      color: Colors.white,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '${dealerName.isEmpty ? 'Dealer' : dealerName} ${dealerCode.isEmpty ? '' : '($dealerCode)'}',
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w900),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 4),
          Text('$userName ${role.isEmpty ? '' : '| $role'}',
              style: const TextStyle(
                  color: Colors.black54, fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              StatusChip(
                  label: online ? 'Online' : 'Offline',
                  color: online ? Colors.green : Colors.orange,
                  icon: online ? Icons.wifi : Icons.wifi_off),
              StatusChip(
                  label:
                      serverConnected ? 'Server connected' : 'Server pending',
                  color: serverConnected ? Colors.green : Colors.orange,
                  icon: Icons.cloud_done),
              StatusChip(
                  label: 'Login verified',
                  color: userName.isEmpty ? Colors.red : Colors.green,
                  icon: Icons.verified_user),
              StatusChip(
                  label: 'Pending $pendingCount',
                  color: pendingCount == 0 ? Colors.green : Colors.orange,
                  icon: Icons.sync_problem),
              StatusChip(
                  label: syncRunning ? 'Sync running' : 'Fast mode',
                  color: syncRunning ? Colors.blue : Colors.green,
                  icon: syncRunning ? Icons.sync : Icons.flash_on),
              StatusChip(
                  label: lastSyncAt.millisecondsSinceEpoch == 0
                      ? 'Last sync: Never'
                      : 'Last sync: ${TimeOfDay.fromDateTime(lastSyncAt).format(context)}',
                  color: Colors.blueGrey,
                  icon: Icons.schedule),
              if (failedCount > 0)
                StatusChip(
                    label: 'Failed $failedCount',
                    color: Colors.red,
                    icon: Icons.error),
            ],
          ),
        ],
      ),
    );
  }
}

class _ModeButton extends StatelessWidget {
  const _ModeButton(
      {required this.label, required this.selected, required this.onTap});

  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return selected
        ? FilledButton(
            onPressed: onTap,
            child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis))
        : OutlinedButton(
            onPressed: onTap,
            child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis));
  }
}

class _ManualEntryDialog extends StatefulWidget {
  const _ManualEntryDialog({required this.scanType, required this.fallbackBin});

  final String scanType;
  final String fallbackBin;

  @override
  State<_ManualEntryDialog> createState() => _ManualEntryDialogState();
}

class _ManualEntryDialogState extends State<_ManualEntryDialog> {
  late final TextEditingController _partController;
  late final TextEditingController _qtyController;
  late final TextEditingController _binController;

  @override
  void initState() {
    super.initState();
    _partController = TextEditingController();
    _qtyController = TextEditingController(text: '1');
    _binController = TextEditingController(text: _upper(widget.fallbackBin));
  }

  @override
  void dispose() {
    _partController.dispose();
    _qtyController.dispose();
    _binController.dispose();
    super.dispose();
  }

  void _uppercase(TextEditingController controller, String value) {
    final upper = _upper(value);
    if (value == upper) return;
    controller.value = TextEditingValue(
        text: upper, selection: TextSelection.collapsed(offset: upper.length));
  }

  void _submit() {
    final part = _upper(_partController.text);
    final bin = _upper(_binController.text);
    final qty = int.tryParse(_qtyController.text.trim()) ?? 1;
    if (part.isEmpty || bin.isEmpty || qty <= 0) return;
    Navigator.pop(
      context,
      _ScanDraft(
        rawValue: 'MANUAL:$part:$bin:${DateTime.now().toIso8601String()}',
        partNumber: part,
        quantity: qty,
        binLocation: bin,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('${widget.scanType} Manual Entry'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _partController,
            textCapitalization: TextCapitalization.characters,
            decoration: const InputDecoration(labelText: 'Part Number'),
            onChanged: (value) => _uppercase(_partController, value),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _qtyController,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: 'Qty'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _binController,
            textCapitalization: TextCapitalization.characters,
            decoration: const InputDecoration(labelText: 'Bin Location'),
            onChanged: (value) => _uppercase(_binController, value),
          ),
        ],
      ),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel')),
        FilledButton(onPressed: _submit, child: const Text('Save')),
      ],
    );
  }
}

class _ScanDraft {
  const _ScanDraft({
    required this.rawValue,
    required this.partNumber,
    required this.quantity,
    required this.binLocation,
  });

  final String rawValue;
  final String partNumber;
  final int quantity;
  final String binLocation;

  factory _ScanDraft.fromRaw(String raw, {String fallbackBin = ''}) {
    final text = raw.trim();
    var part = '';
    var bin = _upper(fallbackBin);
    var qty = 1;

    try {
      final parsed = jsonDecode(text);
      if (parsed is Map<String, dynamic>) {
        part = _upper(parsed['partNumber'] ??
            parsed['partNo'] ??
            parsed['part'] ??
            parsed['sku'] ??
            parsed['itemCode']);
        bin = _upper(parsed['binLocation'] ??
            parsed['bin'] ??
            parsed['location'] ??
            bin);
        qty = int.tryParse('${parsed['qty'] ?? parsed['quantity'] ?? 1}') ?? 1;
      }
    } catch (_) {
      final upperText = _upper(text);
      part = _matchValue(upperText,
          r'(?:PART\s*NO|PART|PN|SKU|ITEM)[:=#\-\s]+([A-Z0-9._/-]{3,40})');
      bin = _matchValue(upperText,
                  r'(?:BIN|LOCATION|LOC)[:=#\-\s]+([A-Z0-9._/-]{1,30})')
              .isEmpty
          ? bin
          : _matchValue(
              upperText, r'(?:BIN|LOCATION|LOC)[:=#\-\s]+([A-Z0-9._/-]{1,30})');
      qty = int.tryParse(_matchValue(
              upperText, r'(?:QTY|QUANTITY)[:=#\-\s]+([0-9]{1,5})')) ??
          1;
      if (part.isEmpty) {
        final slashParts = upperText
            .split('/')
            .map((value) => value.trim())
            .where((value) => value.isNotEmpty)
            .toList();
        if (slashParts.length >= 4) part = slashParts[3];
      }
      if (part.isEmpty &&
          RegExp(r'^[A-Z0-9][A-Z0-9._/-]{2,39}$').hasMatch(upperText)) {
        part = upperText;
      }
    }

    return _ScanDraft(
      rawValue: text,
      partNumber: _upper(part),
      quantity: qty <= 0 ? 1 : qty,
      binLocation: _upper(bin),
    );
  }
}

String _upper(Object? value) =>
    value == null ? '' : value.toString().trim().toUpperCase();

String _matchValue(String text, String pattern) {
  final match = RegExp(pattern, caseSensitive: false).firstMatch(text);
  return match == null ? '' : _upper(match.group(1));
}
