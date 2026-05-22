import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/dealer.dart';
import '../models/scan_record.dart';
import '../models/session.dart';
import 'settings_store.dart';

class ApiException implements Exception {
  ApiException(this.message, {this.statusCode, this.data = const {}});
  final String message;
  final int? statusCode;
  final Map<String, dynamic> data;

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
    final baseUrl = await settings.serverUrl;
    if (baseUrl.isEmpty) throw ApiException('Set server URL first');
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
    final decoded = text.isEmpty ? <String, dynamic>{} : jsonDecode(text);
    final data = decoded is Map<String, dynamic>
        ? decoded
        : <String, dynamic>{'data': decoded};
    if (response.statusCode < 200 ||
        response.statusCode >= 300 ||
        data['success'] == false) {
      throw ApiException((data['message'] ?? 'Request failed').toString(),
          statusCode: response.statusCode, data: data);
    }
    return data;
  }

  Future<Map<String, dynamic>> health() => _request('/api/health', auth: false);

  Future<Map<String, dynamic>> mobileStatus() => _request('/api/mobile/status');

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
        'appVersion': 'Daksh Mobile Scanner v1.0 Fresh Build',
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
    return _request(
      '/api/mobile/device-register',
      method: 'POST',
      body: {
        'deviceId': deviceId,
        'deviceName': 'Daksh Android Scanner',
        'model': 'Android',
        'appVersion': 'Daksh Mobile Scanner v1.0 Fresh Build',
        'dealerCode': dealerCode,
        'pendingCount': pendingCount,
        'failedCount': failedCount,
        ...session,
      },
    );
  }

  Future<Map<String, dynamic>> syncBulk(List<ScanRecord> scans) async {
    final session = await settings.session;
    final deviceId = await settings.deviceId;
    final dealerCode = await settings.dealerCode;
    return _request(
      '/api/mobile/sync-bulk',
      method: 'POST',
      body: {
        'deviceId': deviceId,
        'dealerCode': dealerCode,
        'appVersion': 'Daksh Mobile Scanner v1.0 Fresh Build',
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
