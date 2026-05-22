import 'package:daksh_mobile_scanner/services/settings_store.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('normalizes pairing QR payloads to a server URL', () {
    const payload =
        '{"serverUrl":"https://daksh.example.com","syncUrl":"https://daksh.example.com/api/mobile/sync"}';
    expect(
        SettingsStore.normalizeServerUrl(payload), 'https://daksh.example.com');
  });

  test('strips API paths from scanned URLs', () {
    expect(
        SettingsStore.normalizeServerUrl(
            'https://daksh.example.com/api/health'),
        'https://daksh.example.com');
  });
}
