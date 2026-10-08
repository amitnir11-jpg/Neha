/// Camera transport normalization only. Part/UPI mapping lives in the shared backend parser.
String normalizeDecodedValue(String raw) =>
    raw.replaceAll(RegExp(r'[\r\n\t]'), '').trim().toUpperCase();

class CameraFrameGuard {
  CameraFrameGuard(
      {this.window = const Duration(milliseconds: 1800),
      DateTime Function()? clock})
      : _clock = clock ?? DateTime.now;
  final Duration window;
  final DateTime Function() _clock;
  final Map<String, DateTime> _lastSeen = {};
  final Map<String, DateTime> _lastObserved = {};

  bool accept(String key) {
    final now = _clock();
    final observed = _lastObserved[key];
    _lastObserved[key] = now;
    if (observed != null && now.difference(observed) < const Duration(seconds: 1)) {
      return false;
    }
    final previous = _lastSeen[key];
    if (previous != null && now.difference(previous) < window) return false;
    _lastSeen[key] = now;
    _lastSeen.removeWhere(
        (_, seen) => now.difference(seen) > const Duration(seconds: 30));
    _lastObserved.removeWhere(
        (_, seen) => now.difference(seen) > const Duration(seconds: 30));
    return true;
  }
}
