import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

class MobileApiException implements Exception {
  const MobileApiException(this.message);

  final String message;

  @override
  String toString() => message;
}

class MobileApi {
  MobileApi({http.Client? client}) : _client = client ?? http.Client();

  static const int defaultPort = 3001;
  static const int discoveryPort = 3001;
  static const String _discoveryMessage = 'DAKSH_DISCOVER_V1';
  static const String compileTimeServerUrl = String.fromEnvironment(
    'DAKSH_SERVER_URL',
    defaultValue: '',
  );
  static const String _serverUrlKey = 'daksh_server_url';

  final http.Client _client;
  final _storage = const FlutterSecureStorage();
  String _serverUrl = '';

  String get cachedServerUrl => _serverUrl;

  static String normalizeServerUrl(String value) {
    var text = value.trim();
    if (text.isEmpty) return '';
    if (!RegExp(r'^https?://', caseSensitive: false).hasMatch(text)) {
      text = 'http://$text';
    }
    final uri = Uri.parse(text);
    if (uri.host.isEmpty) return '';
    final normalized = Uri(
      scheme: uri.scheme.isEmpty ? 'http' : uri.scheme,
      host: uri.host,
      port: uri.hasPort ? uri.port : defaultPort,
    );
    return normalized.toString().replaceFirst(RegExp(r'/$'), '');
  }

  Uri _uri(String serverUrl, String path, [Map<String, String>? query]) {
    final base = Uri.parse(serverUrl);
    return base.replace(path: path, queryParameters: query);
  }

  Future<String> currentServerUrl() async {
    if (_serverUrl.isNotEmpty) return _serverUrl;
    final stored = await _storage.read(key: _serverUrlKey);
    final saved = normalizeServerUrl(stored ?? '');
    if (saved.isNotEmpty) {
      _serverUrl = saved;
      return _serverUrl;
    }
    final fallback = normalizeServerUrl(compileTimeServerUrl);
    if (fallback.isNotEmpty) {
      _serverUrl = fallback;
      return _serverUrl;
    }
    return '';
  }

  Future<void> saveServerUrl(String value) async {
    final normalized = normalizeServerUrl(value);
    if (normalized.isEmpty) {
      throw const MobileApiException(
          'Wrong IP/port. Enter PC IP like 192.168.1.10:3001');
    }
    _serverUrl = normalized;
    await _storage.write(key: _serverUrlKey, value: normalized);
  }

  Future<String> lastServerUrl() => currentServerUrl();

  Future<Map<String, String>> _headers() async {
    final token = await _storage.read(key: 'jwt_token');
    return {
      'Content-Type': 'application/json',
      if (token != null && token.isNotEmpty) 'Authorization': 'Bearer $token',
    };
  }

