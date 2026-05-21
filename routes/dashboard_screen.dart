import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'app_theme.dart';
import 'mobile_api.dart';
import 'mobile_pages.dart';
import 'sync_queue_provider.dart';
import 'auth_provider.dart';

class DashboardScreen extends ConsumerStatefulWidget {
  const DashboardScreen({super.key});

  @override
  ConsumerState<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends ConsumerState<DashboardScreen> {
  int _selectedIndex = 0;

  @override
  Widget build(BuildContext context) {
    final connection = ref.watch(mobileConnectionProvider);
    final pendingScans = ref.watch(syncQueueProvider);
    final user = ref.watch(authProvider).user ?? {};
    final permissions =
        Map<String, dynamic>.from(user['permissions'] as Map? ?? {});
    final canReports = permissions['canViewReports'] != false;
    final titles = [
      'Dealer: ${connection.dealerCode.isEmpty ? '24644' : connection.dealerCode}',
      'History',
      'Reports',
      'Settings'
    ];

    return Scaffold(
      appBar: AppBar(
        backgroundColor: AppTheme.backgroundColor,
        elevation: 0,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(titles[_selectedIndex],
                style:
                    const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
            Text(
              '${connection.connected ? 'PC Online' : 'PC Offline'} | ${pendingScans.isEmpty ? 'Synced' : '${pendingScans.length} Pending'}',
              style:
                  const TextStyle(fontSize: 12, color: AppTheme.textSecondary),
            ),
          ],
        ),
        actions: [
          IconButton(
            tooltip: 'Logout',
            icon: const Icon(Icons.logout, color: AppTheme.errorColor),
            onPressed: () async {
              await ref.read(authProvider.notifier).logout();
              if (context.mounted) context.go('/login');
            },
          ),
          IconButton(
            tooltip: 'Reconnect',
            icon: Icon(
                connection.connected ? Icons.cloud_done : Icons.cloud_off,
                color: connection.connected
                    ? AppTheme.successColor
                    : AppTheme.errorColor),
            onPressed: () => ref
                .read(mobileConnectionProvider.notifier)
                .connect(pendingCount: pendingScans.length),
          ),
          IconButton(
            tooltip: 'Sync',
            icon: const Icon(Icons.sync, color: AppTheme.primaryColor),
            onPressed: pendingScans.isEmpty
                ? null
                : () => ref.read(syncQueueProvider.notifier).syncPendingScans(),
          ),
          const SizedBox(width: 8),
        ],
      ),
      body: SafeArea(
        child: IndexedStack(
          index: _selectedIndex,
          children: [
            const _HomePage(),
            const HistoryPage(),
            canReports ? const ReportsPage() : const _NoPermissionPage(),
            const SettingsPage(),
          ],
        ),
      ),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _selectedIndex,
        onTap: (index) => setState(() => _selectedIndex = index),
        backgroundColor: AppTheme.surfaceColor,
        selectedItemColor: AppTheme.primaryColor,
        unselectedItemColor: AppTheme.textSecondary,
        type: BottomNavigationBarType.fixed,
        items: [
          const BottomNavigationBarItem(
              icon: Icon(Icons.home_rounded), label: 'Home'),
          const BottomNavigationBarItem(
              icon: Icon(Icons.history_rounded), label: 'History'),
          BottomNavigationBarItem(
              icon: Icon(canReports ? Icons.bar_chart_rounded : Icons.lock),
              label: 'Reports'),
          const BottomNavigationBarItem(
              icon: Icon(Icons.settings_rounded), label: 'Settings'),
        ],
      ),
    );
  }
}

class _NoPermissionPage extends StatelessWidget {
  const _NoPermissionPage();

  @override
  Widget build(BuildContext context) {
    return const Center(child: Text('Reports permission not assigned'));
  }
}

class _HomePage extends ConsumerWidget {
  const _HomePage();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final api = ref.watch(mobileApiProvider);
    final connection = ref.watch(mobileConnectionProvider);
    final pendingScans = ref.watch(syncQueueProvider);
    final permissions = Map<String, dynamic>.from(
        (ref.watch(authProvider).user ?? {})['permissions'] as Map? ?? {});
    final scanTypes = [
      if (permissions['canScanInward'] != false) 'INWARD',
      if (permissions['canScanOutward'] != false) 'OUTWARD',
      if (permissions['canScanFitted'] != false) 'FITTED',
      if (permissions['canScanDamage'] != false) 'DAMAGE',
    ];

