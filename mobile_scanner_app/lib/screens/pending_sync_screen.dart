import 'package:flutter/material.dart';

import '../models/scan_record.dart';
import '../services/local_database.dart';
import '../services/sync_service.dart';
import '../widgets/status_chip.dart';

class PendingSyncScreen extends StatefulWidget {
  const PendingSyncScreen({super.key});

  @override
  State<PendingSyncScreen> createState() => _PendingSyncScreenState();
}

class _PendingSyncScreenState extends State<PendingSyncScreen> {
  List<ScanRecord> _records = [];
  bool _busy = false;
  String _message = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final records = await LocalDatabase.instance.pendingScans(limit: 500);
    if (!mounted) return;
    setState(() => _records = records);
  }

  Future<void> _sync() async {
    setState(() {
      _busy = true;
      _message = '';
    });
    final result = await SyncService().syncPending();
    await _load();
    if (!mounted) return;
    setState(() {
      _busy = false;
      _message = result.message;
    });
  }

  Future<void> _export() async {
    final data = await LocalDatabase.instance.exportJson();
    if (!mounted) return;
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Local Backup JSON'),
        content: SizedBox(
            width: double.maxFinite,
            child: SingleChildScrollView(child: SelectableText(data))),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Close'))
        ],
      ),
    );
  }

  Color _color(String status) {
    if (status == 'Synced') return Colors.green;
    if (status == 'Failed') return Colors.red;
    return Colors.orange;
  }

  String _istDateTime(DateTime value) {
    final ist = value.toUtc().add(const Duration(hours: 5, minutes: 30));
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec'
    ];
    final hour12 = ist.hour % 12 == 0 ? 12 : ist.hour % 12;
    final suffix = ist.hour >= 12 ? 'PM' : 'AM';
    String two(int number) => number.toString().padLeft(2, '0');
    return '${two(ist.day)}-${months[ist.month - 1]}-${ist.year} ${two(hour12)}:${two(ist.minute)}:${two(ist.second)} $suffix';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Pending Sync')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              children: [
                StatusChip(
                    label: '${_records.length} pending/failed',
                    color: _records.isEmpty ? Colors.green : Colors.orange),
                const Spacer(),
                IconButton(
                    onPressed: _busy ? null : _export,
                    icon: const Icon(Icons.backup)),
                FilledButton.icon(
                    onPressed: _busy ? null : _sync,
                    icon: const Icon(Icons.sync),
                    label: const Text('Manual Sync')),
              ],
            ),
          ),
          if (_message.isNotEmpty)
            Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: Text(_message,
                    style: const TextStyle(fontWeight: FontWeight.w800))),
          Expanded(
            child: _records.isEmpty
                ? const Center(child: Text('No pending sync records'))
                : ListView.separated(
                    itemCount: _records.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (_, index) {
                      final scan = _records[index];
                      return ListTile(
                        leading:
                            Icon(Icons.qr_code, color: _color(scan.status)),
                        title: Text('${scan.partNumber}  x${scan.quantity}',
                            style:
                                const TextStyle(fontWeight: FontWeight.w900)),
                        subtitle: Text(
                            '${scan.scanType} | ${scan.binLocation} | ${_istDateTime(scan.createdAt)}${scan.errorMessage.isEmpty ? '' : '\n${scan.errorMessage}'}'),
                        trailing: Text(scan.status,
                            style: TextStyle(
                                color: _color(scan.status),
                                fontWeight: FontWeight.w900)),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