  Future<Map<String, dynamic>> _userContext() async {
    final raw = await _storage.read(key: 'daksh_user');
    if (raw == null || raw.isEmpty) return {};
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map) return {};
      final user = Map<String, dynamic>.from(decoded);
      final username = (user['username'] ?? user['email'] ?? '').toString();
      final userId = (user['id'] ?? user['_id'] ?? username).toString();
      final userName = (user['name'] ?? username).toString();
      return {
        'userId': userId,
        'loginId': username,
        'username': username,
        'userName': userName,
        'staffName': userName,
        'role': (user['role'] ?? '').toString(),
      };
    } catch (_) {
      return {};
    }
  }

  Future<String> deviceId() async {
    final existing = await _storage.read(key: 'daksh_device_id');
    if (existing != null && existing.isNotEmpty) return existing;
    final id =
        'MOB-${DateTime.now().millisecondsSinceEpoch}-${Random().nextInt(999999).toString().padLeft(6, '0')}';
    await _storage.write(key: 'daksh_device_id', value: id);
    return id;
  }

  String _friendlyNetworkError(Object error, String serverUrl) {
    final text = error.toString();
    if (error is TimeoutException) {
      return 'Server not reachable. Check that PC and mobile are on the same WiFi and port 3001 is allowed.';
    }
    if (error is SocketException || text.contains('SocketException')) {
      return 'Server not reachable at $serverUrl. Wrong IP/port, firewall blocked, or PC server is offline.';
    }
    if (error is FormatException) {
      return 'Wrong IP/port. This address did not return Daksh server data.';
    }
    return text.replaceFirst('Exception: ', '');
  }

  Map<String, dynamic> _decodeResponse(http.Response response, String path) {
    final status = response.statusCode;
    if (status == 404) {
      final label = path.contains('/sync')
          ? 'Sync API not found'
          : path.contains('/mobile-login')
              ? 'Login API not found'
              : 'API not found';
      throw MobileApiException('$label. Check PC IP/port and backend route.');
    }
    Map<String, dynamic> data = {};
    if (response.body.trim().isNotEmpty) {
      final decoded = jsonDecode(response.body);
      if (decoded is Map) data = Map<String, dynamic>.from(decoded);
    }
    if (status >= 400) {
      if (path.contains('/sync') && data.isNotEmpty) {
        data['httpStatus'] = status;
        return data;
      }
      throw MobileApiException(
          data['message']?.toString() ?? 'Request failed ($status)');
    }
    return data;
  }

  Future<Map<String, dynamic>> _post(
      String path, Map<String, dynamic> body) async {
    final server = await ensureServerUrl();
    final headers = await _headers();
    try {
      final response = await _client
          .post(
            _uri(server, path),
            headers: headers,
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 8));
      return _decodeResponse(response, path);
    } catch (error) {
      if (error is MobileApiException) rethrow;
      throw MobileApiException(_friendlyNetworkError(error, server));
    }
  }

  Future<Map<String, dynamic>> _get(String path,
      [Map<String, String>? query]) async {
    final server = await ensureServerUrl();
    final headers = await _headers();
    try {
      final response = await _client
          .get(_uri(server, path, query), headers: headers)
          .timeout(const Duration(seconds: 8));
      return _decodeResponse(response, path);
    } catch (error) {
      if (error is MobileApiException) rethrow;
      throw MobileApiException(_friendlyNetworkError(error, server));
    }
  }

  bool _looksLikeDakshServer(Map<String, dynamic> data) {
    final app = (data['app'] ?? '').toString();
    final message = (data['message'] ?? data['name'] ?? '').toString();
    return app == 'daksh-inventory-v2' ||
        message.toLowerCase().contains('daksh') ||
        data['serverStatus'] == 'online';
  }

  Future<bool> _probeServer(String serverUrl) async {
    final normalized = normalizeServerUrl(serverUrl);
    if (normalized.isEmpty) return false;
    for (final path in const ['/api/discovery', '/api/health', '/api/ping']) {
      try {
        final response = await _client
            .get(_uri(normalized, path))
            .timeout(const Duration(milliseconds: 1500));
        if (response.statusCode < 200 || response.statusCode >= 300) continue;
        final decoded = jsonDecode(response.body);
        if (decoded is Map &&
            _looksLikeDakshServer(Map<String, dynamic>.from(decoded))) {
          return true;
        }
      } catch (_) {
        continue;
      }
    }
    return false;
  }

  List<String> _subnetCandidatesFromUrl(String value) {
    final normalized = normalizeServerUrl(value);
    if (normalized.isEmpty) return const [];
    final host = Uri.parse(normalized).host;
    final parts = host.split('.');
    if (parts.length != 4) return const [];
    final hostNumber = int.tryParse(parts[3]);
    if (hostNumber == null) return const [];

    final prefix = '${parts[0]}.${parts[1]}.${parts[2]}';
    final priorityHosts = <int>[
      hostNumber,
      hostNumber - 1,
      hostNumber + 1,
      1,
      254,
      2,
      10,
      20,
      28,
      29,
      50,
      100,
      101,
      200,
    ];
    final candidates = <String>[];
    void addHost(int host) {
      if (host < 1 || host > 254) return;
      candidates.add('http://$prefix.$host:$defaultPort');
    }

    for (final host in priorityHosts) {
      addHost(host);
    }
    for (var host = 2; host <= 254; host++) {
      addHost(host);
    }
    return candidates.toSet().toList();
  }

  Future<List<String>> _localSubnetCandidates() async {
    final candidates = <String>[];
    try {
      final interfaces = await NetworkInterface.list(
        type: InternetAddressType.IPv4,
        includeLoopback: false,
      );
      for (final iface in interfaces) {
        for (final address in iface.addresses) {
          final parts = address.address.split('.');
          if (parts.length != 4) continue;
          final prefix = '${parts[0]}.${parts[1]}.${parts[2]}';
          final self = int.tryParse(parts[3]);
          final priorityHosts = <int>[1, 254, 2, 10, 20, 50, 100, 101, 200];
          for (final host in priorityHosts) {
            if (host != self) {
              candidates.add('http://$prefix.$host:$defaultPort');
            }
          }
          for (var host = 2; host <= 254; host++) {
            if (host != self) {
              candidates.add('http://$prefix.$host:$defaultPort');
            }
          }
        }
      }
    } catch (_) {
      return candidates;
    }
    return candidates.toSet().toList();
  }

  Future<List<InternetAddress>> _broadcastTargets() async {
    final targets = <String>{'255.255.255.255'};
    try {
      final interfaces = await NetworkInterface.list(
        type: InternetAddressType.IPv4,
        includeLoopback: false,
      );
      for (final iface in interfaces) {
        for (final address in iface.addresses) {
          final parts = address.address.split('.');
          if (parts.length != 4) continue;
          targets.add('${parts[0]}.${parts[1]}.${parts[2]}.255');
        }
      }
    } catch (_) {
      return targets.map(InternetAddress.new).toList();
    }
    return targets.map(InternetAddress.new).toList();
  }

  Future<List<String>> _udpDiscoveryCandidates() async {
    RawDatagramSocket? socket;
    final candidates = <String>[];
    try {
      socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
      socket.broadcastEnabled = true;
      final payload = utf8.encode(_discoveryMessage);
      for (final target in await _broadcastTargets()) {
        socket.send(payload, target, discoveryPort);
      }

      final deadline = DateTime.now().add(const Duration(milliseconds: 1800));
      while (DateTime.now().isBefore(deadline)) {
        final remaining = deadline.difference(DateTime.now());
        try {
          await socket
              .where((event) => event == RawSocketEvent.read)
              .first
              .timeout(remaining);
        } on TimeoutException {
          break;
        }

        while (true) {
          final datagram = socket.receive();
          if (datagram == null) break;
          try {
            final decoded = jsonDecode(utf8.decode(datagram.data));
            if (decoded is! Map) continue;
            final data = Map<String, dynamic>.from(decoded);
            if (data['app'] != 'daksh-inventory-v2') continue;
            final serverUrl =
                normalizeServerUrl(data['serverUrl']?.toString() ?? '');
            if (serverUrl.isNotEmpty) candidates.add(serverUrl);
          } catch (_) {
            continue;
          }
        }
      }
    } catch (_) {
      return candidates.toSet().toList();
    } finally {
      socket?.close();
    }
    return candidates.toSet().toList();
  }

  Future<String> discoverServer({String manualInput = ''}) async {
    final manual = normalizeServerUrl(manualInput);
    if (manual.isNotEmpty) {
      if (await _probeServer(manual)) {
        await saveServerUrl(manual);
        return manual;
      }
      throw MobileApiException(
          'Wrong IP/port. Daksh server not reachable at $manual');
    }

    final saved = await currentServerUrl();
    final udpCandidates = await _udpDiscoveryCandidates();
    final candidates = <String>[
      ...udpCandidates,
      if (saved.isNotEmpty) saved,
      if (compileTimeServerUrl.trim().isNotEmpty) compileTimeServerUrl,
      ..._subnetCandidatesFromUrl(saved),
      ..._subnetCandidatesFromUrl(compileTimeServerUrl),
      ...await _localSubnetCandidates(),
    ].map(normalizeServerUrl).where((url) => url.isNotEmpty).toSet().toList();

    const batchSize = 32;
    for (var i = 0; i < candidates.length; i += batchSize) {
      final batch = candidates.skip(i).take(batchSize).toList();
      final results = await Future.wait(batch.map((url) async {
        return await _probeServer(url) ? url : '';
      }));
      final found =
          results.firstWhere((url) => url.isNotEmpty, orElse: () => '');
      if (found.isNotEmpty) {
        await saveServerUrl(found);
        return found;
      }
    }

    throw const MobileApiException(
      'Server not reachable. Start Daksh on PC, connect both devices to the same WiFi/hotspot, then enter PC IP:3001 manually.',
    );
  }

  Future<String> ensureServerUrl() async {
    final current = await currentServerUrl();
    if (current.isNotEmpty && await _probeServer(current)) return current;
    return discoverServer();
  }

  Future<Map<String, dynamic>> connect({int pendingCount = 0}) async {
    final server = await ensureServerUrl();
    final id = await deviceId();
    final userContext = await _userContext();
    return _post('/api/mobile/connect', {
      'deviceId': id,
      'deviceName': 'Daksh Mobile Scanner',
      'model': 'Android Phone',
      'appVersion': '1.0.1',
      'serverUrl': server,
      'pendingCount': pendingCount,
      'syncStatus': 'working',
      ...userContext,
    });
  }

  Future<Map<String, dynamic>> heartbeat({int pendingCount = 0}) async {
    final server = await ensureServerUrl();
    final id = await deviceId();
    final userContext = await _userContext();
    return _post('/api/mobile/heartbeat', {
      'deviceId': id,
      'deviceName': 'Daksh Mobile Scanner',
      'model': 'Android Phone',
      'appVersion': '1.0.1',
      'serverUrl': server,
      'pendingCount': pendingCount,
      'syncStatus': pendingCount > 0 ? 'pending' : 'synced',
      ...userContext,
    });
  }

  Future<Map<String, dynamic>> sync(List<Map<String, dynamic>> scans) async {
    final id = await deviceId();
    final userContext = await _userContext();
    return _post('/api/mobile/sync', {
      'deviceId': id,
      'deviceName': 'Daksh Mobile Scanner',
      ...userContext,
      'records': scans.map((scan) => {...userContext, ...scan}).toList(),
    });
  }

  Future<Map<String, dynamic>> validatePart({
    required String partNumber,
    String dealerCode = '',
  }) async {
    return _get('/api/mobile/validate-part', {
      'partNumber': partNumber,
      if (dealerCode.isNotEmpty) 'dealerCode': dealerCode,
    });
  }

  Future<Map<String, dynamic>> summary({String dealerCode = ''}) async {
    final id = await deviceId();
    return _get('/api/mobile/reports/summary', {
      if (dealerCode.isNotEmpty) 'dealerCode': dealerCode,
      'deviceId': id,
    });
  }

  Future<List<Map<String, dynamic>>> lastScans({
    String dealerCode = '',
    int limit = 10,
    bool currentDeviceOnly = true,
  }) async {
    final id = await deviceId();
    final data = await _get('/api/mobile/reports/last-scans', {
      if (dealerCode.isNotEmpty) 'dealerCode': dealerCode,
      if (currentDeviceOnly) 'deviceId': id,
      'limit': '$limit',
    });
    return List<Map<String, dynamic>>.from(data['records'] as List? ?? []);
  }

  Future<Map<String, dynamic>> report(String type,
      {String dealerCode = ''}) async {
    final id = await deviceId();
    return _get('/api/mobile/reports/$type', {
      if (dealerCode.isNotEmpty) 'dealerCode': dealerCode,
      'deviceId': id,
    });
  }

  Future<Map<String, dynamic>> verifyScan(String value,
      {String dealerCode = ''}) async {
    return _get('/api/mobile/reports/verify-scan', {
      'value': value,
      if (dealerCode.isNotEmpty) 'dealerCode': dealerCode,
    });
  }

  String exportUrl(String type, {String dealerCode = ''}) {
    final base = _serverUrl.isNotEmpty
        ? _serverUrl
        : normalizeServerUrl(compileTimeServerUrl);
    if (base.isEmpty) return '';
    return _uri(base, '/api/mobile/reports/export-excel', {
      'type': type,
      if (dealerCode.isNotEmpty) 'dealerCode': dealerCode,
    }).toString();
  }
}

