# Manual Excel stock upload validation

The upload workflow accepts `.xlsx` rows containing Part Number, Qty, and Bin Location. Preview validates the dealer's active audit, Part Master membership, positive whole-number quantities, and bin formatting without changing stock. Verified rows create inward ledger entries; rejected and unchecked rows remain editable after a partial commit.

Corrections preserve the original Excel row identity and original values. The server owns committed flags and correction history. Committed receipts stay locked, including their original existing/final stock quantities. Editing and confirming use serializable database transactions so edits cannot overwrite concurrent commits. A correction clears verification and must be checked again before upload.

The browser allows confirmation of verified remaining rows in a partially committed batch. Completed and reversed batches disable editing and selection. Rejected counts and rejected tables have separate element IDs.

Selecting a sheet only stores the selection in the browser. Clicking **Upload Sheet** validates and saves a new batch, and refreshes history below the row workspace. History shows valid/rejected row counts and the quantity already committed, with **Open / Edit** for pending and partially committed batches. Part number, quantity, and bin location can be corrected before stock confirmation.

The panel follows the supplied visual reference: compact Select Excel / Template / History controls, four summary cards, review and stock-status badges, All / Accepted / Rejected tabs, search, and one part-details table. Rejection reasons appear below each part number, with an Edit action on the same row. Verification controls appear only for valid remaining rows. The Upload Sheet button appears after file selection, preserving explicit upload behavior.

Validation uses the same dealer-scoped Part Master and Master Catalogue lookup as regular manual entry. Part numbers and reasons wrap in the table rather than disappearing behind ellipses. Drag a column heading to reorder it; drag its right edge to resize it. Focus a resize edge and use the arrow keys for keyboard resizing. Column order and custom widths are saved in this browser and preserved when filtering or opening another batch.

Every active row has an Edit icon and a Delete icon. Edits apply to uncommitted rows. Deletion keeps a tombstone receipt, excludes the row from confirmation and visible totals, and refreshes history. Uploaded-row deletion uses the existing audited scan soft-deletion service in the same transaction as the receipt update; existing permissions and dependent-stock protections apply. Fully deleted batches can be uploaded afresh. Batch reversal excludes stock rows already deleted individually.

Upload History is confined to the Excel module's right-hand panel. It includes compact summary cards, search by filename/batch/date, date/batch/filename sorting, pagination, and full-name tooltips on truncated filenames. Select All selects all matching files; the table-header checkbox selects the current page. Selection persists across pages and clears on a new search or dealer. Open and Edit operate on one selected file; pending/partial uploads support Edit, while administrator Reverse requires fully committed uploads. Reverse and Delete support multiple selected files with a single confirmation and individual success/failure reporting. Failed files remain selected.

Deleting a whole upload retains its batch receipt and an audit event while hiding it from history. Committed stock is removed through the existing scan deletion service in the same transaction; dependent activity or audit failure prevents the deletion. Removing an already reversed upload only archives its history receipt and does not remove stock twice. The history endpoint sends compact batch summaries rather than full row data; Open/Edit fetch the detailed receipt.

Browser validation covers 1920px and 1440px desktop layouts, narrow mobile cards, complete action visibility, select-all/page selection, pagination, sorting/search, Open/Edit, confirmation cancellation, multi-file reverse, and mixed-success bulk deletion. The left Scan panel's bounds remain unchanged during history interactions.

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
- Partial confirmation and subsequent corrections keep saved accepted/rejected counts consistent with history; uploaded quantity counts only committed stock.
- Duplicate prevention after stock commit and re-upload after full reversal.

The upload suite also runs as part of `npm test`. These tests use simulated database/model dependencies and execute the upload route handlers and browser rendering logic. They do not establish live PostgreSQL migration, concurrent transaction, or deployed-browser acceptance. No database connection is configured in the local workspace.

Local verification on October 13, 2026: all 17 upload tests, the full project test command, and the build passed. The existing Playwright checks passed for upload history interactions and desktop/mobile row layouts, including correction suggestions, column resizing/reordering, and saved column preferences. Database-dependent tests were skipped where no database connection was configured; deployment and live migration verification remain unverified.
