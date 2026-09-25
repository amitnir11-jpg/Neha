import 'dart:async';

import 'package:socket_io_client/socket_io_client.dart' as io;

import 'api_client.dart';
import 'settings_store.dart';

class SocketService {
  SocketService._internal();
  static final SocketService _instance = SocketService._internal();
  factory SocketService() => _instance;

  io.Socket? _socket;
  String _activeServerUrl = '';
  Timer? _heartbeatTimer;

  Future<void> connect(SettingsStore settings) async {
    final serverUrl = await settings.serverUrl;
    final token = await settings.token;
    if (serverUrl.isEmpty) return;
    try {
      if (_socket != null && _activeServerUrl == serverUrl) return;
      if (_activeServerUrl != serverUrl) dispose();
      _activeServerUrl = serverUrl;
      _socket = io.io(serverUrl, <String, dynamic>{
        'transports': ['websocket'],
        'autoConnect': false,
        'reconnection': true,
        'timeout': 20000,
        'auth': <String, dynamic>{'token': token},
      });
      final deviceId = await settings.deviceId;
      _socket!.on('connect', (_) {
        _socket?.emit('device:hello', <String, dynamic>{
          'deviceId': deviceId,
          'deviceName': 'Daksh Android Scanner',
          'deviceType': 'mobile',
          'connectionMethod': 'wifi',
          'serverUrl': serverUrl,
          'appVersion': mobileAppVersionName,
        });
        _heartbeatTimer?.cancel();
        _heartbeatTimer = Timer.periodic(const Duration(seconds: 10), (_) {
          _socket?.emit('device:heartbeat', <String, dynamic>{
            'deviceId': deviceId,
            'deviceType': 'mobile',
            'serverUrl': serverUrl,
          });
        });
      });
      _socket!.on('disconnect', (_) => _heartbeatTimer?.cancel());
      _socket!.connect();
    } catch (_) {}
  }

  void on(String event, void Function(dynamic) callback) {
    _socket?.on(event, callback);
  }

  void off(String event, [void Function(dynamic)? callback]) {
    _socket?.off(event, callback);
  }

  void dispose() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    try {
      _socket?.dispose();
    } catch (_) {}
    _socket = null;
    _activeServerUrl = '';
  }
}
