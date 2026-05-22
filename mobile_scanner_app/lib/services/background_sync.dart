import 'package:flutter/widgets.dart';
import 'package:workmanager/workmanager.dart';

import 'local_database.dart';
import 'sync_service.dart';

class BackgroundSync {
  static const taskName = 'dakshAutoSyncTask';
}

@pragma('vm:entry-point')
void callbackDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    WidgetsFlutterBinding.ensureInitialized();
    await LocalDatabase.instance.database;
    await SyncService().syncPending();
    return true;
  });
}
