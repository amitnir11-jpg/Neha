const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

test('PDF renderers pass every report row to the paginated table renderer', () => {
  const rows = Array.from({ length: 1201 }, (_, index) => ({ partNumber: `PART${index}` }));
  const columns = Array.from({ length: 15 }, (_, index) => ({ header: `Part Number ${index}`, key: 'partNumber' }));
  const bodies = [];
  class Document {
    setFontSize() {}
    text() {}
    addImage() {}
    output() { return new ArrayBuffer(1); }
  }
  const context = {
    Buffer, jsPDF: Document,
    autoTable: (_doc, options) => bodies.push(options.body),
    partwiseInventoryAuditColumns: () => columns,
    selectedColumns: value => value,
    columnsForReport: () => columns,
    formatDateLikeFields: value => value,
    DAKSH_REPORT_LOGO_BUFFER: Buffer.alloc(0)
  };
  const core = fs.readFileSync('routes/report.js', 'utf8');
  const generic = fs.readFileSync('routes/reports.js', 'utf8');
  vm.runInNewContext(core.slice(core.indexOf('function buildPartwiseInventoryAuditPdfBuffer('), core.indexOf('function categoryVarianceColumns(')), context);
  vm.runInNewContext(generic.slice(generic.indexOf('function sendPdf('), generic.indexOf('async function handleReport(')), context);
  context.buildPartwiseInventoryAuditPdfBuffer({ rows, summary: {} });
  context.buildPdfBuffer('Report', rows, 'scan-register');
  context.sendPdf({ setHeader() {}, send() {} }, 'Report', rows, 'scan-register');
  assert.equal(bodies.length, 3);
  for (const body of bodies) {
    assert.equal(body.length, rows.length);
    assert.equal(body.at(-1)[0], 'PART1200');
    assert.equal(body.at(-1).length, columns.length);
  }
});
