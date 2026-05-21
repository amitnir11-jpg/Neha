import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'app_theme.dart';
import 'mobile_api.dart';
import 'sync_queue_provider.dart';

class HistoryPage extends ConsumerWidget {
  const HistoryPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final api = ref.watch(mobileApiProvider);
    final connection = ref.watch(mobileConnectionProvider);
    return FutureBuilder<List<Map<String, dynamic>>>(
      future: api.lastScans(dealerCode: connection.dealerCode, limit: 50),
      builder: (context, snapshot) {
        final rows = snapshot.data ?? [];
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }
        if (rows.isEmpty) {
          return const _EmptyState(
              title: 'No scan history',
              subtitle: 'Scans will appear after sync.');
        }
        return RefreshIndicator(
          onRefresh: () async => ref
              .read(mobileConnectionProvider.notifier)
              .heartbeat(pendingCount: ref.read(syncQueueProvider).length),
          child: ListView.separated(
            padding: const EdgeInsets.all(20),
            itemCount: rows.length,
            separatorBuilder: (_, __) => const SizedBox(height: 10),
            itemBuilder: (context, index) => _ScanTile(row: rows[index]),
          ),
        );
      },
    );
  }
}

class ReportsPage extends ConsumerWidget {
  const ReportsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return const DefaultTabController(
      length: 2,
      child: Column(
        children: [
          TabBar(
            tabs: [
              Tab(icon: Icon(Icons.history_rounded), text: 'Last 20'),
              Tab(icon: Icon(Icons.verified_rounded), text: 'Verification'),
            ],
          ),
          Expanded(
            child: TabBarView(
              children: [
                _LastTwentyScansTab(),
                _VerificationTab(),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _LastTwentyScansTab extends ConsumerWidget {
  const _LastTwentyScansTab();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final api = ref.watch(mobileApiProvider);
    final connection = ref.watch(mobileConnectionProvider);
    return FutureBuilder<List<Map<String, dynamic>>>(
      future: api.lastScans(
          dealerCode: connection.dealerCode,
          limit: 20,
          currentDeviceOnly: false),
      builder: (context, snapshot) {
        final rows = snapshot.data ?? [];
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Center(child: CircularProgressIndicator());
        }
        if (rows.isEmpty) {
          return const _EmptyState(
              title: 'No scan data',
              subtitle: 'Last 20 synced scans will appear here.');
        }
        return RefreshIndicator(
          onRefresh: () async => ref
              .read(mobileConnectionProvider.notifier)
              .heartbeat(pendingCount: ref.read(syncQueueProvider).length),
          child: ListView.separated(
            padding: const EdgeInsets.all(20),
            itemCount: rows.length,
            separatorBuilder: (_, __) => const SizedBox(height: 10),
            itemBuilder: (context, index) => _ScanTile(row: rows[index]),
          ),
        );
      },
    );
  }
}

class _VerificationTab extends ConsumerStatefulWidget {
  const _VerificationTab();

  @override
  ConsumerState<_VerificationTab> createState() => _VerificationTabState();
}

class _VerificationTabState extends ConsumerState<_VerificationTab> {
  final _controller = TextEditingController();
  Future<Map<String, dynamic>>? _result;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _verify() {
    final value = _controller.text.trim();
    if (value.isEmpty) return;
    final api = ref.read(mobileApiProvider);
    final connection = ref.read(mobileConnectionProvider);
    setState(() {
      _result = api.verifyScan(value, dealerCode: connection.dealerCode);
    });
  }

  Future<void> _scanAndVerify() async {
    final value = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const _VerificationScannerPage()),
    );
    final cleanValue = value?.trim();
    if (cleanValue == null || cleanValue.isEmpty || !mounted) return;
    _controller.text = cleanValue;
    _verify();
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                TextField(
                  controller: _controller,
                  textCapitalization: TextCapitalization.characters,
                  onSubmitted: (_) => _verify(),
                  decoration: const InputDecoration(
                    labelText: 'Part QR code / part number',
                    prefixIcon: Icon(Icons.qr_code_scanner_rounded),
                  ),
                ),
                const SizedBox(height: 12),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    onPressed: _scanAndVerify,
                    icon: const Icon(Icons.qr_code_scanner_rounded),
                    label: const Text('Verify Scan'),
                  ),
                ),
                const SizedBox(height: 8),
                TextButton.icon(
                  onPressed: _verify,
                  icon: const Icon(Icons.search_rounded),
                  label: const Text('Verify Typed Code'),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 12),
        if (_result != null)
          FutureBuilder<Map<String, dynamic>>(
            future: _result,
            builder: (context, snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const Center(
                    child: Padding(
                        padding: EdgeInsets.all(24),
                        child: CircularProgressIndicator()));
              }
              final data = snapshot.data ?? {};
              final scanned = data['scanned'] == true;
              final row = Map<String, dynamic>.from(data['scan'] as Map? ?? {});
              final color =
                  scanned ? AppTheme.successColor : AppTheme.errorColor;
              return Card(
                color: color.withOpacity(0.10),
                child: ListTile(
                  leading: CircleAvatar(
                    backgroundColor: color.withOpacity(0.16),
                    child: Icon(
                      scanned
                          ? Icons.check_circle_rounded
                          : Icons.cancel_rounded,
                      color: color,
                    ),
                  ),
                  title: Text(
                    scanned ? 'QR code scanned' : 'QR code not scanned',
                    style: TextStyle(color: color, fontWeight: FontWeight.bold),
                  ),
                  subtitle: Text(scanned
                      ? '${row['partNumber'] ?? '-'} | Qty ${row['qty'] ?? row['quantity'] ?? 0} | ${row['scanType'] ?? row['type'] ?? ''} | ${_dateText(row['timestamp'] ?? row['scanTime'])}'
                      : data['message']?.toString() ??
                          'No matching scan data found.'),
                ),
              );
            },
          ),
      ],
    );
  }
}

