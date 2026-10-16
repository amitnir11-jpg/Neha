import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../services/settings_store.dart';
import 'login_screen.dart';
import 'scanner_home_screen.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _settings = SettingsStore();
  String _deviceId = '';
  String _dealerCode = '';
  String _dealerName = '';
  String _message = '';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final deviceId = await _settings.deviceId;
    final dealerCode = await _settings.dealerCode;
    final dealerName = await _settings.dealerName;
    if (!mounted) return;
    setState(() {
      _deviceId = deviceId;
      _dealerCode = dealerCode;
      _dealerName = dealerName;
    });
  }

  Future<void> _checkConnection() async {
    setState(() {
      _busy = true;
      _message = 'Checking Railway...';
    });
    try {
      await ApiClient(_settings).health();
      await ApiClient(_settings).syncStatus(_deviceId);
      if (mounted) {
        setState(() =>
            _message = 'Railway and authenticated connection are online.');
      }
    } catch (error) {
      if (mounted) setState(() => _message = 'Connection unavailable: $error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _clearSession() async {
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (_) => AlertDialog(
              title: const Text('Sign out?'),
              content: const Text(
                  'Pending scans stay on this phone and remain tied to their original user, dealer and audit.'),
              actions: [
                TextButton(
                    onPressed: () => Navigator.pop(context, false),
                    child: const Text('Cancel')),
                TextButton(
                    onPressed: () => Navigator.pop(context, true),
                    child: const Text('Sign out')),
              ],
            ));
    if (confirmed != true) return;
    await _settings.clearSession();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(
          builder: (loginContext) => LoginScreen(onLoggedIn: () {
                Navigator.of(loginContext).pushReplacement(MaterialPageRoute(
                    builder: (_) => ScannerHomeScreen(onLogout: () {})));
              })),
      (route) => false,
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Connection Diagnostics')),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          const ListTile(
              title: Text('Server'),
              subtitle: Text(SettingsStore.productionServerUrl)),
          ListTile(
              title: const Text('Dealer'),
              subtitle: Text('$_dealerCode · $_dealerName')),
          ListTile(title: const Text('Device ID'), subtitle: Text(_deviceId)),
          const SizedBox(height: 12),
          FilledButton.icon(
              onPressed: _busy ? null : _checkConnection,
              icon: const Icon(Icons.network_check),
              label: const Text('Check Connection')),
          if (_message.isNotEmpty)
            Padding(
                padding: const EdgeInsets.only(top: 16), child: Text(_message)),
          const SizedBox(height: 24),
          OutlinedButton.icon(
              onPressed: _clearSession,
              icon: const Icon(Icons.logout),
              label: const Text('Sign out')),
        ]),
      );
}
