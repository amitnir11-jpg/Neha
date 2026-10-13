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
