import 'dart:async';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:multicast_dns/multicast_dns.dart';

import 'settings_store.dart';

class DiscoveredServer {
  const DiscoveredServer({
    required this.serverUrl,
    this.displayStatus = '',
    this.serverId = '',
    this.hostname = '',
  });

  final String serverUrl;
  final String displayStatus;
  final String serverId;
  final String hostname;
}

/// Finds the configured cloud server or Daksh's local mDNS service.
class ServerDiscovery {
  Future<DiscoveredServer?> discoverAndSave(
    SettingsStore settings, {
    Duration timeout = const Duration(seconds: 4),
  }) async {
    final saved = await settings.savedServerUrl;
    final candidates = <String>{
      if (saved.isNotEmpty) saved,
      if (SettingsStore.productionServerUrl.isNotEmpty)
        SettingsStore.productionServerUrl,
    };

    for (final candidate in candidates) {
      final url = SettingsStore.normalizeServerUrl(candidate);
      if (url.isNotEmpty && await _isDakshServer(url, timeout)) {
        await settings.saveDiscoveredServer(url: url);
        return DiscoveredServer(
          serverUrl: url,
          displayStatus: 'Server online',
        );
      }
    }

    final local = await _discoverLocal(timeout);
    if (local == null) return null;
    await settings.saveDiscoveredServer(
      url: local.serverUrl,
      identity: local.serverId,
      hostname: local.hostname,
    );
    return local;
  }

  Future<DiscoveredServer?> _discoverLocal(Duration timeout) async {
    final client = MDnsClient();
    try {
      await client.start().timeout(timeout);
      try {
        final instance = await client
            .lookup<PtrResourceRecord>(
              ResourceRecordQuery.serverPointer('_daksh._tcp.local'),
            )
            .first
            .timeout(timeout);
        final service = await client
            .lookup<SrvResourceRecord>(
              ResourceRecordQuery.service(instance.domainName),
            )
            .first
            .timeout(timeout);
        final address = await client
            .lookup<IPAddressResourceRecord>(
              ResourceRecordQuery.addressIPv4(service.target),
            )
            .first
            .timeout(timeout);
        final url = 'http://${address.address.address}:${service.port}';
        if (await _isDakshServer(url, timeout)) {
          return DiscoveredServer(
            serverUrl: url,
            displayStatus: 'Daksh server discovered on WiFi',
            hostname: service.target,
          );
        }
      } catch (_) {}

      // Older local installs may advertise only the daksh.local A record.
      final addresses = await client
          .lookup<IPAddressResourceRecord>(
            ResourceRecordQuery.addressIPv4(SettingsStore.localHostname),
          )
          .first
          .timeout(timeout);
      final url =
          'http://${addresses.address.address}:${SettingsStore.localServerPort}';
      if (await _isDakshServer(url, timeout)) {
        return DiscoveredServer(
          serverUrl: url,
          displayStatus: 'Daksh server discovered on WiFi',
          hostname: SettingsStore.localHostname,
        );
      }
    } on TimeoutException {
      return null;
    } on SocketException {
      return null;
    } catch (_) {
      return null;
    } finally {
      try {
        client.stop();
      } catch (_) {}
    }
    return null;
  }

  Future<bool> _isDakshServer(String baseUrl, Duration timeout) async {
    try {
      final uri = Uri.parse('${baseUrl.replaceAll(RegExp(r'/+$'), '')}/health');
      final response = await http.get(uri).timeout(timeout);
      return response.statusCode >= 200 && response.statusCode < 300;
    } catch (_) {
      return false;
    }
  }
}
