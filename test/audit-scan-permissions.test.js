const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { canModifyScans, assertScanModificationAccess } = require('../utils/scanModificationAccess');
const Inventory = require('../models/Inventory');
const ScanAuditLog = require('../models/ScanAuditLog');
const { prisma } = require('../services/prisma');
const { updateScan, softDeleteScans } = require('../services/ScanModificationService');

const scan = { _id: 'scan1', dealerCode: '10297', auditId: 'AUD1', partNumber: '20K211S', binLocation: '1', qty: 1, quantity: 1 };
const req = { user: { role: 'audit_user', username: 'darshil', dealerAccess: ['10297'] }, activeDealerId: '10297', authorizedAuditId: 'AUD1', body: { reason: 'Wrong quantity' } };

test('audit scan modifications are restricted by role, dealer and audit', () => {
  assert.equal(canModifyScans(req.user), true);
  assert.doesNotThrow(() => assertScanModificationAccess(req, scan));
  for (const blocked of [
    { ...req, user: { ...req.user, role: 'mobile_user' } },
    { ...req, user: { ...req.user, role: 'unknown' } },
    { ...req, user: { ...req.user, dealerAccess: ['OTHER'] } },
    { ...req, activeDealerId: 'OTHER' },
    { ...req, authorizedAuditId: 'OTHER' }
  ]) assert.throws(() => assertScanModificationAccess(blocked, scan), error => error.status === 403);
  for (const role of ['admin', 'super_admin']) assert.doesNotThrow(() => assertScanModificationAccess({ user: { role } }, scan));
});

test('confirmed quantity addition and bin/part edits persist with the audit user in the change log', async () => {
  const original = { update: Inventory.findOneAndUpdate, audit: ScanAuditLog.create, transaction: prisma.$transaction };
  const audits = [];
  let current = { ...scan };
  try {
    prisma.$transaction = async work => work({});
    Inventory.findOneAndUpdate = (filter, update) => ({ async lean() {
      assert.equal(filter._id, scan._id);
      current = { ...current, ...update.$set };
      for (const [key, value] of Object.entries(update.$inc || {})) current[key] = (current[key] || 0) + value;
      return { ...current };
    } });
    ScanAuditLog.create = async row => { audits.push(row); return row; };
    const added = await updateScan(current, { $inc: { qty: 2, quantity: 2 } }, req);
    assert.equal(added.qty, 3);
    const corrected = await updateScan(current, { $set: { binLocation: '2', partNumber: 'OTHERPART', qty: 4, quantity: 4 } }, req);
    assert.equal(corrected.binLocation, '2');
    assert.equal(corrected.qty, 4);
    assert.equal(corrected.partNumber, 'OTHERPART');
    assert.equal(audits.length, 2);
    assert.equal(audits[0].performedByRole, 'audit_user');
    assert.equal(audits[0].performedByUsername, 'darshil');
    assert.equal(audits[0].oldData.qty, 1);
    assert.equal(audits[0].newData.qty, 3);
    await assert.rejects(updateScan({ ...scan, dealerCode: 'OTHER' }, { $set: { qty: 99 } }, req), error => error.status === 403);
    assert.equal(current.qty, 4);
  } finally {
    Inventory.findOneAndUpdate = original.update;
    ScanAuditLog.create = original.audit;
    prisma.$transaction = original.transaction;
  }
});

test('mixed-dealer deletion is rejected before any row is changed', async () => {
  const original = { find: Inventory.find, transaction: prisma.$transaction };
  try {
    prisma.$transaction = async work => work({});
    Inventory.find = () => ({ async lean() { return [scan, { ...scan, _id: 'other', dealerCode: 'OTHER' }]; } });
    await assert.rejects(softDeleteScans({}, req), error => error.status === 403);
  } finally { Inventory.find = original.find; prisma.$transaction = original.transaction; }
});

