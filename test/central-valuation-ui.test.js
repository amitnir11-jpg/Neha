const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync('public/ui.js','utf8');
test('reconciliation shows one snapshot even if dashboard responds with an older price version',()=>{
  const text={};const context={state:{reconRows:[],reconLastUpdatedAt:null},reconciliationNumber:(v,f=0)=>Number(v??f),
    dealerStockSummaryCount:s=>s.partLineCount||0,wholeNumber:String,money2:n=>Number(n).toFixed(2),
    renderValuationExceptions(){},setText:(id,value)=>text[id]=value};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('  function setReconciliationSummary('),source.indexOf('  function dealerStockSummaryCount(')),context);
  context.setReconciliationSummary({totalDmsStockQty:10,totalActualScannedQty:7,totalInventoryValue:12.5,
    valuationSummary:{totalDmsDlcValue:12.5,totalPhysicalDlcValue:8.75,quantityCoverage:70}}, {systemStockValue:999,actualStockValueDLC:888},1);
  assert.match(text.dealerStockUploadedSystemValue,/12.50/);assert.match(text.reconScanValue,/8.75/);
  context.setReconciliationSummary({totalInventoryValue:null,totalShortageValue:null,varianceDlc:null,varianceMrp:null,
    valuationSummary:{totalDmsDlcValue:null,totalDmsDlcValueKnownSubtotal:12.5,totalShortValueKnownSubtotal:3.75}},null,1);
  assert.equal(text.reconSummaryInventoryValue,'12.50 (subtotal)');assert.equal(text.reconSummaryShortageValue,'3.75 (subtotal)');
  assert.equal(text.reconSummaryDlc,'Pending');assert.equal(text.reconSummaryMrp,'Pending');
});
test('reconciliation Excel export pins the displayed snapshot',()=>{
  const context={state:{reconAuditId:'SYNTHETIC-AUDIT',reconSnapshotId:'synthetic-snapshot'},URLSearchParams,
    queryFromForm:()=>({}),$:()=>null,activeReconDealer:()=> 'SYNTHETIC-DEALER'};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('  function reconciliationExportQuery('),source.indexOf('  function clearPartSearch(')),context);
  const query=new URLSearchParams(context.reconciliationExportQuery('excel',true));
  assert.equal(query.get('snapshotId'),'synthetic-snapshot');assert.equal(query.get('dealerCode'),'SYNTHETIC-DEALER');
});

test('reconciliation rows keep missing DLC pending instead of substituting MRP',()=>{
  const body={};const context={state:{reconRows:[{partNumber:'MISSING',mrp:20,dlc:null,stockValue:null,
    dmsMrpValue:200,actualStockValue:null,actualMrpValue:100,dmsStock:10,actualStock:5}],reconPageSize:50},
    $:selector=>selector==='#reconRows'?body:null,setText(){},partLink:String,escapeHtml:String,
    reconciliationValue:(...values)=>values.find(value=>value!==null&&value!==undefined)||0,
    reconciliationStatusClass:()=>'',wholeNumber:String,money2:n=>Number(n).toFixed(2)};
  vm.createContext(context);const start=source.indexOf('  function renderReconciliationRows()');
  vm.runInContext(source.slice(start,source.indexOf('  async function loadReconciliation(',start)),context);
  context.renderReconciliationRows();assert.equal((body.innerHTML.match(/Pending/g)||[]).length,3);
  assert.doesNotMatch(body.innerHTML,/200\.00|100\.00/);
});

test('category export uses its pinned snapshot totals and retains missing values',()=>{
  const exportsSource=fs.readFileSync('routes/reports.js','utf8');const start=exportsSource.indexOf('function buildCategoryVarianceRows(');
  const context={};vm.createContext(context);
  vm.runInContext(exportsSource.slice(start,exportsSource.indexOf('function reconciliationStatusText(',start)),context);
  const rows=context.buildCategoryVarianceRows({snapshotId:'pinned',rows:[],grandTotal:{sumDmsValueOnDLC:null,sumPhysicalValueOnDLC:0,totalScannedQuantity:0}},
    {totals:{totalDmsDlcValue:999,totalPhysicalDlcValue:888,totalQuantity:100}});
  assert.equal(rows[0].sumDmsValueOnDLC,null);assert.equal(rows[0].sumPhysicalValueOnDLC,0);assert.equal(rows[0].totalScannedQuantity,0);
});

test('reconciliation export names the same DMS inventory value as the final summary',()=>{
  const exportsSource=fs.readFileSync('routes/reports.js','utf8');const start=exportsSource.indexOf('function buildReconciliationSummaryRows(');
  const context={packCurrency:value=>value===null?'PRICE MISSING':String(value),packMetricRows:(_name,entries)=>entries,
    reconciliationStatusText:()=>'',reconciliationRemarksText:()=>''};
  vm.createContext(context);vm.runInContext(exportsSource.slice(start,exportsSource.indexOf('async function buildCompleteAuditPackWorkbook(',start)),context);
  const rows=context.buildReconciliationSummaryRows({summary:{},valuationSummary:{totalDmsDlcValue:1112.52,totalPhysicalDlcValue:998.69}});
  assert.equal(rows.find(row=>row[0]==='Total Inventory Value')[1],'1112.52');
  assert.equal(rows.find(row=>row[0]==='Actual Stock Value (DLC)')[1],'998.69');
});
