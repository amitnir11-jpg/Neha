import 'dart:async';
import 'dart:convert';

import 'package:audioplayers/audioplayers.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:uuid/uuid.dart';

import '../models/scan_record.dart';
import '../services/socket_service.dart';
import '../services/api_client.dart';
import '../services/local_database.dart';
import '../services/server_discovery.dart';
import '../services/settings_store.dart';
import '../services/sync_service.dart';
import '../utils/scan_parser.dart';
import '../widgets/status_chip.dart';
import '../widgets/smart_part_field.dart';
import 'pending_sync_screen.dart';
import 'settings_screen.dart';

class ScannerHomeScreen extends StatefulWidget {
  const ScannerHomeScreen({super.key, required this.onLogout});

  final VoidCallback onLogout;

  @override
  State<ScannerHomeScreen> createState() => _ScannerHomeScreenState();
}

class _SmartBinChoice {
  const _SmartBinChoice(this.action, {this.selectedBin = ''});

  final String action;
  final String selectedBin;
}

class _ScannerHomeScreenState extends State<ScannerHomeScreen>
    with WidgetsBindingObserver {
  static const _backgroundSyncInterval = Duration(minutes: 2);
  static const _noQrClearTimeout = Duration(milliseconds: 1000);
  static const _healthCheckInterval = Duration(seconds: 60);

  final _settings = SettingsStore();
  final _database = LocalDatabase.instance;
  final _syncService = SyncService();
  final _defaultBinController = TextEditingController();
  final _scanAudioPlayer = AudioPlayer();
  final _cameraController = MobileScannerController(
    cameraResolution: const Size(1280, 720),
    detectionSpeed: DetectionSpeed.normal,
    detectionTimeoutMs: 120,
    facing: CameraFacing.back,
    useNewCameraSelector: true,
    // Empty format list means every ML Kit format, including QR and 1D.
    formats: const <BarcodeFormat>[],
  );
  final _cameraFrames = CameraFrameGuard();
  static const _scanDebug = bool.fromEnvironment('SCAN_DECODE_LOGS');

  Timer? _foregroundSyncTimer;
  Timer? _qrIdleTimer;
  StreamSubscription<ConnectivityResult>? _connectivitySub;
  List<ScanRecord> _lastScans = [];
  String _scanType = 'INWARD';
  String _dealerCode = '';
  String _dealerName = '';
  String _deviceId = '';
  String _userId = '';
  String _userName = '';
  String _role = '';
  String _activeAuditId = '';
  String _currentlyVisibleCode = '';
  DateTime _lastHealthCheckAt = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _lastDiscoveryAt = DateTime.fromMillisecondsSinceEpoch(0);
  DateTime _lastSyncAt = DateTime.fromMillisecondsSinceEpoch(0);
  bool _online = false;
  bool _serverConnected = false;
  bool _savingScan = false;
  bool _syncInFlight = false;
  bool _syncRequested = false;
  Timer? _liveRefreshTimer;
  bool _duplicateDialogOpen = false;
  bool _movementPromptOpen = false;
  Map<String, dynamic> _partStock = {};
  int _pendingCount = 0;
  int _failedCount = 0;
  String _clockSkewWarning = '';
  final _socket = SocketService();
  String _statusText = 'Ready';
  Color _statusColor = Colors.blue;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_scanAudioPlayer.setReleaseMode(ReleaseMode.stop));
    _loadState().then((_) async {
      try {
        await _socket.connect(_settings);
        void scheduleLiveRefresh([dynamic _]) {
          _liveRefreshTimer?.cancel();
          _liveRefreshTimer = Timer(const Duration(milliseconds: 250), () {
            if (mounted) unawaited(_refreshRecentScans(forceServer: true));
          });
        }

        _socket.on('sync:clockSkew', (data) {
          try {
            if (data is Map) {
              final device = (data['deviceId'] ?? '').toString();
              final skew = (data['skewMs'] ?? 0) is int
                  ? (data['skewMs'] as int)
                  : int.tryParse((data['skewMs'] ?? '0').toString()) ?? 0;
              if (device.isEmpty || device == _deviceId) {
                final minutes = (skew / 60000).toStringAsFixed(1);
                if (mounted) {
                  setState(() => _clockSkewWarning =
                      'Device clock differs from server by $minutes minutes. Server time used. Please open Date/Time Settings.');
                }
              }
            }
          } catch (_) {}
        });
        _socket.on('sync:clockSkewNotify', (data) {
          try {
            if (data is Map) {
              final deviceIds = (data['deviceIds'] as List<dynamic>?)
                      ?.map((value) => value.toString().trim())
                      .where((value) => value.isNotEmpty)
                      .toList() ??
                  [];
              if (deviceIds.contains(_deviceId)) {
                final message = (data['message'] ??
                        'Please correct device date/time settings.')
                    .toString();
                if (mounted) setState(() => _clockSkewWarning = message);
              }
            }
          } catch (_) {}
        });
        _socket.on('scan:saved', scheduleLiveRefresh);
        _socket.on('scan:deleted', scheduleLiveRefresh);
        _socket.on('sync:completed', scheduleLiveRefresh);
      } catch (_) {}
    });

    _connectivitySub = Connectivity().onConnectivityChanged.listen((result) {
      final hasNetwork = result != ConnectivityResult.none;
      if (mounted) setState(() => _online = hasNetwork);
      if (hasNetwork) {
        _setStatus('Online - finding Daksh server...', Colors.blue);
        unawaited(_autoDiscoverServer(force: true).then((_) {
          unawaited(_testServer(silent: true, force: true));
        }));
      }
    });
    _foregroundSyncTimer = Timer.periodic(_backgroundSyncInterval, (_) {
      if (!_online || _syncInFlight) return;
      if (_pendingCount > 0) {
        unawaited(_syncPending(silent: true));
      } else if (_failedCount == 0) {
        unawaited(_testServer(silent: true));
      }
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _foregroundSyncTimer?.cancel();
    _liveRefreshTimer?.cancel();
    _qrIdleTimer?.cancel();
    _connectivitySub?.cancel();
    _defaultBinController.dispose();
    _cameraController.dispose();
    unawaited(_scanAudioPlayer.dispose());
    try {
      _socket.off('sync:clockSkew');
      _socket.off('sync:clockSkewNotify');
      _socket.dispose();
    } catch (_) {}
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
      unawaited(_autoDiscoverServer(force: true).then((_) {
        unawaited(_testServer(silent: true, force: true));
      }));
    }
  }

  Future<void> _loadState() async {
    final session = await _settings.session;
    final network = await Connectivity().checkConnectivity();
    final dealerCode = await _settings.dealerCode;
    final dealerName = await _settings.dealerName;
    final deviceId = await _settings.deviceId;
    final savedAuditId = await _settings.auditContextForDealer(dealerCode);
    if (!mounted) return;
    setState(() {
      _online = network != ConnectivityResult.none;
      _dealerCode = dealerCode;
      _dealerName = dealerName;
      _deviceId = deviceId;
      _activeAuditId = savedAuditId;
      _userId = session['loginId'] ?? session['userId'] ?? '';
      _userName = session['userName'] ?? session['loginId'] ?? '';
      _role = session['role'] ?? '';
      _statusText = _online ? 'Checking server...' : 'Offline mode';
      _statusColor = _online ? Colors.blue : Colors.orange;
    });
    await _refreshLocalState();
    if (_online) {
      await _autoDiscoverServer(force: true);
    }
    await _refreshRecentScans(forceServer: _online);
    if (_online) {
      await _refreshAuditContext();
    }
    if (_online) {
      await _testServer(silent: true);
      await _registerDevice();
    }
  }

  Future<void> _refreshLocalState({bool refreshRecent = false}) async {
    final pending = await _database.countByStatus('Pending');
    final failed = await _database.countByStatus('Failed');
    if (!mounted) return;
    setState(() {
      _pendingCount = pending;
      _failedCount = failed;
    });
    if (refreshRecent) {
      await _refreshRecentScans(forceServer: true);
    }
  }

  Future<void> _refreshAuditContext() async {
    if (_dealerCode.isEmpty) return;
    try {
      final data = await ApiClient(_settings).config(dealerCode: _dealerCode);
      final activeAudit = data['activeAudit'];
      final auditId = activeAudit is Map
          ? (activeAudit['auditId'] ?? activeAudit['_id'] ?? '')
          : (data['auditId'] ?? '');
      final refreshedAuditId = auditId.toString().trim();
      if (!mounted) return;
      setState(() {
        _activeAuditId = refreshedAuditId;
      });
      await _settings.saveAuditContext(_dealerCode, refreshedAuditId);
    } catch (_) {}
  }

  Future<void> _autoDiscoverServer({bool force = false}) async {
    if (!_online && !force) return;
    final now = DateTime.now();
    if (!force &&
        now.difference(_lastDiscoveryAt) < const Duration(minutes: 1)) {
      return;
    }
    _lastDiscoveryAt = now;
    try {
      final server = await ServerDiscovery().discoverAndSave(_settings);
      if (server == null) return;
      _socket.dispose();
      await _socket.connect(_settings);
      if (!mounted) return;
      _setStatus('Connected to ${server.serverUrl}', Colors.green);
    } catch (_) {}
  }

  Future<void> _refreshRecentScans({bool forceServer = false}) async {
    List<ScanRecord> rows = [];
    if (_online && (_serverConnected || forceServer)) {
      try {
        rows = await ApiClient(_settings)
            .recentScans(limit: 20, dealerCode: _dealerCode);
      } catch (_) {}
    }
    if (!_online) {
      rows = await _database.lastScans(limit: 20);
    }
    if (!mounted) return;
    setState(() {
      _lastScans = rows.take(20).toList();
    });
    if (_online && rows.isNotEmpty && rows.first.partNumber.isNotEmpty) {
      try {
        final totals = await ApiClient(_settings).partStock(rows.first.partNumber,
            dealerCode: _dealerCode, auditId: _activeAuditId);
        if (mounted) setState(() => _partStock = totals);
      } catch (_) {}
    }
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

  Future<void> _testServer({bool silent = false, bool force = false}) async {
    final now = DateTime.now();
    if (!force && now.difference(_lastHealthCheckAt) < _healthCheckInterval) {
      return;
    }
    _lastHealthCheckAt = now;
    if (!silent && mounted) {
      setState(() {
        _statusText = 'Checking server...';
        _statusColor = Colors.blue;
      });
    }
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

  Future<void> _syncPending(
      {bool silent = false, bool includeFailed = false}) async {
    // Scans can be saved while the previous batch is uploading.  Remember the
    // request so that the newly saved rows are uploaded as soon as that batch
    // completes instead of waiting for the two-minute background timer.
    if (_syncInFlight) {
      _syncRequested = true;
      return;
    }
    setState(() {
      _syncInFlight = true;
      if (!silent) {
        _statusText = 'Syncing pending records...';
        _statusColor = Colors.blue;
      }
    });
    try {
      final result =
          await _syncService.syncPending(includeFailed: includeFailed);
      final syncedAt = DateTime.now();
      await _refreshLocalState();
      if (result.duplicateRecords.isNotEmpty && mounted) {
        final duplicate = result.duplicateRecords.first;
        await _showDuplicateScanAlert(
          _ScanDraft(
            rawValue: duplicate.rawValue,
            partNumber: duplicate.partNumber,
            quantity: duplicate.quantity,
            binLocation: duplicate.binLocation,
          ),
          reason: duplicate.errorMessage.isEmpty
              ? 'This code was already scanned.'
              : duplicate.errorMessage,
        );
      }
      if (result.success) await _refreshRecentScans(forceServer: true);
      if (!mounted) return;
      setState(() {
        _lastSyncAt = syncedAt;
        if (result.serverReached) _serverConnected = true;
        if (!_clockSkewWarning.isNotEmpty || !result.hasClockSkew) {
          _clockSkewWarning =
              result.hasClockSkew ? result.message : _clockSkewWarning;
        }
        // Background sync stays quiet on success, but failures must be visible
        // so "Saved locally" is never mistaken for a server-confirmed scan.
        if (!silent || !result.success) {
          _statusText = result.success
              ? result.message
              : result.message.trim().isEmpty
                  ? 'Sync failed - scan remains pending'
                  : '${result.serverReached ? 'Scan not synced' : 'Sync pending'}: ${result.message}';
          _statusColor = result.success ? Colors.green : Colors.red;
        }
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _statusText = error.toString();
        _statusColor = Colors.red;
      });
    } finally {
      if (mounted) {
        setState(() => _syncInFlight = false);
      } else {
        _syncInFlight = false;
      }
      final syncAgain = _syncRequested;
      _syncRequested = false;
      if (syncAgain && mounted) {
        unawaited(_syncPending(silent: true));
      }
    }
  }

  Future<void> _playScanBeep({bool duplicate = false}) async {
    try {
      await _scanAudioPlayer.stop();
      await _scanAudioPlayer.play(
        AssetSource('sounds/scan_beep.wav'),
        volume: duplicate ? 1.0 : 0.95,
      );
    } catch (_) {
      try {
        await SystemSound.play(
            duplicate ? SystemSoundType.alert : SystemSoundType.click);
      } catch (_) {}
    }
  }

  Future<void> _showDuplicateScanAlert(
    _ScanDraft draft, {
    ScanRecord? existingRecord,
    String reason = 'This code was already scanned.',
  }) async {
    if (_duplicateDialogOpen || !mounted) return;
    _duplicateDialogOpen = true;
    try {
      unawaited(_playScanBeep(duplicate: true));
      unawaited(HapticFeedback.heavyImpact());
      await showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (dialogContext) {
          final record = existingRecord;
          final partNumber = record != null && record.partNumber.isNotEmpty
              ? record.partNumber
              : draft.partNumber;
          final binLocation = record != null
              ? [
                  record.binLocation,
                  record.metadata['smartBinSelectedBin'],
                  record.metadata['smartBinCurrentBin'],
                  record.metadata['smartBinSuggestedBin'],
                  draft.binLocation,
                ]
                  .map((value) => value == null
                      ? ''
                      : value.toString().trim().toUpperCase())
                  .firstWhere((value) => value.isNotEmpty, orElse: () => '')
              : draft.binLocation;
          final quantity = record?.quantity ?? draft.quantity;
          final status = record?.status ?? 'Duplicate';
          final createdAt = record?.createdAt.toLocal();
          final rawValue = record != null && record.rawValue.isNotEmpty
              ? record.rawValue
              : draft.rawValue;
          final locationBanner = binLocation.isNotEmpty
              ? 'Already available in bin $binLocation'
              : 'This item has already been scanned';
          final details = <Widget>[
            Text(
              reason,
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 12),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                color: Colors.orange.shade50,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Colors.orange.shade200),
              ),
              child: Text(
                locationBanner,
                style: const TextStyle(fontWeight: FontWeight.w800),
              ),
            ),
            const SizedBox(height: 12),
            if (partNumber.isNotEmpty) _duplicateInfoRow('Part', partNumber),
            if (binLocation.isNotEmpty)
              _duplicateInfoRow('Location', binLocation),
            _duplicateInfoRow('Qty', quantity.toString()),
            _duplicateInfoRow('Status', status),
            if (createdAt != null)
              _duplicateInfoRow('Scanned',
                  TimeOfDay.fromDateTime(createdAt).format(dialogContext)),
            if (rawValue.isNotEmpty) ...[
              const SizedBox(height: 6),
              Text(
                rawValue,
                maxLines: 3,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12, color: Colors.black54),
              ),
            ],
          ];
          return AlertDialog(
            title: const Text('Duplicate scan'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: details,
              ),
            ),
            actions: [
              FilledButton(
                onPressed: () => Navigator.of(dialogContext).pop(),
                child: const Text('OK'),
              ),
            ],
          );
        },
      );
    } finally {
      _duplicateDialogOpen = false;
    }
  }

  Widget _duplicateInfoRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 76,
            child: Text(
              '$label:',
              style: const TextStyle(fontWeight: FontWeight.w800),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
    );
  }

  Future<String?> _chooseSkuBin(List<Map<String, dynamic>> bins) {
    return showDialog<String>(context: context, builder: (dialogContext) => SimpleDialog(
      title: const Text('Choose SKU source bin'),
      children: [
        const Padding(padding: EdgeInsets.all(16), child: Text('This barcode identifies a part, not a unique piece. Choose the bin you are taking it from.')),
        ...bins.map((bin) => SimpleDialogOption(
          onPressed: () => Navigator.pop(dialogContext, '${bin['binLocation']}'),
          child: Text('${bin['binLocation']} — ${bin['availableQty']} available'))),
        SimpleDialogOption(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
      ],
    ));
  }

  Future<Map<String, String>?> _fittedDetails() async {
    final vehicle = TextEditingController();
    final job = TextEditingController();
    final formKey = GlobalKey<FormState>();
    try {
      return await showDialog<Map<String, String>>(context: context, builder: (dialogContext) => AlertDialog(
        title: const Text('Fitted vehicle details'),
        content: Form(key: formKey, child: Column(mainAxisSize: MainAxisSize.min, children: [
          TextFormField(controller: vehicle, decoration: const InputDecoration(labelText: 'Vehicle registration'),
            validator: (value) => (value ?? '').trim().isEmpty ? 'Required' : null),
          TextFormField(controller: job, decoration: const InputDecoration(labelText: 'Job card number'),
            validator: (value) => (value ?? '').trim().isEmpty ? 'Required' : null),
        ])),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel')),
          FilledButton(onPressed: () {
            if (formKey.currentState?.validate() == true) {
              Navigator.pop(dialogContext, {
                'regdNo': _upper(vehicle.text), 'jobCardNo': _upper(job.text)
              });
            }
          }, child: const Text('Save fitted')),
        ],
      ));
    } finally { vehicle.dispose(); job.dispose(); }
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_movementPromptOpen) { return; }
    if (_requiresBinBeforeScan && _upper(_defaultBinController.text).isEmpty) {
      _setStatus('Enter bin location before scanning', Colors.red);
      return;
    }
    final decoded = capture.barcodes
        .where((barcode) =>
            (barcode.rawValue ?? barcode.displayValue ?? '').trim().isNotEmpty)
        .firstOrNull;
    if (decoded == null) return;
    final rawValue = decoded.rawValue ?? decoded.displayValue ?? '';
    final raw = normalizeDecodedValue(rawValue);
    if (!_cameraFrames.accept('$_deviceId|$_scanType|$raw')) return;
    if (kDebugMode || _scanDebug) {
      debugPrint('[SCAN_DECODE] ${jsonEncode({
            'rawValue': rawValue,
            'normalizedValue': raw,
            'barcodeFormat': decoded.format.name
          })}');
    }

    _qrIdleTimer?.cancel();
    _qrIdleTimer = Timer(_noQrClearTimeout, () {
      _currentlyVisibleCode = '';
    });

    if (_currentlyVisibleCode != raw) {
      _currentlyVisibleCode = raw;
    }

    final draft = _ScanDraft.fromRaw(rawValue,
        fallbackBin: _defaultBinController.text,
        barcodeFormat: decoded.format.name);

    unawaited(_handleDraft(draft, source: 'mobile'));
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
    if (draft.partNumber.isEmpty && draft.rawValue.isEmpty) {
      _setStatus('Invalid QR', Colors.red);
      return;
    }
    if (_requiresBinBeforeScan && draft.binLocation.isEmpty) {
      _setStatus('Bin location required before scanning', Colors.red);
      return;
    }
    if (_scanType == 'VERIFICATION') {
      await _verifyDraft(draft);
      return;
    }

    try {
      // Use the cached audit context on the capture path. The server validates
      // the active audit on every save, and the user can explicitly refresh
      // connection context if the audit changes while this screen is open.
      if (_online && _activeAuditId.isEmpty) {
        _setStatus(
            'No active audit context available. Refresh the server before scanning.',
            Colors.red);
        return;
      }

      final currentBin = ['OUTWARD', 'FITTED'].contains(_scanType) && source != 'manual'
          ? '' : _upper(draft.binLocation);
      final api = ApiClient(_settings);
      Future<Map<String, dynamic>?>? smartBinFuture;
      if (source == 'manual' &&
          _isSmartBinEligible(_scanType) &&
          _online &&
          _activeAuditId.isNotEmpty) {
        // The read-only preflight can run alongside the local duplicate check.
        // Previously these two independent waits happened one after the other.
        smartBinFuture = api
            .smartBinCheck(
              dealerCode: _dealerCode,
              auditId: _activeAuditId,
              partNumber: draft.partNumber,
              partDescription: draft.partDescription,
              binLocation: currentBin,
              scanType: _scanType,
              qty: draft.quantity,
            )
            .then<Map<String, dynamic>?>((value) => value)
            .catchError((_) => null);
      }

      final duplicateRecord = await _database.latestMatchingScan(
              rawValue: draft.rawValue,
              scanType: _scanType,
              dealerCode: _dealerCode,
              auditId: _activeAuditId,
              userId: _userId,
            );
      if (duplicateRecord != null) {
        await _showDuplicateScanAlert(
          draft,
          existingRecord: duplicateRecord,
          reason: 'This part was already scanned.',
        );
        _setStatus('Already scanned', Colors.orange);
        return;
      }

      if (_activeAuditId.isEmpty) {
        _setStatus(
            'No audit context available. Connect to the server and refresh before scanning.',
            Colors.red);
        return;
      }

      final localId = 'MOB-${const Uuid().v4()}';
      Map<String, dynamic>? smartBinSuggestion;
      if (smartBinFuture != null) smartBinSuggestion = await smartBinFuture;

      var resolvedBin = currentBin;
      var resolvedPart = draft.partNumber;
      var resolvedQuantity = draft.quantity;
      var metadata = <String, dynamic>{};
      final captureMode = _scanType;
      if (source != 'manual' && _online) {
        _movementPromptOpen = true;
        try {
          final resolved = await api.resolveCode(draft.rawValue, draft.barcodeFormat, dealerCode: _dealerCode);
          final parsed = Map<String, dynamic>.from(resolved['parsedCode'] as Map? ?? {});
          resolvedPart = '${parsed['partNumber'] ?? ''}';
          final decodedQuantity = parsed['quantity'];
          if (parsed['type'] == 'HERO_QR' && decodedQuantity is num && decodedQuantity.toInt() > 0) {
            resolvedQuantity = decodedQuantity.toInt();
          }
          metadata['parsedCode'] = parsed;
          final master = Map<String, dynamic>.from(resolved['master'] as Map? ?? {});
          metadata['partDescription'] = master['partDescription'] ?? master['partName'] ?? '';
          if (parsed['identityKind'] == 'SKU' && ['OUTWARD', 'FITTED', 'DAMAGE'].contains(captureMode)) {
            final bins = (resolved['binOptions'] as List? ?? []).whereType<Map>().map((bin) => Map<String, dynamic>.from(bin)).toList();
            if (bins.isEmpty) { _setStatus('No eligible physical SKU stock. Scan a unique UPI for tracked stock.', Colors.red); return; }
            if (resolvedBin.isEmpty || !bins.any((bin) => bin['binLocation'] == resolvedBin)) {
              resolvedBin = bins.length == 1 ? '${bins.first['binLocation']}'
                  : await _chooseSkuBin(bins) ?? '';
              if (resolvedBin.isEmpty) { _setStatus('Source bin selection cancelled', Colors.orange); return; }
            }
          }
        } on ApiException catch (error) {
          // A plain existing UPI may have no standalone Part Master match.
          if (!['OUTWARD', 'FITTED'].contains(captureMode) || draft.rawValue.contains('/')) rethrow;
          if (error.statusCode != 422) rethrow;
        } finally { _movementPromptOpen = false; }
      }
      if (_scanType != captureMode) return;
      if (captureMode == 'FITTED') {
        _movementPromptOpen = true;
        Map<String, String>? details;
        try { details = await _fittedDetails(); } finally { _movementPromptOpen = false; }
        if (details == null) { _setStatus('Fitted details cancelled', Colors.orange); return; }
        metadata.addAll(details);
      }
      if (draft.partDescription.isNotEmpty) {
        metadata['partDescription'] = draft.partDescription;
        metadata['partName'] = draft.partDescription;
      }
      if (smartBinSuggestion != null &&
          _smartBinExistingBins(smartBinSuggestion).isNotEmpty &&
          source == 'manual' &&
          _smartBinExistingBins(smartBinSuggestion)
              .any((bin) => _upper(bin['binLocation']) == currentBin)) {
        final confirmed = await _showSameBinQuantityPrompt(
            smartBinSuggestion, currentBin, draft.quantity);
        if (confirmed != true) {
          _setStatus('Manual quantity confirmation cancelled', Colors.orange);
          return;
        }
        metadata.addAll(_sameBinQuantityMetadata(
          smartBinSuggestion,
          currentBin: currentBin,
          localId: localId,
          qty: draft.quantity,
        ));
      } else if (smartBinSuggestion != null &&
          (smartBinSuggestion['shouldPrompt'] == true ||
              _smartBinExistingBins(smartBinSuggestion).isNotEmpty)) {
        final choice =
            await _showSmartBinPrompt(smartBinSuggestion, currentBin);
        if (choice == null) {
          _setStatus('Smart bin confirmation cancelled', Colors.orange);
          return;
        }
        final decision = choice.action;
        final selectedExistingBin = _upper(choice.selectedBin);
        resolvedBin =
            decision == 'USE_EXISTING_BIN' && selectedExistingBin.isNotEmpty
                ? selectedExistingBin
                : currentBin;
        metadata = _smartBinMetadata(
          smartBinSuggestion,
          decision: decision,
          currentBin: currentBin,
          selectedBin: resolvedBin,
        );
      }

      final now = DateTime.now();
      final record = ScanRecord(
        localId: localId,
        rawValue: draft.rawValue,
        partNumber: resolvedPart,
        quantity: resolvedQuantity,
        binLocation: resolvedBin,
        scanType: _scanType,
        dealerCode: _dealerCode,
        auditId: _activeAuditId,
        userId: _userId,
        userName: _userName,
        deviceId: _deviceId,
        createdAt: now,
        status: 'Pending',
        source: source,
        metadata: {
          ...metadata,
          if (source != 'manual') ...{
            'cameraDecoded': true,
            'rawDecodedValue': draft.rawValue,
            'barcodeFormat': draft.barcodeFormat
          }
        },
      );

      _showInstantScan(record);
      unawaited(_playScanBeep());
      unawaited(HapticFeedback.mediumImpact());
      unawaited(_saveScanLocally(record));
    } catch (error) {
      _setStatus(error.toString(), Colors.red);
    }
  }

  Future<void> _verifyDraft(_ScanDraft draft) async {
    try {
      final result = await ApiClient(_settings)
          .verifyScan(draft.rawValue, dealerCode: _dealerCode);
      final found = result['found'] == true || result['scanned'] == true;
      final message =
          (result['message'] ?? (found ? 'Part Found' : 'Part Not Found'))
              .toString();
      _setStatus(
          '$message${draft.partNumber.isEmpty ? '' : ' ${draft.partNumber}'}',
          found ? Colors.amber.shade700 : Colors.red);
      unawaited(SystemSound.play(
          found ? SystemSoundType.click : SystemSoundType.alert));
      if (found) {
        unawaited(HapticFeedback.mediumImpact());
      } else {
        unawaited(HapticFeedback.vibrate());
      }
    } catch (error) {
      _setStatus('Verification failed', Colors.red);
    }
  }

  void _showInstantScan(ScanRecord record) {
    if (!mounted) return;
    setState(() {
      _savingScan = true;
      _statusText = 'Saved locally';
      _statusColor = Colors.green;
      _pendingCount += 1;
      _lastScans = [record, ..._lastScans].take(20).toList();
    });
    Future.delayed(const Duration(milliseconds: 180), () {
      if (mounted) setState(() => _savingScan = false);
    });
  }

  Future<void> _saveScanLocally(ScanRecord record) async {
    try {
      await _database.insertScan(record);
      // Start upload as soon as the durable local insert completes. Refreshing
      // the two status counters first adds extra SQLite round trips to every scan.
      if (!_online && mounted) {
        _setStatus('Offline saved', Colors.orange);
      } else {
        // If online, try to sync immediately so the scan is sent to the server
        try {
          unawaited(_syncPending(silent: true));
        } catch (_) {}
      }
      unawaited(_refreshLocalState());
    } catch (error) {
      if (mounted) _setStatus('Local save failed', Colors.red);
    }
  }

  bool _isSmartBinEligible(String scanType) {
    final type = scanType.trim().toUpperCase();
    return type == 'INWARD' || type == 'DAMAGE';
  }

  List<Map<String, dynamic>> _smartBinExistingBins(
      Map<String, dynamic> suggestion) {
    final rawBins = suggestion['existingBins'];
    if (rawBins is! List) return [];
    return rawBins
        .map((entry) {
          if (entry is Map<String, dynamic>) {
            return Map<String, dynamic>.from(entry);
          }
          if (entry is Map) {
            return entry.map((key, value) => MapEntry(key.toString(), value));
          }
          return <String, dynamic>{'binLocation': entry.toString()};
        })
        .map((entry) => {
              ...entry,
              'binLocation': _upper(entry['binLocation']),
              'qty': entry['qty'] ?? entry['quantity'] ?? 0,
            })
        .where((entry) => (entry['binLocation'] ?? '').toString().isNotEmpty)
        .toList();
  }

  Map<String, dynamic> _smartBinMetadata(
    Map<String, dynamic> suggestion, {
    required String decision,
    required String currentBin,
    required String selectedBin,
  }) {
    final now = DateTime.now().toUtc().toIso8601String();
    return {
      'smartBinDecision': decision,
      'smartBinReason': decision == 'SAVE_NEW_BIN'
          ? 'User confirmed different bin'
          : 'User selected existing bin',
      'smartBinSuggestedBin': _upper(suggestion['suggestedBin'] ?? currentBin),
      'smartBinSelectedBin': _upper(selectedBin),
      'smartBinCurrentBin': _upper(currentBin),
      'smartBinExistingBins': _smartBinExistingBins(suggestion),
      'smartBinAllowMultipleLocations':
          suggestion['allowMultipleLocations'] ?? true,
      'smartBinMaxAllowedLocationsPerPart':
          suggestion['maxAllowedLocationsPerPart'] ?? 3,
      'smartBinReasonRequired': suggestion['reasonRequired'] ?? true,
      'smartBinCheckedAt': (suggestion['checkedAt'] ?? now).toString(),
      'smartBinDecisionAt': now,
      'smartBinDecisionBy': _userName.isNotEmpty ? _userName : _userId,
      'smartBinLocationType':
          decision == 'SAVE_NEW_BIN' ? 'SECONDARY' : 'PRIMARY',
      'smartBinIsSecondaryLocation': decision == 'SAVE_NEW_BIN',
    };
  }

  Map<String, dynamic> _sameBinQuantityMetadata(
    Map<String, dynamic> suggestion, {
    required String currentBin,
    required String localId,
    required int qty,
  }) {
    final now = DateTime.now().toUtc().toIso8601String();
    return {
      'confirmAddQuantity': true,
      'addManualQuantity': true,
      'manualAddRequestId': localId,
      'smartBinDecision': 'ADD_MANUAL_QUANTITY',
      'smartBinReason': 'User confirmed same-bin manual quantity add',
      'smartBinSuggestedBin': currentBin,
      'smartBinSelectedBin': currentBin,
      'smartBinCurrentBin': currentBin,
      'smartBinExistingBins': _smartBinExistingBins(suggestion),
      'smartBinAllowMultipleLocations':
          suggestion['allowMultipleLocations'] ?? true,
      'smartBinMaxAllowedLocationsPerPart':
          suggestion['maxAllowedLocationsPerPart'] ?? 3,
      'smartBinReasonRequired': false,
      'smartBinCheckedAt': (suggestion['checkedAt'] ?? now).toString(),
      'smartBinDecisionAt': now,
      'smartBinDecisionBy': _userName.isNotEmpty ? _userName : _userId,
      'smartBinLocationType': 'PRIMARY',
      'smartBinIsSecondaryLocation': false,
      'requestedQty': qty,
    };
  }

  Future<bool?> _showSameBinQuantityPrompt(
      Map<String, dynamic> suggestion, String currentBin, int addQty) {
    final existingBins = _smartBinExistingBins(suggestion);
    final sameBin = existingBins.firstWhere(
      (bin) => _upper(bin['binLocation']) == currentBin,
      orElse: () => <String, dynamic>{'binLocation': currentBin},
    );
    final partNumber = _upper(suggestion['partNumber']);
    final qty = sameBin['qty'] ?? sameBin['quantity'] ?? 0;
    final description =
        (suggestion['partDescription'] ?? suggestion['partName'] ?? '')
            .toString()
            .trim();
    return showDialog<bool>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) {
        return AlertDialog(
          title: const Text('Part Already Available'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Part $partNumber is already available in bin $currentBin.'),
              const SizedBox(height: 8),
              Text('Current qty: ${qty.toString()}'),
              Text('Add qty: $addQty'),
              if (description.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text(description),
              ],
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(dialogContext, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(dialogContext, true),
              child: const Text('Add Qty'),
            ),
          ],
        );
      },
    );
  }

  Future<_SmartBinChoice?> _showSmartBinPrompt(
      Map<String, dynamic> suggestion, String currentBin) async {
    final existingBins = _smartBinExistingBins(suggestion);
    final existingBin = _upper(suggestion['existingBin'] ??
        (existingBins.isNotEmpty ? existingBins.first['binLocation'] : '') ??
        currentBin);
    final partNumber = _upper(suggestion['partNumber']);
    final partDescription =
        (suggestion['partDescription'] ?? suggestion['partName'] ?? '')
            .toString()
            .trim();
    final title =
        (suggestion['promptTitle'] ?? 'PART ALREADY AVAILABLE IN OTHER BIN')
            .toString()
            .trim();
    final message = (suggestion['message'] ?? '').toString().trim();
    var selectedExistingBin = existingBin;
    return showDialog<_SmartBinChoice>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) {
        return StatefulBuilder(
          builder: (dialogContext, setDialogState) {
            return AlertDialog(
              title: Text(title),
              content: SingleChildScrollView(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(message.isNotEmpty
                        ? message
                        : 'Part $partNumber is already available in another bin.'),
                    const SizedBox(height: 12),
                    if (partDescription.isNotEmpty)
                      Text('Description: $partDescription'),
                    if (existingBins.isNotEmpty) ...[
                      const SizedBox(height: 12),
                      const Text(
                        'Scan in existing bin:',
                        style: TextStyle(fontWeight: FontWeight.w700),
                      ),
                      const SizedBox(height: 4),
                      ...existingBins.map((bin) {
                        final binLocation = _upper(bin['binLocation']);
                        final qty = bin['qty'] ?? bin['quantity'] ?? 0;
                        return RadioListTile<String>(
                          dense: true,
                          contentPadding: EdgeInsets.zero,
                          value: binLocation,
                          groupValue: selectedExistingBin,
                          title: Text(binLocation),
                          subtitle: Text('Qty ${qty.toString()}'),
                          onChanged: binLocation.isEmpty
                              ? null
                              : (value) => setDialogState(() {
                                    selectedExistingBin = _upper(value);
                                  }),
                        );
                      }),
                    ],
                    const SizedBox(height: 8),
                    Text('Current bin: $currentBin'),
                  ],
                ),
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(dialogContext),
                  child: const Text('Cancel'),
                ),
                TextButton(
                  onPressed: () => Navigator.pop(
                    dialogContext,
                    _SmartBinChoice('SAVE_NEW_BIN', selectedBin: currentBin),
                  ),
                  child: const Text('Save New Bin'),
                ),
                FilledButton(
                  onPressed: selectedExistingBin.isEmpty
                      ? null
                      : () => Navigator.pop(
                            dialogContext,
                            _SmartBinChoice(
                              'USE_EXISTING_BIN',
                              selectedBin: selectedExistingBin,
                            ),
                          ),
                  child: Text(
                    selectedExistingBin.isNotEmpty
                        ? 'Scan in $selectedExistingBin'
                        : 'Scan in Existing Bin',
                  ),
                ),
              ],
            );
          },
        );
      },
    );
  }

  void _setStatus(String text, Color color) {
    if (!mounted) return;
    setState(() {
      _statusText = text;
      _statusColor = color;
    });
  }

  bool get _requiresBinBeforeScan =>
      _scanType == 'INWARD' || _scanType == 'OUTWARD' || _scanType == 'DAMAGE';

  void _resetScanLock({String message = 'Ready to rescan'}) {
    _qrIdleTimer?.cancel();
    _currentlyVisibleCode = '';
    if (mounted) {
      _setStatus(message, Colors.blue);
    }
  }

  Future<void> _openManualEntry() async {
    final result = await showDialog<Object?>(
      context: context,
      builder: (_) => _ManualEntryDialog(
        scanType: _scanType,
        fallbackBin: _defaultBinController.text,
        settings: _settings,
        dealerCode: _dealerCode,
      ),
    );
    if (result is _ScanDraft) {
      await _handleDraft(result, source: 'manual');
    } else if (result is _LocalPartSaved && mounted) {
      _setStatus('Local Part saved separately from regular stock', Colors.green);
    }
  }

  Future<void> _openPendingSync() async {
    await Navigator.of(context)
        .push(MaterialPageRoute(builder: (_) => const PendingSyncScreen()));
    await _refreshLocalState();
    await _refreshRecentScans(forceServer: true);
  }

  Future<void> _openSettings() async {
    await Navigator.of(context)
        .push(MaterialPageRoute(builder: (_) => const SettingsScreen()));
    await _loadState();
  }

  Future<void> _refreshConnection() async {
    if (!_online) {
      _setStatus('Offline mode, retrying when network returns', Colors.orange);
      return;
    }
    await _autoDiscoverServer(force: true);
    await _testServer(silent: false, force: true);
    if (_serverConnected) {
      await _refreshLocalState();
      await _refreshRecentScans(forceServer: true);
      await _refreshAuditContext();
      await _registerDevice();
    }
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
      final found = result['found'] == true || result['scanned'] == true;
      _setStatus(
          (result['message'] ?? (found ? 'Part Found' : 'Part Not Found'))
              .toString(),
          found ? Colors.amber.shade700 : Colors.red);
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

  String _scanSecondaryLine(ScanRecord scan) {
    if (scan.status == 'Duplicate') {
      return scan.serverSyncId.isNotEmpty ? 'Synced' : 'Duplicate';
    }
    if (scan.status == 'Failed' && scan.errorMessage.isNotEmpty) {
      return scan.errorMessage;
    }
    if (scan.serverSyncId.isNotEmpty && scan.status != 'Synced') {
      return 'Synced';
    }
    return '';
  }

  Color _scanSecondaryColor(ScanRecord scan, Color fallback) {
    if (scan.status == 'Duplicate' && scan.serverSyncId.isNotEmpty) {
      return Colors.green;
    }
    if (scan.status == 'Failed' && scan.errorMessage.isNotEmpty) {
      return Colors.red;
    }
    return fallback;
  }

  @override
  Widget build(BuildContext context) {
    final screenHeight = MediaQuery.of(context).size.height;
    final cameraHeight = (screenHeight * 0.48).clamp(340.0, 520.0).toDouble();

    return Scaffold(
      appBar: AppBar(
        title: const Text('Daksh Scan'),
        actions: [
          IconButton(
              onPressed: _refreshConnection,
              icon: const Icon(Icons.refresh),
              tooltip: 'Retry server'),
          IconButton(onPressed: _openPendingSync, icon: const Icon(Icons.sync)),
          IconButton(
              onPressed: _openSettings, icon: const Icon(Icons.settings)),
          IconButton(onPressed: _logout, icon: const Icon(Icons.logout)),
        ],
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          padding: const EdgeInsets.only(bottom: 12),
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
              if (_clockSkewWarning.isNotEmpty)
                Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  child: Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: Colors.red.shade700,
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Text(
                      _clockSkewWarning,
                      style: const TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                ),
              Padding(
                padding: const EdgeInsets.fromLTRB(10, 8, 10, 6),
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
                            onTap: () =>
                                setState(() => _scanType = 'OUTWARD'))),
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
                padding: const EdgeInsets.symmetric(horizontal: 10),
                child: TextField(
                  controller: _defaultBinController,
                  textCapitalization: TextCapitalization.characters,
                  decoration: const InputDecoration(
                    labelText: 'Source Bin Location *',
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
                height: cameraHeight,
                margin: const EdgeInsets.fromLTRB(10, 8, 10, 6),
                clipBehavior: Clip.antiAlias,
                decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [Color(0xFF09111E), Color(0xFF13233A)],
                    ),
                    borderRadius: BorderRadius.circular(16),
                    boxShadow: const [
                      BoxShadow(
                        color: Color(0x12000000),
                        blurRadius: 18,
                        offset: Offset(0, 8),
                      )
                    ]),
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    MobileScanner(
                      controller: _cameraController,
                      onDetect: _onDetect,
                      fit: BoxFit.cover,
                    ),
                    Positioned(
                      right: 12,
                      top: 12,
                      child: ValueListenableBuilder<MobileScannerState>(
                        valueListenable: _cameraController,
                        builder: (context, camera, _) =>
                            camera.torchState == TorchState.unavailable
                                ? const SizedBox.shrink()
                                : IconButton.filledTonal(
                                    tooltip: camera.torchState == TorchState.on
                                        ? 'Torch OFF'
                                        : 'Torch ON',
                                    onPressed: camera.isRunning
                                        ? () => _cameraController.toggleTorch()
                                        : null,
                                    icon: Icon(
                                        camera.torchState == TorchState.on
                                            ? Icons.flash_on
                                            : Icons.flash_off),
                                  ),
                      ),
                    ),
                    AnimatedOpacity(
                      opacity: _savingScan ? 1 : 0,
                      duration: const Duration(milliseconds: 120),
                      child: Container(color: Colors.green.withOpacity(0.22)),
                    ),
                    Positioned.fill(
                      child: Padding(
                        padding: const EdgeInsets.all(14),
                        child: IgnorePointer(
                          child: Container(
                            decoration: BoxDecoration(
                              border: Border.all(
                                  color: Colors.white.withOpacity(0.88),
                                  width: 2),
                              borderRadius: BorderRadius.circular(14),
                            ),
                          ),
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
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(10, 0, 10, 6),
                child: Column(
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: _openManualEntry,
                            icon: const Icon(Icons.keyboard),
                            label: const FittedBox(
                              fit: BoxFit.scaleDown,
                              child: Text('Manual Entry'),
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: _verifyLastScan,
                            icon: const Icon(Icons.fact_check),
                            label: const FittedBox(
                              fit: BoxFit.scaleDown,
                              child: Text('Last Verify'),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            onPressed: _resetScanLock,
                            icon: const Icon(Icons.replay),
                            label: const FittedBox(
                              fit: BoxFit.scaleDown,
                              child: Text('Rescan'),
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: FilledButton.icon(
                            onPressed: _syncInFlight
                                ? null
                                : () => _syncPending(includeFailed: true),
                            icon: const Icon(Icons.sync),
                            label: FittedBox(
                              fit: BoxFit.scaleDown,
                              child:
                                  Text(_syncInFlight ? 'Syncing' : 'Sync Now'),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              if (_partStock.isNotEmpty) Padding(padding: const EdgeInsets.all(12), child: Text(
                '${_partStock['partNumber']} | Inward ${_partStock['inwardQty']} | Outward ${_partStock['outwardQty']} | Fitted ${_partStock['fittedQty']} | Damage ${_partStock['damageQty']} | Available ${_partStock['availableQty']}')),
              Container(
                width: double.infinity,
                color: Colors.white,
                child: _lastScans.isEmpty
                    ? const SizedBox(
                        height: 120,
                        child: Center(
                            child: Text('No scans yet',
                                style: TextStyle(fontWeight: FontWeight.w800))))
                    : ListView.separated(
                        shrinkWrap: true,
                        physics: const NeverScrollableScrollPhysics(),
                        itemCount: _lastScans.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (_, index) {
                          final scan = _lastScans[index];
                          final color = _recordColor(scan);
                          final detailLine = _scanSecondaryLine(scan);
                          final detailColor = _scanSecondaryColor(scan, color);
                          return ListTile(
                            dense: true,
                            leading: Icon(
                                scan.source == 'manual'
                                    ? Icons.keyboard
                                    : Icons.qr_code_scanner,
                                color: color),
                            title: Text(
                                '${scan.partNumber.isEmpty ? 'Pending validation' : scan.partNumber}  x${scan.quantity}',
                                style: const TextStyle(
                                    fontWeight: FontWeight.w900)),
                            subtitle: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(
                                  '${scan.scanType} | ${scan.binLocation} | ${scan.rawValue}',
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                if (detailLine.isNotEmpty) ...[
                                  const SizedBox(height: 2),
                                  Text(
                                    detailLine,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      color: detailColor,
                                      fontWeight: FontWeight.w800,
                                      fontSize: 12,
                                    ),
                                  ),
                                ],
                              ],
                            ),
                            trailing: Text(scan.status,
                                style: TextStyle(
                                    color: color, fontWeight: FontWeight.w900)),
                          );
                        },
                      ),
              ),
            ],
          ),
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
      padding: const EdgeInsets.fromLTRB(10, 10, 10, 8),
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
          const SizedBox(height: 3),
          Text('$userName ${role.isEmpty ? '' : '| $role'}',
              style: const TextStyle(
                  color: Colors.black54, fontWeight: FontWeight.w700)),
          const SizedBox(height: 6),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              StatusChip(
                  label: online ? 'Online' : 'Offline',
                  color: online ? Colors.green : Colors.red,
                  icon: online ? Icons.wifi : Icons.wifi_off),
              StatusChip(
                  label: serverConnected
                      ? 'Server connected'
                      : online
                          ? 'Server pending'
                          : 'Offline mode',
                  color: serverConnected
                      ? Colors.green
                      : online
                          ? Colors.orange
                          : Colors.red,
                  icon: serverConnected ? Icons.cloud_done : Icons.cloud_off),
              StatusChip(
                  label: 'Login verified',
                  color: userName.isEmpty ? Colors.red : Colors.green,
                  icon: Icons.verified_user),
              StatusChip(
                  label: pendingCount == 0
                      ? 'All synced'
                      : 'Pending $pendingCount',
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
  const _ManualEntryDialog({
    required this.scanType,
    required this.fallbackBin,
    required this.settings,
    required this.dealerCode,
  });

  final String scanType;
  final String fallbackBin;
  final SettingsStore settings;
  final String dealerCode;

  @override
  State<_ManualEntryDialog> createState() => _ManualEntryDialogState();
}

class _ManualEntryDialogState extends State<_ManualEntryDialog> {
  late final TextEditingController _partController;
  late final TextEditingController _qtyController;
  late final TextEditingController _binController;
  late final TextEditingController _localPartController;
  late final TextEditingController _localCategoryController;
  late final TextEditingController _localQtyController;
  late final TextEditingController _descriptionController;
  late final TextEditingController _mrpController;
  late final TextEditingController _dlcController;
  late final TextEditingController _remarksController;
  String _selectedDescription = '';
  String _error = '';
  bool _localPart = false;
  bool _savingLocalPart = false;

  @override
  void initState() {
    super.initState();
    _partController = TextEditingController();
    _qtyController = TextEditingController(text: '1');
    _binController = TextEditingController(text: _upper(widget.fallbackBin));
    _localPartController = TextEditingController();
    _localCategoryController = TextEditingController();
    _localQtyController = TextEditingController(text: '1.000');
    _descriptionController = TextEditingController();
    _mrpController = TextEditingController();
    _dlcController = TextEditingController();
    _remarksController = TextEditingController();
  }

  @override
  void dispose() {
    _partController.dispose();
    _qtyController.dispose();
    _binController.dispose();
    _localPartController.dispose();
    _localCategoryController.dispose();
    _localQtyController.dispose();
    _descriptionController.dispose();
    _mrpController.dispose();
    _dlcController.dispose();
    _remarksController.dispose();
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
    if (part.isEmpty || bin.isEmpty || qty <= 0) {
      setState(() => _error = 'Enter a part, bin and quantity greater than zero.');
      return;
    }
    Navigator.pop(
      context,
      _ScanDraft(
        rawValue:
            'MANUAL:$part:$bin:${DateTime.now().toUtc().toIso8601String()}',
        partNumber: part,
        quantity: qty,
        binLocation: bin,
        partDescription: _selectedDescription,
      ),
    );
  }

  Future<void> _saveLocalPart() async {
    final part = _upper(_localPartController.text);
    final quantity = _localQtyController.text.trim();
    final mrp = _mrpController.text.trim();
    final dlc = _dlcController.text.trim();
    final description = _descriptionController.text.trim();
    if (part.isEmpty || _upper(_binController.text).isEmpty || description.isEmpty ||
        (double.tryParse(quantity) ?? 0) <= 0 ||
        (double.tryParse(mrp) ?? -1) < 0 ||
        (double.tryParse(dlc) ?? -1) < 0) {
      setState(() => _error = 'Enter bin, part, description, positive quantity, MRP and DLC.');
      return;
    }
    setState(() {
      _error = '';
      _savingLocalPart = true;
    });
    try {
      await ApiClient(widget.settings).createLocalPart(
        dealerCode: widget.dealerCode,
        binLocation: _upper(_binController.text),
        partNumber: part,
        partDescription: description,
        quantity: quantity,
        mrp: mrp,
        dlc: dlc,
        category: _localCategoryController.text,
        remarks: _remarksController.text,
      );
      if (mounted) Navigator.pop(context, const _LocalPartSaved());
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Local Part could not be saved. Check the connection and try again.');
    } finally {
      if (mounted) setState(() => _savingLocalPart = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text('${widget.scanType} Manual Entry'),
      scrollable: true,
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SegmentedButton<bool>(
            segments: const [
              ButtonSegment(value: false, label: Text('Regular Part')),
              ButtonSegment(value: true, label: Text('Local Part')),
            ],
            selected: {_localPart},
            onSelectionChanged: (selection) => setState(() {
              _localPart = selection.first;
              _error = '';
            }),
          ),
          const SizedBox(height: 12),
          if (!_localPart) ...[
            SmartPartField(
              controller: _partController,
              scopeKey: widget.dealerCode,
              search: (query) => ApiClient(widget.settings).masterSearchParts(
                  query: query, dealerCode: widget.dealerCode, limit: 8),
              onSelected: (part) => setState(() {
                _selectedDescription = (part['partDescription'] ?? '').toString();
              }),
              onEdited: () => _selectedDescription = '',
            ),
            if (_selectedDescription.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: Text(_selectedDescription,
                    style: Theme.of(context).textTheme.bodySmall),
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
          ] else ...[
            TextField(
              controller: _binController,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'Bin Location *'),
              onChanged: (value) => _uppercase(_binController, value),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _localPartController,
              textCapitalization: TextCapitalization.characters,
              decoration: const InputDecoration(labelText: 'Part Number'),
              onChanged: (value) => _uppercase(_localPartController, value),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _descriptionController,
              decoration: const InputDecoration(labelText: 'Part Description'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _localQtyController,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(labelText: 'Quantity'),
            ),
            const SizedBox(height: 8),
            Row(children: [
              Expanded(child: TextField(
                controller: _mrpController,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'MRP'),
              )),
              const SizedBox(width: 10),
              Expanded(child: TextField(
                controller: _dlcController,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'DLC'),
              )),
            ]),
            const SizedBox(height: 8),
            TextField(
              controller: _localCategoryController,
              decoration: const InputDecoration(labelText: 'Category (optional)'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _remarksController,
              maxLines: 2,
              decoration: const InputDecoration(labelText: 'Remarks (optional)'),
            ),
          ],
          if (_error.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_error, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ),
        ],
      ),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel')),
        FilledButton(
          onPressed: _savingLocalPart ? null : (_localPart ? _saveLocalPart : _submit),
          child: Text(_savingLocalPart ? 'Saving…' : (_localPart ? 'Save Local Part' : 'Save')),
        ),
      ],
    );
  }
}

class _LocalPartSaved {
  const _LocalPartSaved();
}

class _ScanDraft {
  const _ScanDraft({
    required this.rawValue,
    required this.partNumber,
    required this.quantity,
    required this.binLocation,
    this.partDescription = '',
    this.barcodeFormat = 'UNKNOWN',
  });

  final String rawValue;
  final String partNumber;
  final int quantity;
  final String binLocation;
  final String partDescription;
  final String barcodeFormat;

  factory _ScanDraft.fromRaw(String raw,
      {String fallbackBin = '', String barcodeFormat = 'UNKNOWN'}) {
    // Transport camera input unchanged; business parsing runs in the common backend service.
    return _ScanDraft(
        rawValue: raw,
        partNumber: '',
        quantity: 1,
        binLocation: _upper(fallbackBin),
        barcodeFormat: barcodeFormat);
  }
}

String _upper(Object? value) =>
    value == null ? '' : value.toString().trim().toUpperCase();
