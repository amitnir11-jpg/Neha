const parser = require('../utils/scanParser');

async function validateScannerSequenceForStock(rawValue, format, dealerCode, auditId) {
  const validation = parser.validateScannerSequence(rawValue, format);
  if (validation.valid || !validation.requiresIdentityLookup || !dealerCode) return validation;
  // A previously validated standalone UPI is supported through its saved
  // identity, never by guessing a part from the token or accepting its length.
  const token = validation.parsed.normalizedValue;
  const policy = require('../utils/scanDuplicatePolicy');
  const audit = auditId ? null : await require('../utils/audit').getActiveAudit({ dealerCode });
  const scopeAudit = auditId || audit?.auditId || audit?._id;
  if (!scopeAudit) return validation;
  const filter = policy.activeUpiDuplicateFilter({ dealerCode, auditId: String(scopeAudit),
    upiId: token, upiNo: token, upiCode: token, barcodeIdentityKind: 'UNIQUE_UPI' });
  const candidates = filter ? await require('../models/Inventory').find(filter).lean() : [];
  const existing = candidates.find(row => policy.uniqueUpiIdentityToken(row) === token);
  return existing ? { ...validation, valid: true, reason: '', existingIdentity: existing } : validation;
}

module.exports = { validateScannerSequenceForStock };