class _VerificationScannerPage extends StatefulWidget {
  const _VerificationScannerPage();

  @override
  State<_VerificationScannerPage> createState() =>
      _VerificationScannerPageState();
}

class _VerificationScannerPageState extends State<_VerificationScannerPage> {
  late final MobileScannerController _scannerController;
  bool _returning = false;
  bool _isFlashOn = false;

  @override
  void initState() {
    super.initState();
    _scannerController = MobileScannerController(
      formats: const [BarcodeFormat.all],
      detectionSpeed: DetectionSpeed.normal,
      facing: CameraFacing.back,
    );
  }

  @override
  void dispose() {
    _scannerController.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_returning || capture.barcodes.isEmpty) return;
    final value = capture.barcodes.first.rawValue?.trim();
    if (value == null || value.isEmpty) return;
    _returning = true;
    Navigator.of(context).pop(value);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(
            controller: _scannerController,
            onDetect: _onDetect,
            errorBuilder: (context, error, child) {
              return const Center(
                child: Text(
                  'Camera Initialization Failed.\nPlease check permissions.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white, fontSize: 16),
                ),
              );
            },
          ),
          Container(color: Colors.black.withOpacity(0.28)),
          Positioned(
            top: MediaQuery.of(context).padding.top + 10,
            left: 12,
            right: 12,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                IconButton(
                  style: IconButton.styleFrom(
                      backgroundColor: AppTheme.surfaceColor.withOpacity(0.85)),
                  icon:
                      const Icon(Icons.arrow_back_rounded, color: Colors.white),
                  onPressed: () => Navigator.of(context).pop(),
                ),
                IconButton(
                  style: IconButton.styleFrom(
                      backgroundColor: AppTheme.surfaceColor.withOpacity(0.85)),
                  icon: Icon(
                    _isFlashOn
                        ? Icons.flash_on_rounded
                        : Icons.flash_off_rounded,
                    color: _isFlashOn ? AppTheme.secondaryColor : Colors.white,
                  ),
                  onPressed: () {
                    _scannerController.toggleTorch();
                    setState(() => _isFlashOn = !_isFlashOn);
                  },
                ),
              ],
            ),
          ),
          Center(
            child: Container(
              width: MediaQuery.of(context).size.width * 0.72,
              height: MediaQuery.of(context).size.width * 0.72,
              decoration: BoxDecoration(
                border: Border.all(color: AppTheme.primaryColor, width: 4),
                borderRadius: BorderRadius.circular(18),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class SettingsPage extends ConsumerStatefulWidget {
  const SettingsPage({super.key});

  @override
  ConsumerState<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends ConsumerState<SettingsPage> {
  final _serverController = TextEditingController();

  @override
  void dispose() {
    _serverController.dispose();
    super.dispose();
  }

  Future<void> _connectManualServer(int pending) async {
    final value = _serverController.text.trim();
    if (value.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Enter PC IP and port, for example 192.168.31.28:3001'),
          backgroundColor: AppTheme.errorColor,
        ),
      );
      return;
    }
    await ref
        .read(mobileConnectionProvider.notifier)
        .connectToManualServer(value, pendingCount: pending);
    if (!mounted) return;
    final connection = ref.read(mobileConnectionProvider);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(connection.connected
            ? 'Connected to PC server'
            : connection.message),
        backgroundColor:
            connection.connected ? AppTheme.successColor : AppTheme.errorColor,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(mobileConnectionProvider);
    final pending = ref.watch(syncQueueProvider).length;
    if (_serverController.text.isEmpty && state.serverUrl.isNotEmpty) {
      _serverController.text = state.serverUrl;
    }
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        _SummaryRow(
            label: 'Server URL',
            value: state.serverUrl.isEmpty
                ? 'Auto detecting...'
                : state.serverUrl),
        _SummaryRow(
            label: 'Device ID',
            value: state.deviceId.isEmpty ? 'Creating...' : state.deviceId),
        _SummaryRow(
            label: 'PC Connection',
            value: state.connected ? 'Connected' : 'Waiting'),
        _SummaryRow(
            label: 'Dealer',
            value: state.dealerName.isEmpty
                ? state.dealerCode
                : '${state.dealerName} (${state.dealerCode})'),
        _SummaryRow(
            label: 'Audit ID',
            value: state.auditId.isEmpty ? '-' : state.auditId),
        _SummaryRow(label: 'Pending Local Scans', value: '$pending'),
        const SizedBox(height: 18),
        TextField(
          controller: _serverController,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(
            labelText: 'PC IP and port',
            hintText: '192.168.31.28:3001',
            prefixIcon: Icon(Icons.router_rounded),
          ),
          onSubmitted: (_) => _connectManualServer(pending),
        ),
        const SizedBox(height: 10),
        FilledButton.icon(
          onPressed: state.loading ? null : () => _connectManualServer(pending),
          icon: const Icon(Icons.cable_rounded),
          label: const Text('Connect to This PC'),
        ),
        const SizedBox(height: 10),
        FilledButton.icon(
          onPressed: () => ref
              .read(mobileConnectionProvider.notifier)
              .connect(pendingCount: pending),
          icon: const Icon(Icons.wifi_tethering),
          label: const Text('Reconnect to PC'),
        ),
        const SizedBox(height: 10),
        OutlinedButton.icon(
          onPressed: pending == 0
              ? null
              : () => ref.read(syncQueueProvider.notifier).syncPendingScans(),
          icon: const Icon(Icons.cloud_sync),
          label: const Text('Sync Pending Scans'),
        ),
      ],
    );
  }
}

