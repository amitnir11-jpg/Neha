import 'package:flutter/material.dart';

import '../models/dealer.dart';
import '../services/api_client.dart';
import '../services/server_discovery.dart';
import '../services/settings_store.dart';
import '../widgets/status_chip.dart';
import 'server_qr_screen.dart';
import 'login_screen.dart';
import 'scanner_home_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _settings = SettingsStore();
  final _serverController = TextEditingController();
  String _dealerCode = '';
  String _dealerName = '';
  String _deviceId = '';
  String _message = '';
  bool _busy = false;
  List<Dealer> _dealers = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    _serverController.text = await _settings.serverUrl;
    _dealerCode = await _settings.dealerCode;
    _dealerName = await _settings.dealerName;
    _deviceId = await _settings.deviceId;
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _serverController.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    await _settings.saveServerUrl(_serverController.text);
    final dealer =
        _dealers.where((item) => item.code == _dealerCode).firstOrNull;
    await _settings.saveDealer(_dealerCode, dealer?.name ?? _dealerName);
    if (!mounted) return;
    setState(() => _message = 'Settings saved');
  }

  Future<void> _scanServerQr() async {
    final url = await Navigator.of(context).push<String>(
        MaterialPageRoute(builder: (_) => const ServerQrScreen()));
    if (url == null || url.isEmpty) return;
    _serverController.text = url;
    await _settings.saveServerUrl(url);
    setState(() => _message = 'Server URL loaded from QR');
  }

  Future<void> _autoDetectServer() async {
    setState(() {
      _busy = true;
      _message = 'Searching for Daksh PC server on this WiFi...';
    });
    try {
      final server = await ServerDiscovery().discoverAndSave(_settings);
      if (!mounted) return;
      if (server == null) {
        setState(() => _message = 'Daksh PC server not found on this network.');
        return;
      }
      _serverController.text = server.serverUrl;
      setState(() => _message =
          'Connected to ${server.serverUrl}${server.displayStatus.isNotEmpty ? ' - ${server.displayStatus}' : ''}');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _loadDealers() async {
    setState(() {
      _busy = true;
      _message = '';
    });
    try {
      await _settings.saveServerUrl(_serverController.text);
      final dealers = await ApiClient(_settings).dealers();
      setState(() {
        _dealers = dealers;
        _message = '${dealers.length} dealers loaded';
      });
    } catch (error) {
      setState(() => _message = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _test() async {
    setState(() {
      _busy = true;
      _message = '';
    });
    try {
      await _settings.saveServerUrl(_serverController.text);
      final data = await ApiClient(_settings).health();
      setState(() => _message =
          'Server connected: ${data['db'] ?? data['postgresStatus'] ?? 'OK'}');
    } catch (error) {
      setState(() => _message = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          StatusChip(
              label: 'Device $_deviceId',
              color: Colors.blue,
              icon: Icons.phone_android),
          const SizedBox(height: 16),
          TextField(
            controller: _serverController,
            enabled: !_busy,
            decoration: const InputDecoration(
                labelText: 'Daksh Server URL (automatic discovery)',
                prefixIcon: Icon(Icons.cloud)),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                  child: OutlinedButton.icon(
                      onPressed: _busy ? null : _scanServerQr,
                      icon: const Icon(Icons.qr_code_scanner),
                      label: const Text('Scan QR'))),
              const SizedBox(width: 10),
              Expanded(
                  child: OutlinedButton.icon(
                      onPressed: _busy ? null : _autoDetectServer,
                      icon: const Icon(Icons.wifi_tethering),
                      label: const Text('Auto Detect'))),
            ],
          ),
          const SizedBox(height: 10),
          OutlinedButton.icon(
              onPressed: _busy ? null : _test,
              icon: const Icon(Icons.network_check),
              label: const Text('Test Server')),
          const SizedBox(height: 16),
          OutlinedButton.icon(
              onPressed: _busy ? null : _loadDealers,
              icon: const Icon(Icons.store),
              label: const Text('Load Dealer List')),
          const SizedBox(height: 10),
          DropdownButtonFormField<String>(
            value: _dealers.any((dealer) => dealer.code == _dealerCode)
                ? _dealerCode
                : null,
            decoration: const InputDecoration(labelText: 'Dealer Assignment'),
            items: _dealers
                .map((dealer) => DropdownMenuItem(
                    value: dealer.code, child: Text(dealer.displayName)))
                .toList(),
            onChanged: (value) => setState(() => _dealerCode = value ?? ''),
          ),
          const SizedBox(height: 10),
          TextFormField(
            initialValue: _dealerCode,
            textCapitalization: TextCapitalization.characters,
            decoration:
                const InputDecoration(labelText: 'Dealer Code Manual Override'),
            onChanged: (value) => _dealerCode = value.toUpperCase(),
          ),
          const SizedBox(height: 18),
          FilledButton.icon(
              onPressed: _save,
              icon: const Icon(Icons.save),
              label: const Text('Save Settings')),
          const SizedBox(height: 12),
          FilledButton.icon(
              onPressed: () async {
                final ok = await showDialog<bool>(
                    context: context,
                    builder: (_) => AlertDialog(
                          title: const Text('Clear storage?'),
                          content: const Text(
                              'This will clear local session and require re-login. Continue?'),
                          actions: [
                            TextButton(
                                onPressed: () =>
                                    Navigator.of(context).pop(false),
                                child: const Text('Cancel')),
                            TextButton(
                                onPressed: () =>
                                    Navigator.of(context).pop(true),
                                child: const Text('Clear'))
                          ],
                        ));
                if (ok != true) return;
                await _settings.clearAllData();
                // Navigate to fresh login screen
                if (!context.mounted) return;
                Navigator.of(context).pushAndRemoveUntil(
                    MaterialPageRoute(
                        builder: (loginContext) => LoginScreen(onLoggedIn: () {
                              Navigator.of(loginContext).pushReplacement(
                                  MaterialPageRoute(
                                      builder: (_) =>
                                          ScannerHomeScreen(onLogout: () {})));
                            })),
                    (route) => false);
              },
              icon: const Icon(Icons.exit_to_app),
              label: const Text('Clear Storage / Re-login')),
          if (_message.isNotEmpty)
            Padding(
                padding: const EdgeInsets.only(top: 14),
                child: Text(_message,
                    style: const TextStyle(fontWeight: FontWeight.w800))),
        ],
      ),
    );
  }
}

extension _FirstOrNull<T> on Iterable<T> {
  T? get firstOrNull => isEmpty ? null : first;
}
