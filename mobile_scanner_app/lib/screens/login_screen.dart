import 'package:flutter/material.dart';

import '../models/dealer.dart';
import '../services/api_client.dart';
import '../services/settings_store.dart';
import 'server_qr_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.onLoggedIn});

  final VoidCallback onLoggedIn;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _settings = SettingsStore();
  final _serverController = TextEditingController();
  final _userController = TextEditingController();
  final _passwordController = TextEditingController();
  final _pinController = TextEditingController();
  final _dealerController = TextEditingController();
  bool _busy = false;
  String _message = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    _serverController.text = await _settings.serverUrl;
    _dealerController.text = await _settings.dealerCode;
    if (mounted) setState(() {});
    await _testServer(silent: true);
  }

  @override
  void dispose() {
    _serverController.dispose();
    _userController.dispose();
    _passwordController.dispose();
    _pinController.dispose();
    _dealerController.dispose();
    super.dispose();
  }

  Future<void> _scanServerQr() async {
    final url = await Navigator.of(context).push<String>(
        MaterialPageRoute(builder: (_) => const ServerQrScreen()));
    if (url == null || url.isEmpty) return;
    _serverController.text = url;
    await _settings.saveServerUrl(url);
    setState(() => _message = 'Server URL loaded from QR');
  }

  Future<void> _testServer({bool silent = false}) async {
    if (!silent) {
      setState(() {
        _busy = true;
        _message = '';
      });
    }
    try {
      await _settings.saveServerUrl(_serverController.text);
      final data = await ApiClient(_settings).health();
      if (!silent && mounted) {
        setState(() => _message =
            'Server connected: ${data['db'] ?? data['mongoStatus'] ?? 'OK'}');
      }
    } catch (error) {
      if (!silent && mounted) setState(() => _message = error.toString());
    } finally {
      if (!silent && mounted) setState(() => _busy = false);
    }
  }

  Future<void> _login() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _busy = true;
      _message = '';
    });
    try {
      await _settings.saveServerUrl(_serverController.text);
      final deviceId = await _settings.deviceId;
      final session = await ApiClient(_settings).login(
        username: _userController.text.trim(),
        password: _passwordController.text,
        pin: _pinController.text,
        dealerCode: _dealerController.text.trim().toUpperCase(),
        deviceId: deviceId,
      );
      await _settings.saveSession(session);
      await ApiClient(_settings).registerDevice(
        deviceId: deviceId,
        dealerCode: session.dealerCode,
        pendingCount: '0',
        failedCount: '0',
      );
      widget.onLoggedIn();
    } catch (error) {
      setState(() => _message = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _showDealerHint() async {
    setState(() => _busy = true);
    try {
      await _settings.saveServerUrl(_serverController.text);
      final dealers = await ApiClient(_settings).dealers();
      if (!mounted) return;
      await showModalBottomSheet(
        context: context,
        showDragHandle: true,
        builder: (_) => _DealerSheet(
          dealers: dealers,
          onPick: (dealer) {
            _dealerController.text = dealer.code;
            Navigator.pop(context);
          },
        ),
      );
    } catch (error) {
      setState(
          () => _message = 'Login first or enter dealer code manually: $error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Daksh Scanner v1.0.5')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(18),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text('Secure login',
                    style:
                        TextStyle(fontSize: 26, fontWeight: FontWeight.w900)),
                const SizedBox(height: 6),
                const Text(
                    'Connect to the Daksh Railway/web portal API. Scanning is locked until login and dealer code are verified.'),
                const SizedBox(height: 18),
                TextFormField(
                  controller: _serverController,
                  keyboardType: TextInputType.url,
                  decoration: const InputDecoration(
                      labelText: 'Cloud Server',
                      prefixIcon: Icon(Icons.cloud),
                      helperText: 'Auto configured'),
                  validator: (_) => null,
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                        child: OutlinedButton.icon(
                            onPressed: _busy ? null : _scanServerQr,
                            icon: const Icon(Icons.qr_code_scanner),
                            label: const Text('Scan Server QR'))),
                    const SizedBox(width: 10),
                    Expanded(
                        child: OutlinedButton.icon(
                            onPressed: _busy ? null : _testServer,
                            icon: const Icon(Icons.wifi_tethering),
                            label: const Text('Test'))),
                  ],
                ),
                const SizedBox(height: 14),
                TextFormField(
                  controller: _dealerController,
                  textCapitalization: TextCapitalization.characters,
                  decoration: InputDecoration(
                    labelText: 'Dealer Code',
                    prefixIcon: const Icon(Icons.store),
                    suffixIcon: IconButton(
                        onPressed: _busy ? null : _showDealerHint,
                        icon: const Icon(Icons.list_alt)),
                  ),
                  validator: (value) => (value ?? '').trim().isEmpty
                      ? 'Dealer code is mandatory'
                      : null,
                  onChanged: (value) => _dealerController.value =
                      _dealerController.value.copyWith(
                          text: value.toUpperCase(),
                          selection:
                              TextSelection.collapsed(offset: value.length)),
                ),
                const SizedBox(height: 14),
                TextFormField(
                  controller: _userController,
                  decoration: const InputDecoration(
                      labelText: 'User ID', prefixIcon: Icon(Icons.person)),
                  validator: (value) => (value ?? '').trim().isEmpty
                      ? 'User ID is required'
                      : null,
                ),
                const SizedBox(height: 14),
                TextFormField(
                  controller: _passwordController,
                  obscureText: true,
                  decoration: const InputDecoration(
                      labelText: 'Password', prefixIcon: Icon(Icons.lock)),
                ),
                const SizedBox(height: 14),
                TextFormField(
                  controller: _pinController,
                  obscureText: true,
                  keyboardType: TextInputType.number,
                  maxLength: 4,
                  decoration: const InputDecoration(
                      labelText: '4-digit PIN', prefixIcon: Icon(Icons.pin)),
                ),
                const SizedBox(height: 18),
                FilledButton.icon(
                  onPressed: _busy ? null : _login,
                  icon: _busy
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.login),
                  label: const Text('Login and Start Scanning'),
                ),
                if (_message.isNotEmpty) ...[
                  const SizedBox(height: 14),
                  Text(_message,
                      style: TextStyle(
                          color: _message.toLowerCase().contains('connected')
                              ? Colors.green
                              : Colors.red,
                          fontWeight: FontWeight.w800)),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _DealerSheet extends StatelessWidget {
  const _DealerSheet({required this.dealers, required this.onPick});

  final List<Dealer> dealers;
  final ValueChanged<Dealer> onPick;

  @override
  Widget build(BuildContext context) {
    return ListView.separated(
      itemCount: dealers.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (_, index) {
        final dealer = dealers[index];
        return ListTile(
            title: Text(dealer.displayName), onTap: () => onPick(dealer));
      },
    );
  }
}
