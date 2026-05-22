class Dealer {
  Dealer({required this.code, required this.name});

  final String code;
  final String name;

  factory Dealer.fromJson(Map<String, dynamic> json) {
    return Dealer(
      code: (json['dealerCode'] ?? json['code'] ?? '')
          .toString()
          .trim()
          .toUpperCase(),
      name: (json['dealerName'] ?? json['name'] ?? '').toString().trim(),
    );
  }

  String get displayName => name.isEmpty ? code : '$code - $name';
}
