import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../services/settings_store.dart';

class ServerQrScreen extends StatefulWidget {
  const ServerQrScreen({super.key});

  @override
  State<ServerQrScreen> createState() => _ServerQrScreenState();
}

class _ServerQrScreenState extends State<ServerQrScreen> {
  final MobileScannerController _controller = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const [BarcodeFormat.qrCode],
  );
  bool _handled = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_handled) return;
    final raw = capture.barcodes.map((barcode) => barcode.rawValue).firstWhere(
        (value) => value != null && value.trim().isNotEmpty,
        orElse: () => null);
    if (raw == null) return;
    Map<String, dynamic>? payload;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) payload = Map<String, dynamic>.from(decoded);
    } catch (_) {}
    if (payload != null) {
      final pairing = payload;
      final url = SettingsStore.serverUrlFromPayload(pairing);
      if (url.isEmpty) return;
      _handled = true;
      await SettingsStore().savePairingPayload(pairing);
      if (mounted) Navigator.of(context).pop(url);
      return;
    }
    final url = SettingsStore.normalizeServerUrl(raw);
    if (url.isEmpty) return;
    _handled = true;
    if (mounted) Navigator.of(context).pop(url);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan Web Portal QR')),
      body: Column(
        children: [
          Expanded(
            child: MobileScanner(controller: _controller, onDetect: _onDetect),
          ),
          const Padding(
            padding: EdgeInsets.all(16),
            child: Text(
              'Scan the Daksh web portal pairing QR. The app will use the server URL from the QR payload.',
              textAlign: TextAlign.center,
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
  }
}
