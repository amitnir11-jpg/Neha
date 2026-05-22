import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/dealer.dart';
import '../models/scan_record.dart';
import '../models/session.dart';
import 'settings_store.dart';

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
  ApiClient(this.settings);

  final SettingsStore settings;

  Future<Map<String, dynamic>> _request(
    String path, {
    String method = 'GET',
    Map<String, dynamic>? body,
    bool auth = true,
  }) async {
    final savedBaseUrl =
        SettingsStore.normalizeServerUrl(await settings.serverUrl);
    final candidates = {
      if (savedBaseUrl.isNotEmpty) savedBaseUrl,
      SettingsStore.productionServerUrl,
    }.toList();
    ApiException? lastApiError;
    Object? lastError;

    for (final baseUrl in candidates) {
      try {
        final data = await _requestOnce(baseUrl, path,
            method: method, body: body, auth: auth);
        if (baseUrl != savedBaseUrl) await settings.saveServerUrl(baseUrl);
        return data;
      } on ApiException catch (error) {
        lastApiError = error;
        if (!error.retryable) rethrow;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastApiError != null) throw lastApiError;
    throw ApiException(lastError?.toString() ?? 'Server connection failed',
        retryable: true);
  }

  Future<Map<String, dynamic>> _requestOnce(
    String baseUrl,
    String path, {
    required String method,
    Map<String, dynamic>? body,
    required bool auth,
  }) async {
    final token = await settings.token;
    final uri = Uri.parse('$baseUrl$path');
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (auth && token.isNotEmpty) headers['Authorization'] = 'Bearer $token';
    final response = method == 'POST'
        ? await http
            .post(uri, headers: headers, body: jsonEncode(body ?? {}))
            .timeout(const Duration(seconds: 20))
        : await http
            .get(uri, headers: headers)
            .timeout(const Duration(seconds: 20));
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

  Future<Map<String, dynamic>> health() => _request('/api/health', auth: false);

  Future<Map<String, dynamic>> mobileStatus({String deviceId = ''}) async {
    final id = deviceId.isEmpty ? await settings.deviceId : deviceId;
    final query = id.isEmpty ? '' : '?deviceId=${Uri.encodeComponent(id)}';
    return _request('/api/mobile/status$query', auth: false);
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
        'appVersion': 'Daksh Mobile Scanner v1.0.1',
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

  Future<Map<String, dynamic>> config() => _request('/api/mobile/config');

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
        'appVersion': 'Daksh Mobile Scanner v1.0.1',
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
      body: {
        'deviceId': deviceId,
        'dealerCode': dealerCode,
        'appVersion': 'Daksh Mobile Scanner v1.0.1',
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
}