class _ScanTile extends StatelessWidget {
  const _ScanTile({required this.row});

  final Map<String, dynamic> row;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: ListTile(
        leading: const CircleAvatar(
          backgroundColor: AppTheme.surfaceLightColor,
          child: Icon(Icons.qr_code_2, color: AppTheme.primaryColor),
        ),
        title: Text('${row['partNumber'] ?? row['part'] ?? 'UNKNOWN'}',
            style: const TextStyle(fontWeight: FontWeight.bold)),
        subtitle: Text(
            'Qty: ${row['qty'] ?? row['quantity'] ?? 0} | ${row['scanType'] ?? row['type'] ?? ''} | ${_dateText(row['timestamp'] ?? row['scanTime'])}'),
        trailing: Text('${row['syncStatus'] ?? ''}',
            style: const TextStyle(color: AppTheme.textSecondary)),
      ),
    );
  }
}

class _SummaryRow extends StatelessWidget {
  const _SummaryRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            Expanded(
                child: Text(label,
                    style: const TextStyle(color: AppTheme.textSecondary))),
            const SizedBox(width: 12),
            Flexible(
                child: Text(value,
                    textAlign: TextAlign.right,
                    style: const TextStyle(fontWeight: FontWeight.bold))),
          ],
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState({required this.title, required this.subtitle});

  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.inventory_2_outlined,
                size: 52, color: AppTheme.textSecondary),
            const SizedBox(height: 14),
            Text(title,
                style:
                    const TextStyle(fontWeight: FontWeight.bold, fontSize: 18)),
            const SizedBox(height: 8),
            Text(subtitle,
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppTheme.textSecondary)),
          ],
        ),
      ),
    );
  }
}

String _dateText(dynamic value) {
  if (value == null || '$value'.isEmpty) return '-';
  final date = DateTime.tryParse('$value');
  if (date == null) return '$value';
  return '${date.day.toString().padLeft(2, '0')}/${date.month.toString().padLeft(2, '0')} ${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
}