final mobileApiProvider = Provider<MobileApi>((ref) => MobileApi());

class MobileConnectionState {
  const MobileConnectionState({
    this.connected = false,
    this.loading = false,
    this.message = 'Connecting...',
    this.serverUrl = '',
    this.dealerCode = '',
    this.dealerName = '',
    this.auditId = '',
    this.deviceId = '',
    this.lastSeen,
  });

  final bool connected;
  final bool loading;
  final String message;
  final String serverUrl;
  final String dealerCode;
  final String dealerName;
  final String auditId;
  final String deviceId;
  final DateTime? lastSeen;

  MobileConnectionState copyWith({
    bool? connected,
    bool? loading,
    String? message,
    String? serverUrl,
    String? dealerCode,
    String? dealerName,
    String? auditId,
    String? deviceId,
    DateTime? lastSeen,
  }) {
    return MobileConnectionState(
      connected: connected ?? this.connected,
      loading: loading ?? this.loading,
      message: message ?? this.message,
      serverUrl: serverUrl ?? this.serverUrl,
      dealerCode: dealerCode ?? this.dealerCode,
      dealerName: dealerName ?? this.dealerName,
      auditId: auditId ?? this.auditId,
      deviceId: deviceId ?? this.deviceId,
      lastSeen: lastSeen ?? this.lastSeen,
    );
  }
}

