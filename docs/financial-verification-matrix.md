# Financial verification matrix

**Database-backed customer-audit acceptance: 0 / 12 complete.**

The tests below prove code behavior using isolated fixtures and model stubs. They
do not certify the dealer's live figures. A requirement can move to complete
only after it is run against a restored copy of the selected dealer/audit data
and its exported Audit Pack is compared with the on-screen totals.

| # | Requirement | Automated evidence | Customer-audit status |
|---|---|---|---|
| 1 | Dealer isolation and data security | `dealer-isolation*.test.js`, active-audit selector tests | Pending database check |
| 2 | DMS DLC and MRP valuation | `audit-summary-dms-valuation`, `dms-stock-aggregation` | Pending price-snapshot comparison |
| 3 | Gross shortage and excess | Audit Summary DMS-only shortage fixture | Pending part-level gross value comparison |
| 4 | Scan quantity reconciliation | `scan-quantity-bridge`, `scan-flow-stock` | Pending transaction bridge for 19,297 / 19,271 / 18,631 |
| 5 | SKU reconciliation | DMS aggregation normalizes repeated part rows | Pending unique-part classification comparison |
| 6 | Physical bin stock | scan flow and bin-transfer tests | Pending bin-wise total comparison |
| 7 | QR and manual quantities | QR historical fixtures cover 1, 2, 4, 5, 10, 20, 50 and 100 | Pending selected-audit sample check |
| 8 | Deletion, edit and reversal | Excel upload and scan-delete integration tests | Pending audit-history review |
| 9 | Dashboard and report consistency | active-audit report scope and quantity bridge | Pending cross-screen export comparison |
| 10 | Missing price and invalid parts | pricing warnings and DMS valuation exceptions | Pending exception-list review |
| 11 | Backup and production protection | no production mutation performed | Pending restored backup / test database |
| 12 | Customer export acceptance | report export matrix and complete workbook tests | Pending real Audit Summary, Partwise, Binwise and Stock Summary comparison |

## Required evidence for each completed item

Record the dealer code, audit ID, backup timestamp, row counts, price snapshot
version, report timestamp, and the exported workbook checksum. Keep the part-
and transaction-level diagnostic files with the validation record. Do not mark
the audit pack as certified while the scan-quantity bridge or missing-price
exception list has unresolved records.
