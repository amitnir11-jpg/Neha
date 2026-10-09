const AUDIT_ROLES = new Set(['audit_user', 'staff', 'supervisor', 'scanner', 'outward_counter']);

function canModifyScans(user) {
  const role = String(user?.role || '').trim().toLowerCase();
  return ['admin', 'super_admin'].includes(role) || AUDIT_ROLES.has(role);
}

function assertScanModificationAccess(req, scan) {
  const user = req?.user;
  const role = String(user?.role || '').trim().toLowerCase();
  const deny = (message) => { const error = new Error(message); error.status = 403; throw error; };
  if (!canModifyScans(user)) deny('Scan modification permission required.');
  if (['admin', 'super_admin'].includes(role) || !scan) return;
  const dealer = String(scan.dealerCode || '').trim().toUpperCase();
  const access = (Array.isArray(user.dealerAccess) ? user.dealerAccess : []).map(code => String(code).trim().toUpperCase());
  if (!dealer || !access.includes(dealer)) deny('Unauthorized dealer access.');
  if (req.activeDealerId && String(req.activeDealerId).trim().toUpperCase() !== dealer) deny('Scan belongs to another dealer.');
  if (req.authorizedAuditId && String(scan.auditId || '') !== String(req.authorizedAuditId)) deny('Scan belongs to another audit.');
}

function requireScanModification(req, res, next) {
  try { assertScanModificationAccess(req); return next(); }
  catch (error) { return res.status(error.status).json({ success: false, message: error.message }); }
}

module.exports = { canModifyScans, assertScanModificationAccess, requireScanModification };
