import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'app_theme.dart';
import 'auth_provider.dart';

class SplashScreen extends ConsumerStatefulWidget {
  const SplashScreen({super.key});

  @override
  ConsumerState<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends ConsumerState<SplashScreen> {
  @override
  void initState() {
    super.initState();
    _initialize();
  }

  Future<void> _initialize() async {
    // Check for existing login session
    final authNotifier = ref.read(authProvider.notifier);
    final isLoggedIn = await authNotifier.checkLoginStatus();

    await Future.delayed(const Duration(seconds: 2));
    if (mounted) {
      if (isLoggedIn) {
        context.go('/dashboard');
      } else {
        context.go('/login');
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(
                color: AppTheme.surfaceLightColor,
                shape: BoxShape.circle,
                border: Border.all(
                    color: AppTheme.primaryColor.withOpacity(0.2), width: 2),
              ),
              child: const Icon(Icons.qr_code_scanner_rounded,
                  size: 64, color: AppTheme.primaryColor),
            ),
            const SizedBox(height: 24),
            Text(
              'DAKSH INVENTORY',
              style: Theme.of(context)
                  .textTheme
                  .titleLarge
                  ?.copyWith(letterSpacing: 2),
            ),
            const SizedBox(height: 8),
            Text('Initializing services...',
                style: Theme.of(context).textTheme.bodyMedium),
            const SizedBox(height: 48),
            const CircularProgressIndicator(color: AppTheme.primaryColor),
          ],
        ),
      ),
    );
  }
}
