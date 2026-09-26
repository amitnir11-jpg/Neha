const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');

const root = path.resolve(__dirname, '..');

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function section(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  assert.ok(start >= 0, `Missing source marker: ${startMarker}`);
  const end = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `Missing source marker: ${endMarker}`);
  return text.slice(start, end);
}

function sha256(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
}

function responseCapture() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
    },
    json(value) {
      this.body = value;
      return value;
    },
    send(value) {
      this.body = value;
      return value;
    }
  };
}

async function invokeRoute(router, routePath, query = {}) {
  const layer = router.stack.find((item) => item.route && item.route.path === routePath);
  assert.ok(layer, `Expected route ${routePath}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const response = responseCapture();
  await handler({
    query: { ...query },
    body: {},
    params: {},
    user: { role: 'admin', dealerAccess: ['ALL'] },
    originalUrl: routePath
  }, response);
  assert.strictEqual(response.statusCode, 200, `${routePath} should succeed`);
  return response;
}

async function invokePostRoute(router, routePath, body = {}) {
  const layer = router.stack.find((item) => item.route && item.route.path === routePath && item.route.methods.post);
  assert.ok(layer, `Expected POST route ${routePath}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const response = responseCapture();
  await handler({
    query: {},
    body: { ...body },
    params: {},
    user: { role: 'admin', username: 'admin', name: 'Admin', dealerAccess: ['ALL'] },
    originalUrl: routePath
  }, response);
  assert.strictEqual(response.statusCode, 200, `${routePath} should succeed`);
  return response;
}

function verifyStaticIsolation() {
  const schema = source('prisma/schema.prisma');
  const server = source('server.js');
  const localRoute = source('routes/localParts.js');
  const localService = source('services/LocalPartService.js');
  const reportRoute = source('routes/report.js');
  const reportsRoute = source('routes/reports.js');
  const reconciliationRoute = source('routes/reconciliation.js');
  const html = source('public/Daksh.html');
  const ui = source('public/ui.js');

  assert.match(schema, /model LocalPartEntry\s*\{/);
  assert.match(schema, /@@map\("local_part_entries"\)/);
  assert.match(schema, /quantity\s+Decimal\s+@db\.Decimal\(18, 3\)/);
  assert.match(schema, /mrp\s+Decimal\s+@db\.Decimal\(18, 2\)/);
  assert.match(schema, /dlc\s+Decimal\s+@db\.Decimal\(18, 2\)/);
  assert.match(server, /app\.use\('\/api\/local-parts', localPartsRouter\)/);

  const forbiddenProcessing = [
    'processScanRequest',
    "require('../models/Inventory')",
    "require('../models/DealerStock')",
    "require('../models/MasterPart')",
    "require('../models/PartBinLocation')",
    'inventory:update',
    'scan:created',
    'reports:update',
    'OfflineQueue',
    'mobile'
  ];
  forbiddenProcessing.forEach((token) => {
    assert.ok(!localRoute.includes(token), `Local Part route must not use ${token}`);
    assert.ok(!localService.includes(token), `Local Part service must not use ${token}`);
  });
  assert.match(localRoute, /io\.emit\('local-parts:update'/);

  assert.ok(!reportRoute.includes('LocalPartEntry') && !reportRoute.includes('localPartEntry'), 'Normal report and Part Inventory Refresh builders must not query LocalPartEntry');
  assert.ok(!reconciliationRoute.includes('LocalPartEntry') && !reconciliationRoute.includes('localPartEntry'), 'Reconciliation must not query LocalPartEntry');
  assert.ok(section(reportsRoute, 'const COMPLETE_AUDIT_PACK_REPORTS', 'const COMPLETE_AUDIT_PACK_REPORT_MAP').includes('local-parts'), 'Server Complete Audit Pack must include local-parts');
  assert.ok(section(ui, 'const AUDIT_PACK_REPORTS', 'const AUDIT_PACK_REPORT_KEYS').includes('local-parts'), 'UI Complete Audit Pack must include local-parts');
  assert.ok(section(ui, 'const AUDIT_PACK_REPORT_GROUPS', 'const AUDIT_PACK_STORAGE_KEY').includes('local-parts'), 'Audit Pack groups must include local-parts');
  assert.ok(/title:\s*'Local Reports'[\s\S]*keys:\s*\['local-parts'\]/.test(ui), 'Audit Pack picker must show Local Parts Report in a dedicated selectable Local Reports group');
  assert.match(localRoute, /invalidateLocalPartCaches/);
  assert.match(reportsRoute, /router\.get\('\/local-parts', auth\.requireAuth, localPartsRoute\.reportHandler\)/);

  const scanTabs = section(html, '<div class="subtabs">', '</div>');
  assert.ok(scanTabs.indexOf('data-subview="manualEntry"') < scanTabs.indexOf('data-subview="localPartEntry"'), 'Local Part tab must follow Manual Entry');
  assert.ok(scanTabs.indexOf('data-subview="localPartEntry"') < scanTabs.indexOf('data-subview="barcodeEntry"'), 'Local Part tab must be immediately after Manual Entry');
  assert.match(html, /<option value="local-parts">Local Parts Report<\/option>/);
  assert.match(ui, /socket\.on\('local-parts:update'/);
  assert.ok(!section(ui, "socket.on('local-parts:update'", "socket.on('mrp:updated'").includes('queueRealtimeReportRefresh'), 'Local Part realtime event must not refresh normal reports');
}

async function verifyRouteGuards() {
  const auth = require('../routes/auth');
  const router = require('../routes/localParts');
  const post = router.stack.find((layer) => layer.route && layer.route.path === '/' && layer.route.methods.post);
  const put = router.stack.find((layer) => layer.route && layer.route.path === '/:id' && layer.route.methods.put);
  const remove = router.stack.find((layer) => layer.route && layer.route.path === '/:id' && layer.route.methods.delete);
  assert.ok(post, 'POST /api/local-parts must exist');
  assert.deepStrictEqual(put.route.stack.slice(0, 2).map((item) => item.name), ['requireAuth', 'requireAdmin']);
  assert.deepStrictEqual(remove.route.stack.slice(0, 2).map((item) => item.name), ['requireAuth', 'requireAdmin']);

  const unauthenticated = responseCapture();
  let unauthenticatedNext = false;
  await auth.requireAuth({ headers: {}, query: {}, body: {}, originalUrl: '/api/local-parts' }, unauthenticated, () => {
    unauthenticatedNext = true;
  });
  assert.strictEqual(unauthenticated.statusCode, 401, 'Unauthenticated Local Part access must be rejected');
  assert.strictEqual(unauthenticatedNext, false);

  const unauthorized = responseCapture();
  let unauthorizedNext = false;
  auth.requireAdmin({ user: { role: 'staff' } }, unauthorized, () => {
    unauthorizedNext = true;
  });
  assert.strictEqual(unauthorized.statusCode, 403, 'Non-admin edit/delete must be rejected');
  assert.strictEqual(unauthorizedNext, false);
}

async function operationalSnapshot(prisma) {
  const delegates = [
    'inventory',
    'dealerStock',
    'masterPart',
    'partBinLocation',
    'scan',
    'audit',
    'auditLog',
    'duplicateScanLog',
    'failedScan',
    'offlineQueue',
    'binTransferHistory',
    'reportSnapshot'
  ];
  const pairs = await Promise.all(delegates.map(async (name) => {
    const aggregate = await prisma[name].aggregate({ _count: { _all: true }, _max: { updatedAt: true } });
    return [name, {
      count: aggregate._count._all,
      maxUpdatedAt: aggregate._max.updatedAt ? aggregate._max.updatedAt.toISOString() : null
    }];
  }));
  return Object.fromEntries(pairs);
}

async function verifyDatabaseIsolation() {
  const { prisma } = require('../services/prisma');
  const { createLocalPartService } = require('../services/LocalPartService');
  const reportRouter = require('../routes/report');
  const localPartsRouter = require('../routes/localParts');
  const testSuffix = `${Date.now()}-${process.pid}`;
  const dealerCode = `LOCAL-ISO-${testSuffix}`;
  const referenceAuditId = `LOCAL-AUDIT-${testSuffix}`;
  const partNumber = `LP-${testSuffix}`;
  const actor = { id: `test-user-${testSuffix}`, name: 'Local Isolation Test User' };
  const ids = [];
  const service = createLocalPartService({
    db: prisma,
    getActiveAudit: async () => ({ auditId: referenceAuditId })
  });
  const basePayload = {
    dealerCode,
    referenceAuditId: 'CLIENT-SUPPLIED-AUDIT-MUST-BE-IGNORED',
    partNumber: `  ${partNumber.toLowerCase()}  `,
    partDescription: 'Locally sourced test part',
    quantity: '1.2346',
    mrp: '10.50',
    dlc: '8.25',
    remarks: 'Isolation regression test',
    enteredByUserId: 'spoofed-user',
    enteredByName: 'Spoofed Browser User'
  };

  const beforeMain = await operationalSnapshot(prisma);
  const beforeLocalCount = await prisma.localPartEntry.count();
  const refreshQuery = { dealerCode, auditId: referenceAuditId };
  const beforeRefreshPreview = await invokeRoute(reportRouter, '/parts-inventory-refresh-template', refreshQuery);
  const beforeRefreshCsv = await invokeRoute(reportRouter, '/parts-inventory-refresh-template.csv', refreshQuery);
  const beforeRefreshExcel = await invokeRoute(reportRouter, '/parts-inventory-refresh-template', { ...refreshQuery, format: 'excel' });
  const beforeMainReport = await reportRouter.buildReportData({ ...refreshQuery, reportType: 'scan-register', _scanLimit: 100 });

  try {
    await assert.rejects(() => service.create({ ...basePayload, quantity: '0' }, actor), /greater than zero/);
    await assert.rejects(() => service.create({ ...basePayload, quantity: '-1' }, actor), /greater than zero/);
    await assert.rejects(() => service.create({ ...basePayload, mrp: '-0.01' }, actor), /zero or greater/);
    await assert.rejects(() => service.create({ ...basePayload, dlc: '-0.01' }, actor), /zero or greater/);
    for (const field of ['dealerCode', 'partNumber', 'partDescription', 'quantity', 'mrp', 'dlc']) {
      await assert.rejects(() => service.create({ ...basePayload, [field]: '' }, actor), /required/);
    }

    const first = await service.create(basePayload, actor);
    ids.push(first.id);
    const second = await service.create({ ...basePayload, quantity: '2.000', remarks: 'Repeated part number, separate transaction' }, actor);
    ids.push(second.id);

    assert.notStrictEqual(first.id, second.id, 'Repeated part numbers must create separate transactions');
    assert.strictEqual(first.partNumber, partNumber.toUpperCase());
    assert.strictEqual(first.referenceAuditId, referenceAuditId, 'Reference Audit ID must come from the server lookup');
    assert.strictEqual(first.enteredByUserId, actor.id, 'Entered-by ID must come from authenticated actor');
    assert.strictEqual(first.enteredByName, actor.name, 'Entered-by name must come from authenticated actor');
    assert.strictEqual(first.quantity, 1.235, 'Quantity must retain three-decimal precision');
    assert.strictEqual(first.totalMrpValue, 12.97, 'Quantity x MRP must be calculated correctly');
    assert.strictEqual(first.totalDlcValue, 10.19, 'Quantity x DLC must be calculated correctly');
    assert.strictEqual(await prisma.localPartEntry.count(), beforeLocalCount + 2, 'Each save must create exactly one LocalPartEntry');

    const freshService = createLocalPartService({ db: prisma, getActiveAudit: async () => null });
    const persisted = await freshService.getById(second.id);
    assert.strictEqual(persisted.partNumber, partNumber.toUpperCase(), 'A new service instance must read the persisted Local Part');

    const indiaDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
    const filterChecks = [
      { dealerCode },
      { referenceAuditId },
      { fromDate: indiaDate, toDate: indiaDate, partNumber },
      { partNumber: partNumber.slice(3) },
      { userName: 'isolation test' },
      { status: 'ACTIVE', partNumber }
    ];
    for (const filter of filterChecks) {
      const result = await service.list({ ...filter, limit: 25 });
      assert.strictEqual(result.totalRows, 2, `Filter must match both Local Part rows: ${JSON.stringify(filter)}`);
    }
    const paged = await service.list({ dealerCode, page: 2, limit: 1, sortBy: 'createdAt', sortDir: 'asc' });
    assert.strictEqual(paged.entries.length, 1);
    assert.strictEqual(paged.pagination.totalPages, 2, 'Local Part pagination must be server-side');
    const noDealerAccess = await service.list({ status: 'ALL' }, { allowedDealerCodes: [] });
    assert.strictEqual(noDealerAccess.totalRows, 0, 'A user with no assigned dealer must see no Local Parts');

    const updated = await service.update(second.id, { ...basePayload, partDescription: 'Admin corrected description', quantity: '2.500' }, { id: 'admin-2', name: 'Admin Two' });
    assert.strictEqual(updated.lastUpdatedByUserId, 'admin-2');
    assert.strictEqual(updated.partDescription, 'Admin corrected description');

    const deleted = await service.softDelete(first.id, { id: 'admin-3', name: 'Admin Three' });
    assert.strictEqual(deleted.status, 'DELETED');
    assert.ok(deleted.deletedAt);
    assert.strictEqual(deleted.deletedByUserId, 'admin-3');
    await assert.rejects(() => service.update(first.id, basePayload, actor), /cannot be edited/);
    const defaultRows = await service.list({ dealerCode });
    const deletedRows = await service.list({ dealerCode, status: 'DELETED' });
    const allRows = await service.list({ dealerCode, status: 'ALL' });
    assert.strictEqual(defaultRows.totalRows, 1, 'Soft-deleted rows must be excluded by default');
    assert.strictEqual(deletedRows.totalRows, 1, 'Soft-deleted rows must remain traceable through status filter');
    assert.strictEqual(allRows.totalRows, 2);

    const localReport = responseCapture();
    await localPartsRouter.reportHandler({
      query: { dealerCode, status: 'ALL', page: '1', limit: '50' },
      user: { role: 'admin', dealerAccess: ['ALL'] },
      originalUrl: '/api/reports/local-parts'
    }, localReport);
    assert.strictEqual(localReport.statusCode, 200);
    assert.strictEqual(localReport.body.type, 'local-parts');
    assert.strictEqual(localReport.body.totalRows, 2, 'Local Parts Report must contain saved rows');
    assert.strictEqual(localReport.body.columns.length, 17, 'Local Parts Report must expose all required columns');

    const excelReport = responseCapture();
    await localPartsRouter.reportHandler({
      query: { dealerCode, status: 'ALL', format: 'excel' },
      user: { role: 'admin', dealerAccess: ['ALL'] },
      originalUrl: '/api/reports/local-parts'
    }, excelReport);
    assert.strictEqual(Buffer.from(excelReport.body).subarray(0, 2).toString('ascii'), 'PK', 'Local Parts Excel export must be a valid XLSX package');
    const pdfReport = responseCapture();
    await localPartsRouter.reportHandler({
      query: { dealerCode, status: 'ALL', format: 'pdf' },
      user: { role: 'admin', dealerAccess: ['ALL'] },
      originalUrl: '/api/reports/local-parts'
    }, pdfReport);
    assert.strictEqual(Buffer.from(pdfReport.body).subarray(0, 4).toString('ascii'), '%PDF', 'Local Parts PDF export must be valid');

    const unreferencedPartNumber = `LP-NO-AUDIT-${testSuffix}`;
    const unreferenced = await freshService.create({
      ...basePayload,
      partNumber: unreferencedPartNumber,
      quantity: '1.000',
      remarks: 'No reference audit id, still belongs to dealer local part report'
    }, actor);
    ids.push(unreferenced.id);
    assert.strictEqual(unreferenced.referenceAuditId, '', 'Local Part entries can exist without a reference audit id');

    const reportsRouter = require('../routes/reports');
    const auditPack = await invokePostRoute(reportsRouter, '/download-complete-audit-pack', {
      dealerCode,
      auditId: referenceAuditId,
      reports: ['local-parts']
    });
    const auditPackBuffer = Buffer.from(auditPack.body);
    assert.strictEqual(auditPackBuffer.subarray(0, 2).toString('ascii'), 'PK', 'Complete Audit Pack must be a valid XLSX package');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(auditPackBuffer);
    const localPartsSheet = workbook.worksheets.find((sheet) => /LOCAL PARTS REPORT/i.test(sheet.name));
    assert.ok(localPartsSheet, 'Complete Audit Pack must include a Local Parts Report sheet');
    const sheetText = [];
    localPartsSheet.eachRow((row) => {
      row.eachCell((cell) => sheetText.push(String(cell.value && cell.value.text ? cell.value.text : cell.value || '')));
    });
    assert.ok(sheetText.includes(partNumber.toUpperCase()), 'Local Parts Report sheet must include saved local part rows');
    assert.ok(sheetText.includes(unreferencedPartNumber.toUpperCase()), 'Complete Audit Pack Local Parts Report must include dealer rows even when Reference Audit ID is blank');

    const afterMain = await operationalSnapshot(prisma);
    assert.deepStrictEqual(afterMain, beforeMain, 'Saving/editing/deleting Local Parts must not change any main operational table');
    const afterMainReport = await reportRouter.buildReportData({ ...refreshQuery, reportType: 'scan-register', _scanLimit: 100 });
    assert.deepStrictEqual(afterMainReport, beforeMainReport, 'Main scan report data must remain unchanged');
    const afterRefreshPreview = await invokeRoute(reportRouter, '/parts-inventory-refresh-template', refreshQuery);
    const afterRefreshCsv = await invokeRoute(reportRouter, '/parts-inventory-refresh-template.csv', refreshQuery);
    const afterRefreshExcel = await invokeRoute(reportRouter, '/parts-inventory-refresh-template', { ...refreshQuery, format: 'excel' });
    assert.deepStrictEqual(afterRefreshPreview.body, beforeRefreshPreview.body, 'Part Inventory Refresh preview must remain unchanged');
    assert.strictEqual(sha256(afterRefreshCsv.body), sha256(beforeRefreshCsv.body), 'Part Inventory Refresh CSV must remain unchanged');
    assert.strictEqual(sha256(afterRefreshExcel.body), sha256(beforeRefreshExcel.body), 'Part Inventory Refresh Excel must remain unchanged');
  } finally {
    if (ids.length) await prisma.localPartEntry.deleteMany({ where: { id: { in: ids } } });
    assert.strictEqual(await prisma.localPartEntry.count(), beforeLocalCount, 'Local Part regression test artifacts must be removed');
    await prisma.$disconnect();
  }
}

async function main() {
  verifyStaticIsolation();
  await verifyRouteGuards();
  await verifyDatabaseIsolation();
  console.log('local-parts-isolation-check: 32 isolation, validation, permission, persistence, report, audit pack, and refresh assertions passed');
}

main().catch((error) => {
  console.error('local-parts-isolation-check failed:', error);
  process.exitCode = 1;
});
