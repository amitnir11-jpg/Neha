import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/dealer.dart';
import '../models/scan_record.dart';
import '../models/session.dart';
import 'settings_store.dart';

const mobileAppVersionName = 'Daksh Scan Lite v1.2.12';

class ApiException implements Exception {
  ApiException(this.message,
      {this.statusCode, this.data = const {}, this.retryable = false});
  final String message;
  final int? statusCode;
  final Map<String, dynamic> data;
  final bool retryable;

  @override
  String toString() => message;
}

class ApiClient {
  ApiClient(this.settings, {http.Client? client})
      : _client = client ?? _defaultClient;

  static final http.Client _defaultClient = http.Client();

  final SettingsStore settings;
  final http.Client _client;

  static List<String> candidateBaseUrls({
    required String savedBaseUrl,
    String localServerUrl = SettingsStore.localServerUrl,
    String productionServerUrl = SettingsStore.productionServerUrl,
  }) {
    final normalizedSaved = SettingsStore.normalizeServerUrl(savedBaseUrl);
    final candidates = <String>[];
    void addCandidate(String value) {
      final normalized = SettingsStore.normalizeServerUrl(value);
      if (normalized.isEmpty ||
          SettingsStore.isPhoneLocalhostUrl(normalized) ||
          candidates.contains(normalized)) {
        return;
      }
      candidates.add(normalized);
    }

    addCandidate(normalizedSaved);
    if (normalizedSaved.isEmpty) {
      addCandidate(localServerUrl);
      addCandidate(productionServerUrl);
    } else if (SettingsStore.isLocalNetworkServerUrl(normalizedSaved)) {
      addCandidate(localServerUrl);
    }
    return candidates;
  }

  Future<Map<String, dynamic>> _request(
    String path, {
    String method = 'GET',
    Map<String, dynamic>? body,
    bool auth = true,
    Duration timeout = const Duration(seconds: 8),
  }) async {
    final savedBaseUrl =
        SettingsStore.normalizeServerUrl(await settings.savedServerUrl);
    // Saved server identity -> daksh.local for LAN. Cloud is used only before a
    // server is saved, or when cloud is the saved server.
    final candidates = candidateBaseUrls(savedBaseUrl: savedBaseUrl);
    ApiException? lastApiError;
    Object? lastError;

    for (final baseUrl in candidates) {
      for (var attempt = 0; attempt < 2; attempt++) {
        try {
          final data = await _requestOnce(baseUrl, path,
              method: method, body: body, auth: auth, timeout: timeout);
          if (baseUrl != savedBaseUrl) await settings.saveServerUrl(baseUrl);
          return data;
        } on ApiException catch (error) {
          lastApiError = error;
          if (!error.retryable) rethrow;
          if (attempt == 1) break;
          await Future.delayed(Duration(milliseconds: 400 * (attempt + 1)));
        } catch (error) {
          lastError = error;
          if (attempt == 1) break;
          await Future.delayed(Duration(milliseconds: 400 * (attempt + 1)));
        }
      }
    }

    if (lastApiError != null) throw lastApiError;
    throw ApiException(_transportFailureMessage(candidates, lastError),
        retryable: true);
  }

  static String _transportFailureMessage(
      List<String> candidates, Object? error) {
    final target = candidates.isEmpty
        ? 'the configured Daksh server'
        : candidates.join(', ');
    final detail = error == null ? '' : ' Last error: ${error.toString()}';
    return 'Cannot reach Daksh server at $target. Make sure the Daksh PC app is running, the phone and PC are on the same WiFi/hotspot, and Windows Firewall allows port ${SettingsStore.localServerPort}.$detail';
  }

  Future<Map<String, dynamic>> _requestOnce(
    String baseUrl,
    String path, {
    required String method,
    Map<String, dynamic>? body,
    required bool auth,
    required Duration timeout,
  }) async {
    final uri = Uri.parse('$baseUrl$path');
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (auth) {
      final token = await settings.token;
      if (token.isNotEmpty) headers['Authorization'] = 'Bearer $token';
    }
    final response = await _send(uri,
        method: method, headers: headers, body: body, timeout: timeout);
    final text = response.body.trim();
    dynamic decoded;
    try {
      decoded = text.isEmpty ? <String, dynamic>{} : jsonDecode(text);
    } catch (_) {
      throw ApiException('Unexpected server response',
          statusCode: response.statusCode, retryable: true);
    }
    final data = decoded is Map<String, dynamic>
        ? decoded
        : <String, dynamic>{'data': decoded};
    if (response.statusCode < 200 ||
        response.statusCode >= 300 ||
        data['success'] == false) {
      final retryable = response.statusCode >= 500 ||
          response.statusCode == 404 ||
          response.statusCode == 0;
      throw ApiException((data['message'] ?? 'Request failed').toString(),
          statusCode: response.statusCode, data: data, retryable: retryable);
    }
    return data;
  }

  Future<http.Response> _send(
    Uri uri, {
    required String method,
    required Map<String, String> headers,
    Map<String, dynamic>? body,
    required Duration timeout,
  }) async {
    try {
      return await _sendWithClient(_client, uri,
              method: method, headers: headers, body: body)
          .timeout(timeout);
    } catch (error) {
      rethrow;
    }
  }

  Future<http.Response> _sendWithClient(
    http.Client client,
    Uri uri, {
    required String method,
    required Map<String, String> headers,
    Map<String, dynamic>? body,
  }) {
    if (method == 'POST') {
      return client.post(uri, headers: headers, body: jsonEncode(body ?? {}));
    }
    return client.get(uri, headers: headers);
  }

  Future<Map<String, dynamic>> health() => _request('/api/health', auth: false);

