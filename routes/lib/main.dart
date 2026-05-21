import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'app_theme.dart';
import 'app_router.dart';

void main() {
  runApp(const ProviderScope(child: DakshScannerApp()));
}

class DakshScannerApp extends ConsumerWidget {
  const DakshScannerApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final goRouter = ref.watch(goRouterProvider);

    return MaterialApp.router(
      title: 'Daksh Inventory Scanner',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.darkNavyTheme,
      routerConfig: goRouter,
    );
  }
}