final mobileConnectionProvider =
    StateNotifierProvider<MobileConnectionNotifier, MobileConnectionState>(
        (ref) {
  final notifier = MobileConnectionNotifier(ref.read(mobileApiProvider));
  ref.onDispose(notifier.dispose);
  return notifier;
});

class MobileConnectionNotifier extends StateNotifier<MobileConnectionState> {
  MobileConnectionNotifier(this._api) : super(const MobileConnectionState()) {
    connect();
    _timer = Timer.periodic(const Duration(seconds: 15), (_) => heartbeat());
  }

  final MobileApi _api;
  Timer? _timer;

  String _messageFrom(Object error) {
    if (error is MobileApiException) return error.message;
    return error.toString().replaceFirst('Exception: ', '');
  }

  Future<void> connect({int pendingCount = 0}) async {
    state =
        state.copyWith(loading: true, message: 'Searching for PC server...');
    try {
      final data = await _api.connect(pendingCount: pendingCount);
      final device = data['device'] as Map<String, dynamic>? ?? {};
      final serverUrl = await _api.currentServerUrl();
      state = state.copyWith(
        connected: data['success'] == true,
        loading: false,
        message: data['message']?.toString() ?? 'Connected to PC',
        serverUrl: serverUrl,
        dealerCode: data['dealerCode']?.toString() ??
            device['dealerCode']?.toString() ??
            '',
        dealerName: data['dealerName']?.toString() ??
            device['dealerName']?.toString() ??
            '',
        auditId:
            data['auditId']?.toString() ?? device['auditId']?.toString() ?? '',
        deviceId: data['deviceId']?.toString() ??
            device['deviceId']?.toString() ??
            '',
        lastSeen: DateTime.now(),
      );
    } catch (error) {
      state = state.copyWith(
        connected: false,
        loading: false,
        message: _messageFrom(error),
        serverUrl: await _api.currentServerUrl(),
      );
    }
  }

