const duplicatePolicy = require('./scanDuplicatePolicy');

function clean(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function numberValue(value, fallback = 0) {
  const parsed = Number(String(value === undefined || value === null || value === '' ? fallback : value).replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function movementTypeValue(input = {}) {
  const type = upper(input.movementType || input.scanType || input.type || 'INWARD');
  return type === 'VERIFY' ? 'VERIFICATION' : type;
}

function upiCodeValue(input = {}) {
  const explicit = upper(input.upiCode || input.upiNo || input.upiId || input.upi || '');
  if (explicit) return explicit;
  const canonical = duplicatePolicy.canonicalUpiValue(input);
  return canonical ? upper(canonical) : '';
}

function activeInventoryValue(input = {}) {
  if (input.activeInventory === true) return true;
  if (input.activeInventory === false) return false;
  const explicit = clean(input.activeInventory).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(explicit)) return true;
  if (['false', '0', 'no', 'off'].includes(explicit)) return false;
  const movementType = movementTypeValue(input);
  if (movementType !== 'INWARD') return false;
  return numberValue(input.remainingQty !== undefined ? input.remainingQty : input.qty !== undefined ? input.qty : input.quantity, 0) > 0;
}

function remainingQtyValue(input = {}) {
  const value = input.remainingQty !== undefined ? input.remainingQty : input.qty !== undefined ? input.qty : input.quantity;
  const qty = Math.abs(numberValue(value, 0));
  const movementType = movementTypeValue(input);
  if (movementType !== 'INWARD') return 0;
  return qty;
}

function identityScopeFilter(input = {}) {
  const filter = {};
  const dealerCode = upper(input.dealerCode);
  const auditId = clean(input.auditId);
  const upiCode = upiCodeValue(input);
  const binLocation = upper(input.binLocation || input.bin || input.location || '');
  if (dealerCode) filter.dealerCode = dealerCode;
  if (auditId) filter.auditId = auditId;
  if (upiCode) {
    filter.$or = [
      { upiCode },
      { upiNo: upiCode },
      { upiId: upiCode }
    ];
  }
  if (binLocation) {
    filter.$and = (filter.$and || []).concat([{
      $or: [
        { binLocation },
        { bin: binLocation }
      ]
    }]);
  }
  return filter;
}

function movementQty(row = {}) {
  const qty = Math.abs(numberValue(row.qty !== undefined ? row.qty : row.quantity, 0));
  const movementType = movementTypeValue(row);
  if (movementType === 'INWARD') return qty;
  if (['OUTWARD', 'FITTED', 'DAMAGE'].includes(movementType)) return -qty;
  return 0;
}

async function recomputeUpiInventoryState(Inventory, input = {}) {
  const upiCode = upiCodeValue(input);
  if (!Inventory || !upiCode) return null;
  const scope = identityScopeFilter(input);
  const legacyTerms = [{ upiCode }, { upiNo: upiCode }, { upiId: upiCode }];
  const filter = {
    ...scope,
    $or: scope.$or ? scope.$or.concat(legacyTerms) : legacyTerms
  };
  const rows = await Inventory.find(filter).sort({ timestamp: 1, createdAt: 1 }).lean();
  if (!rows.length) return { upiCode, availableQty: 0, activeInventory: false, rows: 0 };

  const inwardRows = [];
  let availableQty = 0;
  rows.forEach((row) => {
    availableQty += movementQty(row);
    if (movementTypeValue(row) === 'INWARD') inwardRows.push(row);
  });
  availableQty = Math.max(0, availableQty);

  const primaryInward = inwardRows.length ? inwardRows[inwardRows.length - 1] : null;
  const updates = [];
  rows.forEach((row) => {
    const movementType = movementTypeValue(row);
    const shouldBeActive = Boolean(primaryInward && String(row._id) === String(primaryInward._id) && availableQty > 0 && movementType === 'INWARD');
    const nextRemaining = movementType === 'INWARD' && shouldBeActive ? availableQty : 0;
    if (Boolean(row.activeInventory) === shouldBeActive && Number(row.remainingQty || 0) === nextRemaining) return;
    updates.push({ id: row._id, set: { activeInventory: shouldBeActive, remainingQty: nextRemaining, movementType: movementTypeValue(row), upiCode } });
  });

  for (const update of updates) {
    // Keep the UPI state consistent across historical rows.
    // Only rows in the same dealer/audit/UPI scope are touched.
    await Inventory.updateOne({ _id: update.id }, { $set: update.set });
  }

  return {
    upiCode,
    availableQty,
    activeInventory: Boolean(primaryInward && availableQty > 0),
    activeRowId: primaryInward ? String(primaryInward._id) : '',
    rows: rows.length
  };
}

module.exports = {
  activeInventoryValue,
  identityScopeFilter,
  movementQty,
  movementTypeValue,
  recomputeUpiInventoryState,
  remainingQtyValue,
  upiCodeValue
};
