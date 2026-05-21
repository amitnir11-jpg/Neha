# Daksh Mobile Sync Implementation

The Android app source is not present in this workspace. Apply the following Room, Retrofit, repository, and UI changes in the mobile project to stop null crashes, skip corrupted rows, handle duplicate server records, and prevent double sync clicks.

## InventoryItem.kt

```kotlin
@Entity(
    tableName = "inventory_items",
    indices = [
        Index(value = ["scanId"], unique = true),
        Index(value = ["synced"]),
        Index(value = ["timestamp"])
    ]
)
data class InventoryItem(
    @PrimaryKey
    val scanId: String = UUID.randomUUID().toString(),
    val partNumber: String = "",
    val partName: String = "",
    val partDescription: String = "",
    val quantity: Int = 1,
    val scanType: String = "INWARD",
    val dealerCode: String = "",
    val dealerName: String = "",
    val auditId: String = "",
    val upiId: String = "",
    val rawScan: String = "",
    val rawScanString: String = rawScan,
    val binLocation: String = "",
    val deviceId: String = "",
    val staffName: String = "",
    val timestamp: Long = System.currentTimeMillis(),
    val synced: Boolean = false,
    val syncAttempts: Int = 0,
    val lastSyncError: String = ""
) {
    fun isValidForSync(): Boolean = scanId.isNotBlank() && partNumber.isNotBlank()
}
```

## InventoryDao.kt

```kotlin
@Dao
interface InventoryDao {
    @Query("SELECT * FROM inventory_items WHERE synced = 0 AND scanId != '' AND partNumber != '' ORDER BY timestamp ASC")
    suspend fun getUnsyncedValidItems(): List<InventoryItem>

    @Query("DELETE FROM inventory_items WHERE scanId IS NULL OR scanId = '' OR partNumber IS NULL OR partNumber = ''")
    suspend fun deleteInvalidRows(): Int

    @Query("UPDATE inventory_items SET synced = 1, lastSyncError = '' WHERE scanId IN (:scanIds)")
    suspend fun markSynced(scanIds: List<String>)

    @Query("UPDATE inventory_items SET syncAttempts = syncAttempts + 1, lastSyncError = :error WHERE scanId IN (:scanIds)")
    suspend fun markFailed(scanIds: List<String>, error: String)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(item: InventoryItem)
}
```

## Scanner Insert Rule

```kotlin
suspend fun saveScan(raw: ParsedScan, deviceId: String) {
    dao.insert(
        InventoryItem(
            scanId = UUID.randomUUID().toString(),
            partNumber = raw.partNumber.orEmpty().trim().uppercase(),
            partName = raw.partName.orEmpty(),
            quantity = raw.quantity ?: 1,
            scanType = raw.scanType.orEmpty().ifBlank { "INWARD" },
            rawScan = raw.rawText.orEmpty(),
            rawScanString = raw.rawText.orEmpty(),
            deviceId = deviceId,
            timestamp = System.currentTimeMillis(),
            synced = false
        )
    )
}
```

## Retrofit API

```kotlin
data class SyncRequest(
    val deviceId: String,
    val records: List<InventoryItem>
)

data class SyncResponse(
    val success: Boolean = false,
    val message: String = "",
    val synced: Int = 0,
    val duplicateCount: Int = 0,
    val invalidCleanedCount: Int = 0,
    val failed: Int = 0,
    val failedRows: List<FailedRow> = emptyList()
)

data class FailedRow(
    val scanId: String = "",
    val reason: String = "",
    val status: String = ""
)

interface DakshApi {
    @POST("api/mobile/sync")
    suspend fun sync(@Body request: SyncRequest): Response<SyncResponse>
}
```

## SyncRepository.kt

```kotlin
class SyncRepository(
    private val dao: InventoryDao,
    private val api: DakshApi,
    private val deviceId: String
) {
    private val mutex = Mutex()

    suspend fun syncNow(): SyncUiState = mutex.withLock {
        val cleaned = dao.deleteInvalidRows()
        val queue = dao.getUnsyncedValidItems()
        if (queue.isEmpty()) {
            return SyncUiState.Idle("Invalid records cleaned".takeIf { cleaned > 0 } ?: "Sync completed")
        }

        repeat(3) { attempt ->
            try {
                val response = api.sync(SyncRequest(deviceId, queue))
                val body = response.body()

                if (response.code() == 409) {
                    dao.markSynced(queue.map { it.scanId })
                    return SyncUiState.Idle("Duplicate scans skipped")
                }

                if (response.isSuccessful && body != null) {
                    val duplicateIds = body.failedRows
                        .filter { it.reason.contains("Duplicate", ignoreCase = true) }
                        .map { it.scanId }
                    val failedIds = body.failedRows
                        .filterNot { it.status == "invalid" || it.reason.contains("Duplicate", ignoreCase = true) }
                        .map { it.scanId }
                    val syncedIds = queue.map { it.scanId } - failedIds.toSet()
                    if (syncedIds.isNotEmpty()) dao.markSynced(syncedIds)
                    if (failedIds.isNotEmpty()) dao.markFailed(failedIds, "Sync failed")

                    val message = when {
                        body.duplicateCount > 0 -> "Duplicate scans skipped"
                        cleaned > 0 || body.invalidCleanedCount > 0 -> "Invalid records cleaned"
                        else -> "Sync completed"
                    }
                    return SyncUiState.Idle(message)
                }

                if (attempt == 2) dao.markFailed(queue.map { it.scanId }, response.message())
            } catch (e: IOException) {
                if (attempt == 2) dao.markFailed(queue.map { it.scanId }, e.message ?: "Network error")
                delay(500L * (attempt + 1))
            } catch (e: Exception) {
                dao.markFailed(queue.map { it.scanId }, e.message ?: "Sync error")
                return SyncUiState.Idle("Sync failed. Please try again.")
            }
        }

        SyncUiState.Idle("Sync failed. Please try again.")
    }
}
```

## SyncViewModel.kt

```kotlin
sealed class SyncUiState {
    data object Syncing : SyncUiState()
    data class Idle(val message: String = "") : SyncUiState()
}

class SyncViewModel(private val repository: SyncRepository) : ViewModel() {
    private val _state = MutableStateFlow<SyncUiState>(SyncUiState.Idle())
    val state: StateFlow<SyncUiState> = _state.asStateFlow()

    fun sync() {
        if (_state.value is SyncUiState.Syncing) return
        viewModelScope.launch {
            _state.value = SyncUiState.Syncing
            _state.value = repository.syncNow()
        }
    }
}
```

## Compose Button

```kotlin
val state by viewModel.state.collectAsStateWithLifecycle()
val syncing = state is SyncUiState.Syncing

Button(
    enabled = !syncing,
    onClick = { viewModel.sync() }
) {
    if (syncing) {
        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
    } else {
        Text("SYNC")
    }
}

LaunchedEffect(state) {
    val message = (state as? SyncUiState.Idle)?.message.orEmpty()
    if (message.isNotBlank()) snackbarHostState.showSnackbar(message)
}
```

## Room Migration

```kotlin
val MIGRATION_FIX_SCAN_ID = object : Migration(OLD_VERSION, NEW_VERSION) {
    override fun migrate(db: SupportSQLiteDatabase) {
        db.execSQL("DELETE FROM inventory_items WHERE scanId IS NULL OR scanId = '' OR partNumber IS NULL OR partNumber = ''")
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_inventory_items_scanId ON inventory_items(scanId)")
    }
}
```
