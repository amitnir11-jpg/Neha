const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const routeSource = fs.readFileSync(path.join(root, 'routes', 'reconciliation.js'), 'utf8');
const inventoryRouteSource = fs.readFileSync(path.join(root, 'routes', 'inventory.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'public', 'Daksh.html'), 'utf8');
const uiSource = fs.readFileSync(path.join(root, 'public', 'ui.js'), 'utf8');
const templateAssetPath = path.join(root, 'assets', 'templates', 'Daksh_Dealer_Stock_Upload_Template.xlsx');
const expectedTemplateSha256 = '70D99806FF292136CCD95F227204F3ECEDCE41C65D9A0447D989DBE5FC471C22';

const expectedColumns = [
  'Dealer Code',
  'Part Number',
  'Part Description',
  'Dms Stock',
  'Bin Loc 1',
  'Bin Loc 2',
  'Bin Loc 3'
];

assert.ok(fs.existsSync(templateAssetPath), 'Uploaded dealer-stock workbook must be stored as a project asset');
const templateBytes = fs.readFileSync(templateAssetPath);
const templateSha256 = crypto.createHash('sha256').update(templateBytes).digest('hex').toUpperCase();
assert.strictEqual(templateSha256, expectedTemplateSha256, 'Project template asset must exactly match the uploaded workbook');
assert.strictEqual(templateBytes.subarray(0, 2).toString('ascii'), 'PK', 'Dealer-stock template must be an Excel Open XML package');
assert.ok(routeSource.includes('const DEALER_STOCK_TEMPLATE_PATH = path.join('), 'Download route must resolve the static workbook asset');
assert.ok(routeSource.includes("'Daksh_Dealer_Stock_Upload_Template.xlsx'"), 'Download route must reference the uploaded workbook filename');
assert.ok(routeSource.includes('fs.promises.readFile(DEALER_STOCK_TEMPLATE_PATH)'), 'Download route must serve the uploaded workbook bytes');
assert.ok(!routeSource.includes('DEALER_STOCK_TEMPLATE_COLUMNS'), 'Download route must not regenerate a different template');

const previewTable = htmlSource.match(/<table id="dealerStockPreviewTable">([\s\S]*?)<\/table>/)?.[1] || '';
const previewColumns = Array.from(previewTable.matchAll(/<th>([^<]+)<\/th>/g), (match) => match[1].trim());
assert.deepStrictEqual(previewColumns, expectedColumns, 'Dealer-stock preview must contain the same seven columns as the template');
assert.ok(previewTable.includes('colspan="7"'), 'Empty dealer-stock preview must span seven columns');
assert.ok(htmlSource.includes('id="dealerStockUploadedLineCount"'), 'Dealer-stock upload tab must show uploaded part-line count');
assert.ok(htmlSource.includes('id="dealerStockUploadedLineRange"'), 'Dealer-stock upload tab must show uploaded part-line range');
assert.ok(htmlSource.includes('id="dealerStockUploadedSystemValue"'), 'Dealer-stock upload tab must show uploaded system stock value');
assert.ok(htmlSource.includes('id="dashboardDealerStockLineCount"'), 'Dashboard must expose uploaded dealer-stock line-item shortcut');
assert.ok(!htmlSource.includes('data-recon-tab="reconReportTab"'), 'Dealer Reconciliation Report tab must be removed from the Reconciliation page');
assert.ok(htmlSource.includes('id="reconUploadTab"'), 'Reconciliation page must keep the Dealer Stock Upload content');
assert.ok(htmlSource.includes('data-recon-tab="reconSummaryTab"'), 'Reconciliation page must keep Final Summary');
assert.ok(htmlSource.includes('id="reconReportCount"'), 'Dealer Stock Upload screen must include the merged part-wise report table');

assert.ok(
  uiSource.includes("enhanceDataTable($('#dealerStockPreviewTable'), 'daksh_table_dealer_stock_preview')"),
  'Dealer-stock preview must use persisted drag-to-move and resize behavior'
);
assert.ok(uiSource.includes("colspan=\"7\""), 'Rendered empty dealer-stock preview must span seven columns');
assert.ok(uiSource.includes('function setDealerStockUploadSummary'), 'Dealer-stock upload UI must populate the uploaded stock summary strip');
assert.ok(uiSource.includes('dashboardDealerStockLineCount'), 'Dashboard UI must render uploaded dealer-stock line count');
assert.ok(routeSource.includes('dealerStockSummaryFromPublicRows'), 'Reconciliation API must include uploaded dealer-stock summary totals');
assert.ok(routeSource.includes('previewRange: summary.previewRange'), 'Reconciliation API must include uploaded dealer-stock preview range');
assert.ok(inventoryRouteSource.includes('dashboardDealerStockSummary'), 'Dashboard stats must summarize uploaded dealer stock');
assert.ok(inventoryRouteSource.includes('systemStockValue = Number(dealerStockSummary.partLineCount ? uploadedStockValue : reportSystemStockValue)'), 'Dashboard system value must fall back to uploaded dealer stock value');
assert.ok(inventoryRouteSource.includes('dealerStockPartLines'), 'Dashboard stats must expose uploaded dealer-stock line count');

async function verifyTemplateDownloadHandler() {
  const reconciliationRouter = require('../routes/reconciliation');
  const routeLayer = reconciliationRouter.stack.find((layer) => layer.route && layer.route.path === '/dealer-stock-template');
  assert.ok(routeLayer, 'Dealer-stock template download route must be registered');
  const downloadHandler = routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;
  const responseHeaders = {};
  let responseBytes = null;
  const response = {
    setHeader(name, value) {
      responseHeaders[String(name).toLowerCase()] = String(value);
    },
    send(value) {
      responseBytes = Buffer.from(value);
      return value;
    },
    status(code) {
      throw new Error(`Template handler returned HTTP ${code}`);
    }
  };

  await downloadHandler({}, response);
  assert.ok(responseBytes, 'Template handler must send workbook bytes');
  const responseSha256 = crypto.createHash('sha256').update(responseBytes).digest('hex').toUpperCase();
  assert.strictEqual(responseSha256, expectedTemplateSha256, 'Download handler must return the exact uploaded workbook');
  assert.strictEqual(
    responseHeaders['content-type'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Download handler must return the Excel MIME type'
  );
}

verifyTemplateDownloadHandler()
  .then(() => console.log('Uploaded dealer-stock workbook, live download handler, and adjustable preview checks passed.'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