  Future<Map<String, dynamic>> mobileStatus({String deviceId = ''}) async {
    final id = deviceId.isEmpty ? await settings.deviceId : deviceId;
    final query = id.isEmpty ? '' : '?deviceId=${Uri.encodeComponent(id)}';
    return _request('/api/mobile/status$query', auth: false);
  }

  Future<Map<String, dynamic>> smartBinCheck({
    required String dealerCode,
    required String auditId,
    required String partNumber,
    required String binLocation,
    required String scanType,
    String partDescription = '',
    int qty = 1,
  }) {
    return _request(
      '/api/scans/smart-bin-check',
      method: 'POST',
      auth: false,
      body: {
        'dealerCode': dealerCode.trim().toUpperCase(),
        'auditId': auditId.trim(),
        'partNumber': partNumber.trim().toUpperCase(),
        'partDescription': partDescription.trim(),
        'binLocation': binLocation.trim().toUpperCase(),
        'scanType': scanType.trim().toUpperCase(),
        'qty': qty,
      },
    );
  }

  Future<List<Map<String, dynamic>>> masterSearchParts({
    required String query,
    required String dealerCode,
    int limit = 10,
  }) async {
    final q = query.trim().toUpperCase();
    if (q.length < 2) return [];
    final params = <String, String>{
      'q': q,
      'dealerCode': dealerCode.trim().toUpperCase(),
      'limit': limit.toString(),
    };
    final data = await _request(
      '/api/mobile/master-search?${Uri(queryParameters: params).query}',
    );
    final rows = (data['parts'] ?? data['suggestions'] ?? []) as List<dynamic>;
    return rows
        .whereType<Map>()
        .map((row) => row.map((key, value) => MapEntry(key.toString(), value)))
        .where((row) => (row['partNumber'] ?? row['partNo'] ?? '')
            .toString()
            .trim()
            .isNotEmpty)
        .toList();
  }

  Future<UserSession> login({
    required String username,
    required String password,
    required String pin,
    required String dealerCode,
    required String deviceId,
  }) async {
    final data = await _request(
      '/api/mobile/login',
      method: 'POST',
      auth: false,
      body: {
        'username': username,
        'password': password,
        'pin': pin,
        'dealerCode': dealerCode,
        'deviceId': deviceId,
        'appVersion': mobileAppVersionName,
      },
    );
    return UserSession.fromLogin(data);
  }

  Future<List<Dealer>> dealers() async {
    final data = await _request('/api/mobile/dealers');
    final rows = (data['dealers'] ?? data['data'] ?? []) as List<dynamic>;
    return rows
        .map((row) => Dealer.fromJson(Map<String, dynamic>.from(row)))
        .where((dealer) => dealer.code.isNotEmpty)
        .toList();
  }

  Future<Map<String, dynamic>> config({String dealerCode = ''}) async {
    final code = dealerCode.trim().toUpperCase();
    final query =
        code.isEmpty ? '' : '?dealerCode=${Uri.encodeComponent(code)}';
    return _request('/api/mobile/config$query', auth: false);
  }

  Future<Map<String, dynamic>> registerDevice({
    required String deviceId,
    required String dealerCode,
    required String pendingCount,
    required String failedCount,
  }) async {
    final session = await settings.session;
    final serverUrl = await settings.serverUrl;
    return _request(
      '/api/mobile/device-register',
      method: 'POST',
      body: {
        'deviceId': deviceId,
        'deviceName': 'Daksh Android Scanner',
        'model': 'Android',
        'appVersion': mobileAppVersionName,
        'dealerCode': dealerCode,
        'pendingCount': pendingCount,
        'failedCount': failedCount,
        'serverUrl': serverUrl,
        ...session,
      },
    );
  }

  Future<Map<String, dynamic>> syncBulk(List<ScanRecord> scans) async {
    final session = await settings.session;
    final deviceId = await settings.deviceId;
    final dealerCode = await settings.dealerCode;
    final serverUrl = await settings.serverUrl;
    return _request(
      '/api/mobile/sync-bulk',
      method: 'POST',
      timeout: const Duration(seconds: 30),
      body: {
        'deviceId': deviceId,
        'dealerCode': dealerCode,
        'appVersion': mobileAppVersionName,
        'serverUrl': serverUrl,
        ...session,
        'scans': scans.map((scan) => scan.toApiPayload()).toList(),
      },
    );
  }

  Future<Map<String, dynamic>> syncStatus(String deviceId) {
    return _request(
        '/api/mobile/sync-status?deviceId=${Uri.encodeComponent(deviceId)}');
  }

  Future<Map<String, dynamic>> verifyScan(String value,
      {String dealerCode = ''}) {
    final query = <String, String>{'value': value};
    if (dealerCode.isNotEmpty) query['dealerCode'] = dealerCode;
    return _request(
        '/api/mobile/reports/verify-scan?${Uri(queryParameters: query).query}');
  }

  Future<List<ScanRecord>> recentScans(
      {int limit = 10, String dealerCode = ''}) async {
    final effectiveDealerCode =
        dealerCode.isNotEmpty ? dealerCode : await settings.dealerCode;
    final query = <String, String>{'limit': limit.toString()};
    if (effectiveDealerCode.isNotEmpty) {
      query['dealerCode'] = effectiveDealerCode;
    }
    final data = await _request(
        '/api/mobile/reports/last-scans?${Uri(queryParameters: query).query}');
    final rows = (data['records'] ?? data['rows'] ?? data['data'] ?? [])
        as List<dynamic>;
    return rows
        .whereType<Map>()
        .map((row) => ScanRecord.fromServerMap(Map<String, dynamic>.from(row)))
        .toList();
  }
}
