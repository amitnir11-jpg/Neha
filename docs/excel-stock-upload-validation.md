# Manual Excel stock upload validation

The upload workflow accepts `.xlsx` rows containing Part Number, Qty, and Bin Location. Preview validates the dealer's active audit, Part Master membership, positive whole-number quantities, and bin formatting without changing stock. Verified rows create inward ledger entries; rejected and unchecked rows remain editable after a partial commit.

Corrections preserve the original Excel row identity and original values. The server owns committed flags and correction history. Committed receipts stay locked, including their original existing/final stock quantities. Editing and confirming use serializable database transactions so edits cannot overwrite concurrent commits. A correction clears verification and must be checked again before upload.

The browser allows confirmation of verified remaining rows in a partially committed batch. Completed and reversed batches disable editing and selection. Rejected counts and rejected tables have separate element IDs.

Selecting a sheet only stores the selection in the browser. Clicking **Upload Sheet** validates and saves a new batch, and refreshes history below the row workspace. History shows valid/rejected row counts and the quantity already committed, with **Open / Edit** for pending and partially committed batches. Part number, quantity, and bin location can be corrected before stock confirmation.

The panel follows the supplied visual reference: compact Select Excel / Template / History controls, four summary cards, review and stock-status badges, All / Accepted / Rejected tabs, search, and one part-details table. Rejection reasons appear below each part number, with an Edit action on the same row. Verification controls appear only for valid remaining rows. The Upload Sheet button appears after file selection, preserving explicit upload behavior.

Validation uses the same dealer-scoped Part Master and Master Catalogue lookup as regular manual entry. Part numbers and reasons wrap in the table rather than disappearing behind ellipses. Drag a column heading to reorder it; drag its right edge to resize it. Focus a resize edge and use the arrow keys for keyboard resizing. Column order and custom widths are saved in this browser and preserved when filtering or opening another batch.

Re-uploading identical sheet contents replaces an unconfirmed pending attempt with a fresh batch. The original remains in history as `SUPERSEDED`; no stock is added by either preview. A fully reversed sheet can also be uploaded again, preserving its original reversal record. Partially and fully committed sheets retain duplicate protection so their stock cannot be added twice. History access does not require an active audit.

Run `npm run test:excel-stock-upload` for local workflow coverage:

- Preview leaves stock unchanged and rejects unknown parts.
- Partial commit, correction, fresh verification, and final commit.
- Repeat confirmation and repeat reversal rejection.
- Reversal restores uploaded quantities.
- Forged committed flags and original values cannot replace server receipts.
- Added, removed, reordered, and edited committed rows are rejected.
- Dealer access isolation.
- Cumulative receipts for multiple rows in the same part/bin.
- Browser confirmation state after partial commits.
- Selecting a sheet waits for an explicit upload click and refreshes history.
- Re-uploading a wrong pending sheet preserves its prior attempt in history.
- Correcting part number, quantity, and bin location updates accepted/rejected counts.
- Duplicate prevention after stock commit and re-upload after full reversal.

These tests use simulated database/model dependencies and execute the upload route handlers and browser rendering logic. They do not establish live PostgreSQL migration, concurrent transaction, or deployed-browser acceptance. No database connection is configured in the local workspace. The full project test command and build passed before the final upload fixes; the focused upload and related stock/dealer suites passed after those fixes.
