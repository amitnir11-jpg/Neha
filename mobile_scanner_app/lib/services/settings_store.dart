import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

import '../models/session.dart';

class SettingsStore {
  static const localHostname = String.fromEnvironment(
    'DAKSH_LOCAL_HOSTNAME',
    defaultValue: 'daksh.local',
  );
  static const localServerPort = int.fromEnvironment(
    'DAKSH_LOCAL_PORT',
    defaultValue: 3300,
  );
  static const localServerUrl = 'http://$localHostname:$localServerPort';
  static const productionServerUrl = String.fromEnvironment(
    'DAKSH_CLOUD_URL',
    defaultValue: '',
  );
  static const _secure = FlutterSecureStorage();
  static const _tokenKey = 'daksh_token';
  static const _tokenClearedKey = 'daksh_token_cleared';
  static const _serverUrlKey = 'server_url';
  static const _serverIdKey = 'server_id';
  static const _serverHostnameKey = 'server_hostname';
  static const _pairingTokenKey = 'pairing_token';
  static const _pairingSessionKey = 'pairing_session';
  static const _deviceIdKey = 'device_id';
  static const _sessionKey = 'session';
  static const _dealerCodeKey = 'dealer_code';
  static const _dealerNameKey = 'dealer_name';

  Future<String> get token async {
    try {
      return await _secure.read(key: _tokenKey) ?? '';
    } catch (err) {
      // Decryption/read failure (e.g. BadPaddingException on Android) —
      // clear the stored token so app can continue and force login.
      try {
        await _secure.delete(key: _tokenKey);
        final prefs = await SharedPreferences.getInstance();
        await prefs.setBool(_tokenClearedKey, true);
      } catch (_) {}
      return '';
    }
  }

