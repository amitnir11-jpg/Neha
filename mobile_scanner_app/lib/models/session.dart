class UserSession {
  UserSession({
    required this.token,
    required this.userId,
    required this.loginId,
    required this.userName,
    required this.role,
    required this.dealerCode,
    this.dealerName = '',
  });

  final String token;
  final String userId;
  final String loginId;
  final String userName;
  final String role;
  final String dealerCode;
  final String dealerName;

  factory UserSession.fromLogin(Map<String, dynamic> json) {
    final user = Map<String, dynamic>.from(json['user'] ?? {});
    return UserSession(
      token: (json['token'] ?? '').toString(),
      userId: (user['id'] ?? user['_id'] ?? user['username'] ?? '').toString(),
      loginId: (user['username'] ?? user['email'] ?? '').toString(),
      userName: (user['name'] ?? user['username'] ?? '').toString(),
      role: (user['role'] ?? '').toString(),
      dealerCode: (json['dealerCode'] ?? '').toString().toUpperCase(),
      dealerName: (json['dealerName'] ?? '').toString(),
    );
  }

  Map<String, String> toPrefs() => {
        'userId': userId,
        'loginId': loginId,
        'userName': userName,
        'role': role,
        'dealerCode': dealerCode,
        'dealerName': dealerName,
      };
}