test('manual repeat-entry confirmation adds available quantity once, including retry protection', async () => {
  const source = fs.readFileSync(require.resolve('../routes/inventory.js'), 'utf8');
  let current = { ...scan, remainingQty: 1 };
  let updates = 0;
  function expression(value) {
    if (typeof value === 'string' && value.startsWith('$')) return current[value.slice(1)];
    if (value?.$add) return value.$add.map(expression).reduce((a, b) => a + b, 0);
    if (value?.$ifNull) return expression(value.$ifNull[0]) ?? expression(value.$ifNull[1]);
    if (value?.$convert) return Number(expression(value.$convert.input)) || 0;
    if (value?.$multiply) return value.$multiply.map(expression).reduce((a, b) => a * b, 1);
    return value;
  }
  const context = {
    numberValue: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    firstValue: (input, keys) => keys.map(key => input[key]).find(value => value !== undefined),
    clean: value => String(value || '').trim(), normalizePartNumber: value => value,
    getPriceFromPartMaster: async () => null, masterPriceMissing: () => true,
    Inventory: { findById: () => ({ lean: async () => ({ ...current }) }) },
    scanModification: { updateScan: async (before, pipeline, request) => {
      assertScanModificationAccess(request, before);
      updates++;
      const fields = Object.fromEntries(Object.entries(pipeline[0].$set).map(([key, value]) => [key, expression(value)]));
      current = { ...current, ...fields };
      return current;
    } },
    AuditLog: { create: async () => ({}) }, publicScan: row => row,
    recordPartBinLocationFromScan: async () => {}, invalidateInventoryCaches: () => {}, scanDashboardScope: () => ({})
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function addManualQuantity('), source.indexOf('async function updateFittedScanQuantity(')), context);
  const request = { ...req, headers: {} };
  const input = { qty: 2, manualAddRequestId: 'ADD1', reason: 'Manual quantity addition' };
  const first = await context.addManualQuantity(current, input, request);
  assert.equal(first.updated.qty, 3);
  assert.equal(first.updated.remainingQty, 3);
  const retry = await context.addManualQuantity(current, input, request);
  assert.equal(retry.alreadyApplied, true);
  assert.equal(retry.updated.qty, 3);
  assert.equal(updates, 1);
});

test('history edit and delete actions are available to audit users, with admin outward actions unchanged', () => {
  const source = fs.readFileSync(require.resolve('../public/ui.js'), 'utf8');
  const start = source.indexOf('  function canEditScanDetails(');
  const end = source.indexOf('  function scanHistoryRecord(', start);
  const context = { state: { user: req.user }, normalizeUiRole: role => role, isAdminUser: () => false };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  assert.equal(context.canEditScanDetails(scan), true);
  assert.equal(context.canEditScanDetails({ isDeleted: true }), false);
  context.state.user = { role: 'mobile_user' };
  assert.equal(context.canEditScanDetails(scan), false);
  assert.match(source, /const deleteOption = canEditDetails/);
  assert.match(source, /const outwardOption = isAdminUser\(\)/);
});

test('quantity corrections preserve deductions and reject totals below stock already used', () => {
  const source = fs.readFileSync(require.resolve('../routes/inventory.js'), 'utf8');
  const context = { normalizeScanType: value => value, numberValue: Number, remainingQtyValue: row => row.remainingQty ?? row.qty };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function editedScanRemainingQty('), source.indexOf('async function addManualQuantity(')), context);
  const inward = { scanType: 'INWARD', qty: 5, remainingQty: 3 };
  assert.equal(context.editedScanRemainingQty(inward, 7, 'INWARD'), 5);
  assert.equal(context.editedScanRemainingQty(inward, 2, 'INWARD'), 0);
  assert.throws(() => context.editedScanRemainingQty(inward, 1, 'INWARD'), error => error.status === 409);
  assert.equal(context.editedScanRemainingQty(inward, 7, 'OUTWARD'), 0);
});
