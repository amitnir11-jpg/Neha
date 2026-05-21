import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'app_theme.dart';
import 'custom_button.dart';
import 'custom_textfield.dart';
import 'auth_provider.dart';
import 'mobile_api.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  bool _isPinLogin = true;
  final _dealerCodeController = TextEditingController();
  final _usernameController = TextEditingController();
  final _passwordController = TextEditingController();
  final _serverController = TextEditingController();

  @override
  void initState() {
    super.initState();
    Future.microtask(() async {
      final url = await ref.read(mobileApiProvider).lastServerUrl();
      if (mounted && url.isNotEmpty) _serverController.text = url;
    });
  }

  @override
  void dispose() {
    _dealerCodeController.dispose();
    _usernameController.dispose();
    _passwordController.dispose();
    _serverController.dispose();
    super.dispose();
  }

  void _handleLogin() async {
    final dealerCode = _dealerCodeController.text.trim();
    final username = _usernameController.text.trim();
    final passwordOrPin = _passwordController.text.trim();

    if (dealerCode.isEmpty || username.isEmpty || passwordOrPin.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Please fill in all fields')));
      return;
    }

    if (!ref.read(mobileConnectionProvider).connected) {
      await ref.read(mobileConnectionProvider.notifier).connect();
      if (!ref.read(mobileConnectionProvider).connected) {
        final message = ref.read(mobileConnectionProvider).message;
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(message), backgroundColor: AppTheme.errorColor),
          );
        }
        return;
      }
    }

    final authNotifier = ref.read(authProvider.notifier);
    final success = _isPinLogin
        ? await authNotifier.pinLogin(dealerCode, username, passwordOrPin)
        : await authNotifier.login(dealerCode, username, passwordOrPin);

    if (success && mounted) {
      context.go('/dashboard');
    } else if (mounted) {
      final error = ref.read(authProvider).error;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
            content: Text(error ?? 'Login failed'),
            backgroundColor: AppTheme.errorColor),
      );
    }
  }

  void _connectManualServer() async {
    final value = _serverController.text.trim();
    if (value.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Enter PC IP and port, for example 192.168.1.10:3001'),
          backgroundColor: AppTheme.errorColor,
        ),
      );
      return;
    }
    await ref.read(mobileConnectionProvider.notifier).connectToManualServer(value);
    if (!mounted) return;
    final connection = ref.read(mobileConnectionProvider);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(connection.connected ? 'Connected to PC server' : connection.message),
        backgroundColor: connection.connected ? AppTheme.successColor : AppTheme.errorColor,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authProvider);
    final connection = ref.watch(mobileConnectionProvider);

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24.0),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Icon(Icons.warehouse_rounded,
                    size: 48, color: AppTheme.primaryColor),
                const SizedBox(height: 16),
                Text(
                  'Secure Login',
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 40),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(24.0),
                    child: Column(
                      children: [
                        CustomTextField(
                          controller: _dealerCodeController,
                          label: 'Dealer Code',
                          prefixIcon: Icons.store_rounded,
                        ),
                        CustomTextField(
                          controller: _usernameController,
                          label: 'Username',
                          prefixIcon: Icons.person_rounded,
                        ),
                        if (_isPinLogin)
                          CustomTextField(
                            controller: _passwordController,
                            label: 'Staff 4-Digit PIN',
                            prefixIcon: Icons.dialpad_rounded,
                            isPassword: true,
                            keyboardType: TextInputType.number,
                          )
                        else
                          CustomTextField(
                            controller: _passwordController,
                            label: 'Password',
                            prefixIcon: Icons.lock_rounded,
                            isPassword: true,
                          ),
                        const SizedBox(height: 8),
                        CustomButton(
                          text: 'LOGIN',
                          onPressed: _handleLogin,
                          isLoading: authState.isLoading,
                          icon: Icons.login_rounded,
                        ),
                        const SizedBox(height: 16),
                        TextButton(
                          onPressed: () {
                            setState(() {
                              _isPinLogin = !_isPinLogin;
                              _passwordController.clear();
                            });
                          },
                          child: Text(
                            _isPinLogin
                                ? 'Use Username/Password'
                                : 'Use Staff PIN',
                            style:
                                const TextStyle(color: AppTheme.textSecondary),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 24),
                Container(
                  padding:
                      const EdgeInsets.symmetric(vertical: 12, horizontal: 16),
                  decoration: BoxDecoration(
                    color: (connection.connected ? AppTheme.successColor : AppTheme.errorColor)
                        .withOpacity(0.1),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(
                        color: (connection.connected ? AppTheme.successColor : AppTheme.errorColor)
                            .withOpacity(0.3)),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                  color: connection.connected
                                      ? AppTheme.successColor
                                      : AppTheme.errorColor,
                                  shape: BoxShape.circle)),
                          const SizedBox(width: 12),
                          Text(
                            connection.loading
                                ? 'Checking PC Server...'
                                : connection.connected
                                    ? 'Server Status: Connected'
                                    : 'Server Status: Not Connected',
                            style: TextStyle(
                                color: connection.connected
                                    ? AppTheme.successColor
                                    : AppTheme.errorColor,
                                fontWeight: FontWeight.w600),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Text(
                        connection.serverUrl.isEmpty ? connection.message : '${connection.serverUrl} - ${connection.message}',
                        textAlign: TextAlign.center,
                        style: const TextStyle(color: AppTheme.textSecondary, fontSize: 12),
                      ),
                      const SizedBox(height: 12),
                      TextField(
                        controller: _serverController,
                        decoration: const InputDecoration(
                          labelText: 'Manual PC IP / Port',
                          hintText: '192.168.1.10:3001',
                          prefixIcon: Icon(Icons.dns_rounded),
                        ),
                      ),
                      const SizedBox(height: 10),
                      OutlinedButton.icon(
                        onPressed: connection.loading ? null : _connectManualServer,
                        icon: const Icon(Icons.settings_ethernet_rounded),
                        label: const Text('CONNECT MANUALLY'),
                      ),
                    ],
                  ),
                )
              ],
            ),
          ),
        ),
      ),
    );
  }
}