  Future<void> _deleteTokenAfterSecureStorageError() async {
    try {
      await _secure.delete(key: _tokenKey);
    } catch (_) {}
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(_tokenClearedKey, true);
    } catch (_) {}
  }

  /// Returns true if the token was cleared due to decryption failure and clears the flag.
  Future<bool> consumeTokenClearedFlag() async {
    final prefs = await SharedPreferences.getInstance();
    final v = prefs.getBool(_tokenClearedKey) ?? false;
    if (v) await prefs.remove(_tokenClearedKey);
    return v;
  }

  /// Clear all session-related data to force re-login without reinstall.
  Future<void> clearAllData() async {
    final prefs = await SharedPreferences.getInstance();
    try {
      await _secure.delete(key: _tokenKey);
    } catch (_) {}
    // remove known keys
    await prefs.remove(_sessionKey);
    await prefs.remove(_dealerCodeKey);
    await prefs.remove(_dealerNameKey);
  }

  Future<String> get serverUrl async {
    final prefs = await SharedPreferences.getInstance();
    final saved = normalizeServerUrl(prefs.getString(_serverUrlKey) ?? '');
    if (saved.isNotEmpty && !isPhoneLocalhostUrl(saved)) return saved;
    return localServerUrl;
  }

  Future<String> get savedServerUrl async {
    final prefs = await SharedPreferences.getInstance();
    final saved = normalizeServerUrl(prefs.getString(_serverUrlKey) ?? '');
    return saved.isNotEmpty && !isPhoneLocalhostUrl(saved) ? saved : '';
  }

  Future<String> get serverId async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_serverIdKey) ?? '';
  }

  Future<String> get serverHostname async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_serverHostnameKey) ?? '';
  }

  Future<String> get pairingToken async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_pairingTokenKey) ?? '';
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
    try {
      final data = jsonDecode(raw) as Map<String, dynamic>;
      return data.map((key, value) => MapEntry(key, value.toString()));
    } catch (_) {
      await prefs.remove(_sessionKey);
      return {};
    }
  }

  Future<void> saveServerUrl(String value) async {
    final prefs = await SharedPreferences.getInstance();
    final normalized = normalizeServerUrl(value);
    final url = normalized.isEmpty || isPhoneLocalhostUrl(normalized)
        ? localServerUrl
        : normalized;
    if (prefs.getString(_serverUrlKey) != url) {
      await prefs.remove(_serverIdKey);
      await prefs.remove(_serverHostnameKey);
      await prefs.remove(_pairingTokenKey);
      await prefs.remove(_pairingSessionKey);
    }
    await prefs.setString(_serverUrlKey, url);
  }

  Future<void> saveDiscoveredServer({
    required String url,
    String identity = '',
    String hostname = '',
  }) async {
    final prefs = await SharedPreferences.getInstance();
    await saveServerUrl(url);
    if (identity.trim().isNotEmpty) {
      await prefs.setString(_serverIdKey, identity.trim());
    }
    if (hostname.trim().isNotEmpty) {
      await prefs.setString(_serverHostnameKey, hostname.trim());
    }
  }

  Future<void> savePairingPayload(Map<String, dynamic> payload) async {
    final url = serverUrlFromPayload(payload);
    if (url.isEmpty) return;
    await saveDiscoveredServer(
      url: url,
      identity: (payload['serverId'] ?? '').toString(),
      hostname: (payload['hostname'] ?? '').toString(),
    );
    final prefs = await SharedPreferences.getInstance();
    final token = (payload['authToken'] ?? payload['pairingToken'] ?? '')
        .toString()
        .trim();
    final session = (payload['sessionId'] ?? '').toString().trim();
    if (token.isNotEmpty) await prefs.setString(_pairingTokenKey, token);
    if (session.isNotEmpty) await prefs.setString(_pairingSessionKey, session);
  }

  Future<void> saveSession(UserSession session) async {
    final prefs = await SharedPreferences.getInstance();
    try {
      await _secure.write(key: _tokenKey, value: session.token);
    } catch (_) {
      await _deleteTokenAfterSecureStorageError();
      await _secure.write(key: _tokenKey, value: session.token);
    }
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
    try {
      await _secure.delete(key: _tokenKey);
    } catch (_) {}
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
        return serverUrlFromPayload(Map<String, dynamic>.from(parsedJson));
      }
    } catch (_) {
      final match = RegExp(r'''https?://[^\s"'}]+''').firstMatch(url);
      if (match != null) url = match.group(0)!;
    }
    url = url.trim();
    if (!RegExp(r'^https?://', caseSensitive: false).hasMatch(url) &&
        url.contains('.')) {
      url = 'http://$url';
    }
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

  static String serverUrlFromPayload(Map<String, dynamic> payload) {
    String firstUrl(List<String> keys) {
      for (final key in keys) {
        final value = payload[key];
        if (value is! String ||
            !RegExp(r'^https?://', caseSensitive: false)
                .hasMatch(value.trim())) {
          continue;
        }
        final url = normalizeServerUrl(value);
        final uri = Uri.tryParse(url);
        if (uri != null && uri.host.isNotEmpty && !isPhoneLocalhostUrl(url)) {
          return url;
        }
      }
      return '';
    }

    final server = firstUrl([
      'serverUrl',
      'baseUrl',
      'apiUrl',
      'healthUrl',
      'connectUrl',
      'syncUrl',
    ]);
    // A cloud QR may also advertise the host's private address. Keep its public
    // URL; for a local QR, prefer the IP so Android need not resolve .local.
    if (server.isNotEmpty && !isLocalNetworkServerUrl(server)) return server;
    final lan = firstUrl(['lanUrl']);
    if (lan.isNotEmpty && isLocalNetworkServerUrl(lan)) return lan;
    return server.isNotEmpty ? server : firstUrl(['mdnsUrl']);
  }

  static bool isPhoneLocalhostUrl(String value) {
    final url = normalizeServerUrl(value);
    if (url.isEmpty) return false;
    final parsed = Uri.tryParse(url);
    final host = (parsed?.host ?? '').trim().toLowerCase();
    return host == 'localhost' ||
        host == '127.0.0.1' ||
        host == '::1' ||
        host == '0.0.0.0';
  }

  static bool isLocalNetworkServerUrl(String value) {
    final url = normalizeServerUrl(value);
    if (url.isEmpty) return false;
    final parsed = Uri.tryParse(url);
    final host = (parsed?.host ?? '').trim().toLowerCase();
    if (host.isEmpty) return false;
    if (host == localHostname.toLowerCase() || host.endsWith('.local')) {
      return true;
    }
    final parts = host.split('.');
    if (parts.length != 4) return false;
    final octets = parts.map(int.tryParse).toList();
    if (octets.any((part) => part == null || part < 0 || part > 255)) {
      return false;
    }
    final first = octets[0]!;
    final second = octets[1]!;
    return first == 10 ||
        (first == 172 && second >= 16 && second <= 31) ||
        (first == 192 && second == 168) ||
        (first == 169 && second == 254);
  }
}
