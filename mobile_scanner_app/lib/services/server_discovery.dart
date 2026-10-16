import 'dart:async';

import 'package:http/http.dart' as http;

import 'settings_store.dart';

class DiscoveredServer {
  const DiscoveredServer({required this.serverUrl, this.displayStatus = ''});
  final String serverUrl;
  final String displayStatus;
}

/// Checks the configured Railway endpoint without changing server identity.
class ServerDiscovery {
  Future<DiscoveredServer?> discoverAndSave(SettingsStore settings,
      {Duration timeout = const Duration(seconds: 4)}) async {
    final url = await settings.serverUrl;
    try {
      final response =
          await http.get(Uri.parse('$url/health')).timeout(timeout);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return DiscoveredServer(serverUrl: url, displayStatus: 'Server online');
      }
    } catch (_) {}
    return null;
  }
}
