import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'dart:convert';
import 'auth_service.dart';

class AuthState {
  final bool isLoading;
  final String? error;
  final String? token;
  final Map<String, dynamic>? user;

  AuthState({this.isLoading = false, this.error, this.token, this.user});

  AuthState copyWith(
      {bool? isLoading,
      String? error,
      String? token,
      Map<String, dynamic>? user}) {
    return AuthState(
      isLoading: isLoading ?? this.isLoading,
      error: error,
      token: token ?? this.token,
      user: user ?? this.user,
    );
  }
}

final authProvider = StateNotifierProvider<AuthNotifier, AuthState>((ref) {
  return AuthNotifier(AuthService());
});

class AuthNotifier extends StateNotifier<AuthState> {
  final AuthService _authService;
  final _storage = const FlutterSecureStorage();

  AuthNotifier(this._authService) : super(AuthState());

  Future<bool> checkLoginStatus() async {
    try {
      final token = await _storage.read(key: 'jwt_token');
      if (token != null && token.isNotEmpty) {
        final userRaw = await _storage.read(key: 'daksh_user');
        state = state.copyWith(
            isLoading: false,
            token: token,
            user: userRaw == null ? null : jsonDecode(userRaw));
        return true;
      }
    } catch (e) {
      // Ignore or log storage error
    }
    return false;
  }

  Future<bool> login(
      String dealerCode, String username, String password) async {
    state = state.copyWith(isLoading: true, error: null);
    final result = await _authService.login(dealerCode, username, password);
    return await _handleResult(result);
  }

  Future<bool> pinLogin(String dealerCode, String username, String pin) async {
    state = state.copyWith(isLoading: true, error: null);
    final result = await _authService.pinLogin(dealerCode, username, pin);
    return await _handleResult(result);
  }

  Future<bool> _handleResult(Map<String, dynamic> result) async {
    if (result['success'] == true) {
      final token = result['token'];
      if (token != null) {
        await _storage.write(key: 'jwt_token', value: token);
      }
      if (result['user'] != null) {
        await _storage.write(
            key: 'daksh_user', value: jsonEncode(result['user']));
      }
      state = state.copyWith(
          isLoading: false, token: result['token'], user: result['user']);
      return true;
    } else {
      state = state.copyWith(
          isLoading: false,
          error: result['message'] ?? 'Authentication failed');
      return false;
    }
  }

  Future<void> logout() async {
    await _storage.delete(key: 'jwt_token');
    await _storage.delete(key: 'daksh_user');
    state = AuthState();
  }
}
