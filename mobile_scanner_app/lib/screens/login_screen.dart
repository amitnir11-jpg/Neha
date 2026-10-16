import 'package:flutter/material.dart';

import '../models/dealer.dart';
import '../models/session.dart';
import '../services/api_client.dart';
import '../services/settings_store.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.onLoggedIn});

  final VoidCallback onLoggedIn;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _settings = SettingsStore();
  final _userController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _busy = true;
  String _message = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      if (!mounted) return;
      await _testServer(silent: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _userController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _testServer({bool silent = false}) async {
    if (!silent) {
      setState(() {
        _busy = true;
        _message = '';
      });
    }
    try {
      final data = await ApiClient(_settings).health();
      if (!mounted) return;
      if (!silent && mounted) {
        setState(() => _message =
            'Railway connected: ${data['db'] ?? data['postgresStatus'] ?? 'OK'}');
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
      final deviceId = await _settings.deviceId;
      final passwordText = _passwordController.text.trim();
      final client = ApiClient(_settings);
      UserSession session;
      try {
        session = await client.login(
            username: _userController.text.trim(),
            password: passwordText,
            pin: '',
            deviceId: deviceId);
      } on DealerSelectionRequired catch (selection) {
        if (!mounted) return;
        final dealer = await showModalBottomSheet<Dealer>(
            context: context,
            showDragHandle: true,
            builder: (_) => _DealerSheet(
                dealers: selection.dealers,
                onPick: (value) => Navigator.pop(context, value)));
        if (dealer == null) return;
        session = await client.login(
            username: _userController.text.trim(),
            password: passwordText,
            pin: '',
            dealerCode: dealer.code,
            deviceId: deviceId);
      }
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

  Future<void> _forgotPassword() async {
    final identifierController =
        TextEditingController(text: _userController.text.trim());
    final identifier = await showDialog<String>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Forgot password?'),
        content: TextField(
          controller: identifierController,
          autofocus: true,
          textInputAction: TextInputAction.done,
          decoration:
              const InputDecoration(labelText: 'User ID or registered email'),
          onSubmitted: (value) => Navigator.of(dialogContext).pop(value.trim()),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.of(dialogContext)
                  .pop(identifierController.text.trim()),
              child: const Text('Send link')),
        ],
      ),
    );
    identifierController.dispose();
    if (!mounted || identifier == null || identifier.isEmpty) return;
    setState(() {
      _busy = true;
      _message = '';
    });
    try {
      final message =
          await ApiClient(_settings).requestPasswordReset(identifier);
      if (mounted) setState(() => _message = message);
    } catch (error) {
      if (mounted) setState(() => _message = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Daksh Scan')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(18),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(
                  padding: const EdgeInsets.all(18),
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                      colors: [Color(0xFF0E1B2A), Color(0xFF0F4C81)],
                    ),
                    borderRadius: BorderRadius.circular(24),
                  ),
                  child: const Row(
                    children: [
                      _LoginMark(),
                      SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              'Secure login',
                              style: TextStyle(
                                color: Colors.white,
                                fontSize: 24,
                                fontWeight: FontWeight.w900,
                              ),
                            ),
                            SizedBox(height: 6),
                            Text(
                              'Connect to the Daksh web portal. Login and dealer verification unlock the scanner.',
                              style: TextStyle(
                                color: Color(0xDDF4F7FB),
                                height: 1.45,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 18),
                const Text('Daksh Railway server', textAlign: TextAlign.center),
                const SizedBox(height: 10),
                OutlinedButton.icon(
                    onPressed: _busy ? null : _testServer,
                    icon: const Icon(Icons.network_check),
                    label: const Text('Check Railway Connection')),
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
                  validator: (value) => (value ?? '').trim().isEmpty
                      ? 'Password is required'
                      : null,
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
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton(
                    onPressed: _busy ? null : _forgotPassword,
                    child: const Text('Forgot Password?'),
                  ),
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

class _LoginMark extends StatelessWidget {
  const _LoginMark();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 68,
      height: 68,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: Colors.white.withOpacity(0.14),
        border: Border.all(color: Colors.white.withOpacity(0.16)),
      ),
      child: const Icon(Icons.qr_code_scanner, color: Colors.white, size: 32),
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
