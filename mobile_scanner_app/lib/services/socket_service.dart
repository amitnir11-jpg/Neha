import 'package:socket_io_client/socket_io_client.dart' as io;

import 'settings_store.dart';

class SocketService {
  SocketService._internal();
  static final SocketService _instance = SocketService._internal();
  factory SocketService() => _instance;

  io.Socket? _socket;

  Future<void> connect(SettingsStore settings) async {
    final serverUrl = await settings.serverUrl;
    if (serverUrl.isEmpty) return;
    try {
      _socket ??= io.io(serverUrl, <String, dynamic>{
        'transports': ['websocket'],
        'autoConnect': true,
        'reconnection': true,
        'timeout': 20000,
      });
    } catch (_) {}
  }

  void on(String event, void Function(dynamic) callback) {
    _socket?.on(event, callback);
  }

  void off(String event, [void Function(dynamic)? callback]) {
    _socket?.off(event, callback);
  }

  void dispose() {
    try {
      _socket?.dispose();
    } catch (_) {}
    _socket = null;
  }
}
