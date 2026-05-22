import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

import '../models/session.dart';

class SettingsStore {
  static const _secure = FlutterSecureStorage();
  static const _tokenKey = 'daksh_token';
  static const _serverUrlKey = 'server_url';
  static const _deviceIdKey = 'device_id';
  static const _sessionKey = 'session';
  static const _dealerCodeKey = 'dealer_code';
  static const _dealerNameKey = 'dealer_name';

  Future<String> get token async => await _secure.read(key: _tokenKey) ?? '';

  Future<String> get serverUrl async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_serverUrlKey) ?? '';
  }

  Future<String> get deviceId async {
    final prefs = await SharedPreferences.getInstance();
    var value = prefs.getString(_deviceIdKey) ?? '';
    if (value.isEmpty) {
      value = 'ANDROID-${const Uuid().v4()}';
      await prefs.setString(_deviceIdKey, value);
    }
    return value;
  }

  Future<String> get dealerCode async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_dealerCodeKey) ?? '';
  }

  Future<String> get dealerName async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_dealerNameKey) ?? '';
  }

  Future<Map<String, String>> get session async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_sessionKey);
    if (raw == null || raw.isEmpty) return {};
    final data = jsonDecode(raw) as Map<String, dynamic>;
    return data.map((key, value) => MapEntry(key, value.toString()));
  }

  Future<void> saveServerUrl(String value) async {
    final prefs = await SharedPreferences.getInstance();
    final url = normalizeServerUrl(value);
    await prefs.setString(_serverUrlKey, url);
  }

  Future<void> saveSession(UserSession session) async {
    final prefs = await SharedPreferences.getInstance();
    await _secure.write(key: _tokenKey, value: session.token);
    await prefs.setString(_sessionKey, jsonEncode(session.toPrefs()));
    await prefs.setString(_dealerCodeKey, session.dealerCode);
    await prefs.setString(_dealerNameKey, session.dealerName);
  }

  Future<void> saveDealer(String code, String name) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_dealerCodeKey, code.trim().toUpperCase());
    await prefs.setString(_dealerNameKey, name.trim());
  }

  Future<void> clearSession() async {
    final prefs = await SharedPreferences.getInstance();
    await _secure.delete(key: _tokenKey);
    await prefs.remove(_sessionKey);
    await prefs.remove(_dealerCodeKey);
    await prefs.remove(_dealerNameKey);
  }

  static String normalizeServerUrl(String value) {
    var url = value.trim();
    if (url.isEmpty) return '';
    try {
      final parsedJson = jsonDecode(url);
      if (parsedJson is Map) {
        final parsedUrl = parsedJson['serverUrl'] ??
            parsedJson['baseUrl'] ??
            parsedJson['apiUrl'] ??
            parsedJson['healthUrl'] ??
            parsedJson['connectUrl'] ??
            parsedJson['syncUrl'];
        if (parsedUrl != null) url = parsedUrl.toString();
      }
    } catch (_) {
      final match = RegExp(r'''https?://[^\s"'}]+''').firstMatch(url);
      if (match != null) url = match.group(0)!;
    }
    url = url.trim();
    final parsed = Uri.tryParse(url);
    if (parsed != null && parsed.hasScheme && parsed.host.isNotEmpty) {
      final path = parsed.path.toLowerCase();
      if (path == '/api' || path.startsWith('/api/')) {
        url = parsed.hasPort
            ? '${parsed.scheme}://${parsed.host}:${parsed.port}'
            : '${parsed.scheme}://${parsed.host}';
      }
    }
    if (url.endsWith('/')) url = url.substring(0, url.length - 1);
    return url;
  }
}
