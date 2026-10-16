# Financial reconciliation diagnosis

## Scope

All comparisons must use one dealer code and one audit ID. DMS stock is read
from `DealerStock`; physical stock is calculated from accepted inventory
movements. Audit price snapshots take precedence over the current part master.

## Confirmed code-level causes

1. Dashboard DMS valuation used a separate helper that returned one generic
   value and could select DLC or MRP depending on populated fields. The
   dashboard now calculates and exposes DLC and MRP separately.
2. Several report paths assumed one DMS row per part. A legacy duplicate row
   could replace an earlier row in a map, losing quantity and valuation. DMS
   rows are now aggregated by normalized part number before reports calculate
   quantities or values.
3. Reconciliation labelled available stock as physical stock. Available stock
   includes workshop/fitted quantities; reconciliation now uses bin movement
   quantity for physical stock and reports workshop stock separately.
4. Dashboard event facets are still presentation metrics. The report ledger is
   the financial source for audit quantities and value totals; raw scan count
   must remain a separately labelled transaction count.

## Required database-backed evidence before sign-off

Run the diagnostic against a copied test database for the selected dealer and
audit. Retain the output with these columns:

- part number, DealerStock row IDs, DMS quantity, snapshot DLC/MRP
- physical bin quantity, workshop quantity, variance, gross shortage/excess
- raw scan ID, deduplicated identity, status, movement, bin, and exclusion
  reason

The comparison must explain every part of the reported ₹2,60,080.67 valuation
gap, 666 transaction-quantity gap, and 640 physical-bin gap. The production
database and production deployment must remain unchanged until that comparison
passes.

## Validation completed on this branch

- `node --test test/dms-stock-aggregation.test.js test/audit-summary-dms-valuation.test.js test/dashboard-aggregation.test.js test/dealer-isolation-api.test.js`
- `npm run test:reports` (59 passing tests)

These are code-level checks only. They do not establish the actual customer
audit totals because no isolated database copy is configured in this workspace.
