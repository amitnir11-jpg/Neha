import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'mobile_api.dart';

class AuthService {
  AuthService({MobileApi? api, http.Client? client})
      : _api = api ?? MobileApi(),
        _client = client ?? http.Client();

  final MobileApi _api;
  final http.Client _client;

  String _friendlyNetworkError(Object error, String serverUrl) {
    final text = error.toString();
    if (error is TimeoutException) {
      return 'Server not reachable. Check that PC and mobile are on the same WiFi and port 3001 is allowed.';
    }
    if (error is SocketException || text.contains('SocketException')) {
      return 'Server not reachable at $serverUrl. Wrong IP/port, firewall blocked, or PC server is offline.';
    }
    if (error is FormatException) {
      return 'Wrong IP/port. This address did not return Daksh login data.';
    }
    return text.replaceFirst('Exception: ', '');
  }

  Future<Map<String, dynamic>> _mobileLogin(Map<String, dynamic> body) async {
    final serverUrl = await _api.ensureServerUrl();
    try {
      final response = await _client
          .post(
            Uri.parse('$serverUrl/api/auth/mobile-login'),
            headers: {'Content-Type': 'application/json'},
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 8));
      final decoded = response.body.trim().isEmpty
          ? <String, dynamic>{}
          : Map<String, dynamic>.from(jsonDecode(response.body) as Map);
      if (response.statusCode == 404) {
        return {
          'success': false,
          'message': 'Login API not found. Check PC IP/port and backend route.'
        };
      }
      if (response.statusCode >= 400 && decoded['success'] != false) {
        return {
          'success': false,
          'message': decoded['message'] ?? 'Login failed (${response.statusCode})'
        };
      }
      return decoded;
    } catch (error) {
      return {'success': false, 'message': _friendlyNetworkError(error, serverUrl)};
    }
  }

  Future<Map<String, dynamic>> login(String dealerCode, String username, String password) {
    return _mobileLogin({
      'dealerCode': dealerCode,
      'username': username,
      'password': password,
    });
  }

  Future<Map<String, dynamic>> pinLogin(String dealerCode, String username, String pin) {
    return _mobileLogin({
      'dealerCode': dealerCode,
      'username': username,
      'pin': pin,
    });
  }
}