  Future<void> connectToManualServer(String value,
      {int pendingCount = 0}) async {
    state = state.copyWith(loading: true, message: 'Checking PC IP/port...');
    try {
      await _api.discoverServer(manualInput: value);
      await connect(pendingCount: pendingCount);
    } catch (error) {
      state = state.copyWith(
        connected: false,
        loading: false,
        message: _messageFrom(error),
        serverUrl: MobileApi.normalizeServerUrl(value),
      );
    }
  }

  Future<void> heartbeat({int pendingCount = 0}) async {
    try {
      final data = await _api.heartbeat(pendingCount: pendingCount);
      final device = data['device'] as Map<String, dynamic>? ?? {};
      final serverUrl = await _api.currentServerUrl();
      state = state.copyWith(
        connected: data['success'] == true,
        loading: false,
        message: data['success'] == true
            ? 'Connected to PC'
            : (data['message']?.toString() ?? 'Offline'),
        serverUrl: serverUrl,
        dealerCode: device['dealerCode']?.toString() ?? state.dealerCode,
        dealerName: device['dealerName']?.toString() ?? state.dealerName,
        auditId: device['auditId']?.toString() ?? state.auditId,
        deviceId: device['deviceId']?.toString() ?? state.deviceId,
        lastSeen: DateTime.now(),
      );
    } catch (error) {
      state = state.copyWith(
        connected: false,
        loading: false,
        message: _messageFrom(error),
        serverUrl: await _api.currentServerUrl(),
      );
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