    return RefreshIndicator(
      onRefresh: () async {
        await ref
            .read(mobileConnectionProvider.notifier)
            .heartbeat(pendingCount: pendingScans.length);
        await ref.read(syncQueueProvider.notifier).loadQueue();
      },
      child: FutureBuilder<List<dynamic>>(
        future: Future.wait([
          api.summary(dealerCode: connection.dealerCode),
          api.lastScans(dealerCode: connection.dealerCode, limit: 10),
        ]),
        builder: (context, snapshot) {
          final summary =
              (snapshot.data?[0] as Map<String, dynamic>?)?['summary']
                      as Map<String, dynamic>? ??
                  {};
          final recent =
              List<Map<String, dynamic>>.from(snapshot.data?[1] as List? ?? []);
          return ListView(
            padding: const EdgeInsets.all(20),
            children: [
              Container(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    colors: [
                      connection.connected
                          ? AppTheme.primaryColor.withOpacity(0.85)
                          : AppTheme.errorColor.withOpacity(0.85),
                      AppTheme.primaryColor.withOpacity(0.35),
                    ],
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                  ),
                  borderRadius: BorderRadius.circular(16),
                ),
                padding: const EdgeInsets.all(24),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                              connection.connected
                                  ? 'Ready to Scan'
                                  : 'Waiting for PC',
                              style: const TextStyle(
                                  color: Colors.white,
                                  fontSize: 20,
                                  fontWeight: FontWeight.bold)),
                          const SizedBox(height: 4),
                          Text(
                              connection.connected
                                  ? 'Auto-connected on same network'
                                  : connection.message,
                              style: TextStyle(
                                  color: Colors.white.withOpacity(0.9),
                                  fontSize: 14)),
                        ],
                      ),
                    ),
                    FloatingActionButton(
                      heroTag: 'scan_btn',
                      backgroundColor: Colors.white,
                      foregroundColor: AppTheme.primaryColor,
                      onPressed: () => context.push('/scan'),
                      child:
                          const Icon(Icons.qr_code_scanner_rounded, size: 28),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: scanTypes
                    .map((type) => FilledButton(
                          onPressed: () => context.push('/scan?type=$type'),
                          child: Text(type),
                        ))
                    .toList(),
              ),
              const SizedBox(height: 24),
              const Text('Overview',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
              const SizedBox(height: 16),
              GridView.count(
                crossAxisCount: 2,
                crossAxisSpacing: 16,
                mainAxisSpacing: 16,
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                childAspectRatio: 1.18,
                children: [
                  _StatCard(
                      title: 'Scan Records',
                      value: '${summary['total'] ?? 0}',
                      icon: Icons.inventory_2_rounded,
                      color: AppTheme.primaryColor),
                  _StatCard(
                      title: 'Pending Sync',
                      value: '${pendingScans.length}',
                      icon: Icons.sync_problem_rounded,
                      color: AppTheme.secondaryColor),
                  _StatCard(
                      title: 'Total Qty',
                      value: '${summary['totalQty'] ?? 0}',
                      icon: Icons.add_task_rounded,
                      color: AppTheme.successColor),
                  _StatCard(
                      title: 'Duplicates',
                      value: '${summary['duplicateCount'] ?? summary['duplicates'] ?? 0}',
                      icon: Icons.content_copy_rounded,
                      color: AppTheme.secondaryColor),
                  _StatCard(
                      title: 'PC Status',
                      value: connection.connected ? 'Online' : 'Offline',
                      icon: Icons.dns_rounded,
                      color: connection.connected
                          ? AppTheme.successColor
                          : AppTheme.errorColor),
                ],
              ),
              const SizedBox(height: 24),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Text('Last Scans',
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
                  TextButton(onPressed: () {}, child: const Text('Live')),
                ],
              ),
              const SizedBox(height: 8),
              if (snapshot.connectionState == ConnectionState.waiting)
                const Center(
                    child: Padding(
                        padding: EdgeInsets.all(24),
                        child: CircularProgressIndicator()))
              else if (recent.isEmpty)
                const Card(
                    child: Padding(
                        padding: EdgeInsets.all(20),
                        child: Text('No scans found for active dealer.',
                            style: TextStyle(color: AppTheme.textSecondary))))
              else
                Card(
                  child: ListView.separated(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    itemCount: recent.length,
                    separatorBuilder: (context, index) => const Divider(
                        color: AppTheme.surfaceLightColor, height: 1),
                    itemBuilder: (context, index) {
                      final row = recent[index];
                      return ListTile(
                        leading: const CircleAvatar(
                          backgroundColor: AppTheme.surfaceLightColor,
                          child: Icon(Icons.check_circle_rounded,
                              color: AppTheme.successColor, size: 20),
                        ),
                        title: Text(
                            '${row['partNumber'] ?? row['part'] ?? 'UNKNOWN'}',
                            style:
                                const TextStyle(fontWeight: FontWeight.bold)),
                        subtitle: Text(
                            'Qty: ${row['qty'] ?? row['quantity'] ?? 0} | ${row['scanType'] ?? row['type'] ?? ''}',
                            style: const TextStyle(
                                fontSize: 12, color: AppTheme.textSecondary)),
                        trailing: const Icon(Icons.cloud_done_rounded,
                            color: AppTheme.textSecondary, size: 18),
                      );
                    },
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

class _StatCard extends StatelessWidget {
  const _StatCard(
      {required this.title,
      required this.value,
      required this.icon,
      required this.color});

  final String title;
  final String value;
  final IconData icon;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                  color: color.withOpacity(0.1),
                  borderRadius: BorderRadius.circular(8)),
              child: Icon(icon, color: color, size: 20),
            ),
            const Spacer(),
            Text(value,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style:
                    const TextStyle(fontSize: 22, fontWeight: FontWeight.bold)),
            const SizedBox(height: 4),
            Text(title,
                style: const TextStyle(
                    fontSize: 12, color: AppTheme.textSecondary)),
          ],
        ),
      ),
    );
  }
}
