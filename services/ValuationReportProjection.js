const valuation = require('./CentralValuationService');
const Dealer = require('../models/Dealer');
const Audit = require('../models/Audit');
const { normalizePartNumber } = require('../utils/normalize');

function matches(row,q) {
  const includes=(value,filter)=>!filter||String(value||'').toUpperCase().includes(String(filter).toUpperCase());
  if (!includes(row.partNumber,normalizePartNumber(q.partNumber||''))) return false;
  if (!includes(row.category,q.productCategory||q.category)||!includes(row.binLocation,q.bin||q.binLocation)) return false;
  if(q.status && !includes(row.status,q.status==='Short'?'Shortage':q.status))return false;
  if(q.varianceType && q.varianceType!=='ALL' && !includes(row.status,q.varianceType))return false;
  if(['1','true','yes'].includes(String(q.dealerStockOnly))&&!row.uploadedStockPresent)return false;
  return true;
}
function summaryAliases(v, scope) {
  return {...scope,...v,valuationSummary:v,valuationComplete:v.valuationComplete,
    totalPartsUploaded:v.uploadedRowCount,totalDmsStockQty:v.totalSystemQty,totalActualScannedQty:v.totalPhysicalQty,
    totalMatchedParts:v.matchedSkuCount,totalShortageParts:v.shortageSkuCount,totalExcessParts:v.excessSkuCount,
    totalInventoryValue:v.totalDmsDlcValue,dmsStockValueDLC:v.totalDmsDlcValue,dmsStockValueMRP:v.totalDmsMrpValue,
    actualStockValueDLC:v.totalPhysicalDlcValue,actualStockValueMRP:v.totalPhysicalMrpValue,
    totalActualStockValue:v.totalPhysicalDlcValue,totalDmsStockValue:v.totalDmsDlcValue,
    totalActualMrpValue:v.totalPhysicalMrpValue,totalDmsMrpValue:v.totalDmsMrpValue,
    totalSystemMrpValue:v.totalDmsMrpValue,totalPhysicalMrpValue:v.totalPhysicalMrpValue,
    totalShortageValue:v.totalShortValue,totalExcessValue:v.totalExcessValue,
    dmsStock:v.totalSystemQty,physicalStock:v.totalPhysicalQty,actualStock:v.totalPhysicalQty,
    excess:v.totalExcessQty,short:v.totalShortQty,netDifference:v.totalVarianceQty,
    varianceDlc:v.totalVarianceDlcValue,varianceMrp:v.totalVarianceMrpValue,
    totalScannedButNotInDms:v.totalParts-v.dmsParts,totalScans:v.scanTransactionCount,scanRows:v.scanTransactionCount,
    totalQuantity:v.scanTransactionUnits,uniqueParts:v.totalParts,matched:v.matchedSkuCount,shortage:v.shortageSkuCount,
    mismatchCount:v.shortageSkuCount+v.excessSkuCount,valuationBasis:'DLC'};
}
async function project(query,kind='raw') {
  const snapshot=await valuation.getSnapshot(query);
  const rows=snapshot.rows.filter(r=>matches(r,query));
  const v=rows.length===snapshot.rows.length?snapshot.summary:await valuation.summarizeSelection(snapshot,rows);
  const summary=summaryAliases(v,snapshot.scope);
  const [selectedDealer,selectedAudit]=await Promise.all([
    Dealer.findOne({dealerCode:snapshot.scope.dealerCode}).lean(),Audit.findOne(snapshot.scope).lean()]);
  summary.dealerName=selectedDealer?.dealerName||snapshot.scope.dealerCode;
  const shared={scope:snapshot.scope,filters:query,rows,summary,selectedDealer,selectedAudit,
    valuationSummary:v,priceExceptions:v.priceExceptions,pricingIssues:v.priceExceptions,
    snapshotId:snapshot.snapshotId,calculationVersion:snapshot.calculationVersion,stockCount:v.uploadedRowCount,
    totalRows:rows.length,pricingCoverage:{totalDmsQuantity:v.totalSystemQty,totalActualQuantity:v.totalPhysicalQty,
      totalDmsValue:v.totalDmsDlcValue,totalActualValue:v.totalPhysicalDlcValue},
    validationLog:{totalVarianceQuantity:v.totalVarianceQty,totalVarianceOnDLC:v.totalVarianceDlcValue,totalVarianceOnMRP:v.totalVarianceMrpValue,
      actualStockValueDLC:v.totalPhysicalDlcValue,dmsStockValueDLC:v.totalDmsDlcValue,
      actualStockValueMRP:v.totalPhysicalMrpValue,dmsStockValueMRP:v.totalDmsMrpValue}};
  const partwiseRows=rows.map(r=>({...r,status:r.varianceQty<0?'Short':r.varianceQty>0?'Excess':'Inventory Matched',
    action:r.varianceQty<0?'Short':r.varianceQty>0?'Excess':'Inventory Matched',scanTypeAction:r.varianceQty<0?'Short':r.varianceQty>0?'Excess':'Inventory Matched'}));
  if(kind==='partwise')return {...shared,rows:partwiseRows};
  const categories=[];
  for(const category of [...new Set(rows.map(r=>r.category))]) {
    const partRows=rows.filter(r=>r.category===category);
    const totals=await valuation.summarizeSelection(snapshot,partRows);
    categories.push({category,valuationSummary:totals,systemQty:totals.totalSystemQty,physicalQty:totals.totalPhysicalQty,differenceQty:totals.totalVarianceQty,
      differenceMrpValue:totals.totalVarianceMrpValue,differenceDlcValue:totals.totalVarianceDlcValue,
      matched:totals.matchedSkuCount,short:totals.shortageSkuCount,excess:totals.excessSkuCount});
  }
  const matrix=(category,totals)=>({category,dmsValue:totals.totalDmsDlcValue,dmsQuantity:totals.totalSystemQty,dmsPartLines:totals.dmsParts,
    physicalValue:totals.totalPhysicalDlcValue,physicalQuantity:totals.totalPhysicalQty,physicalPartLines:totals.totalParts,
    excessValue:totals.totalExcessValue,excessPartLines:totals.excessSkuCount,shortValue:totals.totalShortValue,
    shortPartLines:totals.shortageSkuCount,netDifference:totals.totalVarianceDlcValue,valuationComplete:totals.valuationComplete});
  const reconciliationCategory=(category,totals)=>({category,dmsQty:totals.totalSystemQty,actualQty:totals.totalPhysicalQty,
    varianceQty:totals.totalVarianceQty,dmsValue:totals.totalDmsDlcValue,actualValue:totals.totalPhysicalDlcValue,
    shortValue:totals.totalShortValue,excessValue:totals.totalExcessValue,netDifference:totals.totalVarianceDlcValue,
    valuationComplete:totals.valuationComplete,status:totals.valuationComplete?'Calculated':'Incomplete'});
  if(kind==='reconciliation')return {...shared,mismatchRecords:rows.filter(r=>r.varianceQty!==0),
    centralCategoryRows:categories.map(c=>reconciliationCategory(c.category,c.valuationSummary)).concat([{...reconciliationCategory('Grand Total',v),rowType:'grandTotal'}])};
  if(kind==='stock'){
    const matrixRows=categories.map(c=>matrix(c.category,c.valuationSummary)),grandTotal={...matrix('Grand Total',v),rowType:'total'};
    const amount=value=>value===null?'Pending':value.toFixed(2);
    const reconciliationSummary={status:v.finalStatus,remarks:v.valuationComplete?'Calculated from the selected snapshot':'Resolve master price exceptions before certifying valuation',
      rows:[['DMS Stock Value',v.totalDmsDlcValue],['Actual Physical Stock Value',v.totalPhysicalDlcValue],['Variance Value',v.totalVarianceDlcValue],['Shortages Identified',v.totalShortValue],['Excess Stock Identified',v.totalExcessValue],['FINAL NET DIFFERENCE',v.totalVarianceDlcValue]].map(([label,value])=>({label,value,displayValue:amount(value),kind:'currency'}))};
    const metadata=[{label:'Dealer',value:summary.dealerName},{label:'Dealer Code',value:snapshot.scope.dealerCode},
      {label:'Audit ID',value:snapshot.scope.auditId},{label:'Valuation Snapshot',value:snapshot.snapshotId},
      {label:'Calculation',value:snapshot.calculationVersion},{label:'Valuation Status',value:v.finalStatus},
      {label:'Quantity Price Coverage',value:`${v.quantityPriceCoverage}%`},
      {label:'DMS DLC Known Subtotal',value:amount(v.totalDmsDlcValueKnownSubtotal)},{label:'DMS MRP Known Subtotal',value:amount(v.totalDmsMrpValueKnownSubtotal)}];
    return {...shared,rows:matrixRows.concat([grandTotal]),detailRows:rows,sections:{title:'Stock Summary',metadata,rows:matrixRows,grandTotal,footer:{},reconciliationSummary},
      summary:{...summary,status:v.finalStatus,metadata,footer:{},reconciliationSummary}};
  }
  if(kind==='category'){
    const categoryRow=(category,t)=>({productCategory:category,action:'All',totalScannedParts:t.totalParts,totalScannedQuantity:t.totalPhysicalQty,
      sumPhysicalValueOnMRP:t.totalPhysicalMrpValue,sumPhysicalValueOnDLC:t.totalPhysicalDlcValue,
      sumDmsValueOnMRP:t.totalDmsMrpValue,sumDmsValueOnDLC:t.totalDmsDlcValue,
      sumVarianceOnMRP:t.totalVarianceMrpValue,sumVarianceOnDLC:t.totalVarianceDlcValue,rowType:'subtotal'});
    return {...shared,rows:categories.map(c=>categoryRow(c.category,c.valuationSummary)),grandTotal:categoryRow('Grand Total',v)};
  }
  const scans=snapshot.scans||[];
  return {...shared,summary:[summary],allFinalRows:partwiseRows,finalRows:partwiseRows,scans,categoryRows:categories,
    rawLogRows:scans,binRows:snapshot.binRows,openingRows:rows,oilRows:rows.filter(r=>/oil|lube/i.test(r.category)),
    accessoryRows:rows.filter(r=>/accessor/i.test(r.category)),damageRows:scans.filter(r=>r.scanType==='DAMAGE'),
    nonMovingRows:[],highValueNonMovingRows:[],dealers:[selectedDealer],audits:[selectedAudit],dealerBackupRows:[selectedDealer]};
}
module.exports={project,summaryAliases};
