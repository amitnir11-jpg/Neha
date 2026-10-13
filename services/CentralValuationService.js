const { randomUUID,createHash } = require('crypto');
const { getPrismaClient, withDatabaseTransaction } = require('./prisma');
const Dealer = require('../models/Dealer');
const Audit = require('../models/Audit');
const DealerStock = require('../models/DealerStock');
const Inventory = require('../models/Inventory');
const { normalizePartNumber } = require('../utils/normalize');
const { getPricesFromPartMaster } = require('../utils/partMasterPrice');
const { uniqueReportScans } = require('../utils/reportScanIdentity');
const { applyMovementCountRules } = require('../utils/reportTotals');
const { stockAvailableQuantity, stockMovementQuantity, stockWorkshopQuantity, stockUnitQuantity, activeStockTransaction, stockMovementType, stockMovementBin } = require('../utils/stockQuantity');
const { validScanClause } = require('../utils/masterValidation');

const ENGINE = 'central-pg-numeric-v5';
const flights = new Map();
const readFlights = new Map();
function sourceFilters(query={}) {
  const fields={from:query.from||query.fromDate||query.dateFrom,to:query.to||query.toDate||query.dateTo,
    type:query.type||query.scanType,userName:query.userName||query.staffName||query.loginId,
    deviceId:query.deviceId,role:query.role,bin:query.bin||query.binLocation};
  return Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,String(v||'').trim()]).filter(([,v])=>v&&!/^all$/i.test(v)));
}
function filterHash(filters) { return createHash('sha256').update(JSON.stringify(filters)).digest('hex').slice(0,16); }
function enabled() { return process.env.CENTRAL_VALUATION_ENABLED === 'true'; }
function part(row) { return normalizePartNumber(row.normalizedPartNumber || row.partNumber || row.partNo || row.part); }
async function validateScope(query) {
  const dealerCode = String(query.dealerCode || '').trim().toUpperCase();
  const auditId = String(query.auditId || '').trim();
  if (!dealerCode || dealerCode === 'ALL' || !auditId) throw Object.assign(new Error('Select one dealer and audit'), { statusCode: 400 });
  const [dealer, audit] = await Promise.all([Dealer.findOne({ dealerCode }).lean(), Audit.findOne({ dealerCode, auditId }).lean()]);
  if (!dealer || !audit) throw Object.assign(new Error('Audit does not belong to the selected dealer'), { statusCode: 403 });
  return { dealerCode, auditId };
}

// Existing acceptance/deduplication/movement rules are retained; source records
// are read only. Prices come exclusively from master data and price revisions.
async function loadSource(scope,filters={}) {
  const [stock, rawScans] = await Promise.all([
    DealerStock.find(scope).lean(),
    Inventory.find({ ...scope, ...validScanClause() }).sort({ timestamp: 1, createdAt: 1 }).lean()
  ]);
  const eligible = rawScans.filter(row => row.syncStatus === 'synced' && activeStockTransaction(row)
    && (!row.scanStatus || ['ACCEPTED','SUPERVISOR_APPROVED','OUTWARD_DONE'].includes(String(row.scanStatus).toUpperCase()))
    && stockMovementType(row) !== 'VERIFICATION'
    && !/^SYNC/i.test(part(row)) && !/SYNCPT|scan test|sync test/i.test([row.rawScan,row.rawScanString,row.staffName,row.partDescription].join(' ')));
  const {parseIstFilterDate}=require('../utils/time');
  const from=filters.from?parseIstFilterDate(filters.from,false):null,to=filters.to?parseIstFilterDate(filters.to,true):null;
  if((filters.from&&!from)||(filters.to&&!to))throw Object.assign(new Error('Invalid report date filter'),{statusCode:400});
  const scans = applyMovementCountRules(uniqueReportScans(eligible)).filter(row=>{
    const time=new Date(row.timestamp||row.createdAt);
    if((from&&time<from)||(to&&time>to))return false;
    if(filters.type&&stockMovementType(row)!==filters.type.toUpperCase())return false;
    if(filters.bin&&!stockMovementBin(row).includes(filters.bin.toUpperCase()))return false;
    if(filters.userName&&![row.userName,row.staffName,row.loginId,row.userId].some(v=>String(v||'').toUpperCase().includes(filters.userName.toUpperCase())))return false;
    if(filters.deviceId&&row.deviceId!==filters.deviceId)return false;
    if(filters.role&&String(row.role||'').toUpperCase()!==filters.role.toUpperCase())return false;
    return true;
  });
  const groups = new Map();
  const get = key => {
    if (!groups.has(key)) groups.set(key, { partNumber: key, ...scope, dmsQuantity: 0, actualQuantity: 0, physicalBinQty: 0,
      fittedWorkshopQty: 0, inwardQty:0,outwardQty:0,damageQty:0,fittedMovementQty:0,
      uploadedStockPresent: false, bins: [], scanCount: 0 });
    return groups.get(key);
  };
  for (const row of stock) {
    const key = part(row); if (!key) continue;
    const group = get(key);
    group.dmsQuantity += Number(row.dmsStock ?? row.systemQty ?? 0);
    group.uploadedStockPresent = true;
    group.stock = row;
    group.bins.push(...[row.binLoc1,row.binLoc2,row.binLoc3,row.binLocation,row.bin].filter(Boolean));
  }
  for (const row of scans) {
    const key = part(row); if (!key) continue;
    const group = get(key);
    group.actualQuantity += stockAvailableQuantity(row);
    group.physicalBinQty += stockMovementQuantity(row);
    group.fittedWorkshopQty += stockWorkshopQuantity(row);
    const type=stockMovementType(row),units=stockUnitQuantity(row);
    if(['INWARD','AUDIT'].includes(type))group.inwardQty+=units;
    if(type==='OUTWARD')group.outwardQty+=units;
    if(type==='DAMAGE')group.damageQty+=units;
    if(type==='FITTED')group.fittedMovementQty+=units;
    group.scanCount++;
    group.bins.push(row.binLocation || row.bin || '');
  }
  const prices = await getPricesFromPartMaster([...groups.keys()], scope.dealerCode);
  const exactRates = await require('./CentralMasterPriceService').resolvePrices([...groups.keys()],scope.dealerCode);
  const revisions = await getPrismaClient().$queryRaw`
    SELECT DISTINCT ON (part_number) * FROM master_price_revisions
    WHERE dealer_code=${scope.dealerCode} AND effective_at<=now()
    ORDER BY part_number,effective_at DESC,id DESC`;
  const revisionMap = new Map(revisions.map(row => [row.part_number,row]));
  const rows = [...groups.values()].map(row => {
    const price = prices.get(row.partNumber) || {};
    const rate = exactRates.get(row.partNumber)||{};
    const candidate = revisionMap.get(row.partNumber);
    const revision = candidate && rate.dlc===String(candidate.dlc) && rate.mrp===String(candidate.mrp) ? candidate : null;
    return { ...row, bins: [...new Set(row.bins.filter(Boolean))],
      dlc: revision ? String(revision.dlc) : rate.dlc || null,
      mrp: revision ? String(revision.mrp) : rate.mrp || null,
      partDescription: price.description || price.partDescription || row.stock?.partDescription || '',
      category: price.category || price.productCategory || 'Uncategorized',
      productGroup:price.productGroup||row.stock?.productGroup||'',partSubGroup:price.partSubGroup||row.stock?.partSubGroup||'',
      model:price.model||row.stock?.model||'',year:price.year||row.stock?.year||'',
      priceVersion: revision?.id || null, dlcPriceVersion:rate.dlc_version||null,mrpPriceVersion:rate.mrp_version||null,
      dlcPriceDate: revision?.effective_at || rate.dlc_date || null,
      mrpPriceDate: revision?.effective_at || rate.mrp_date || null, pricingSource: revision ? 'MASTER_PRICE_REVISION' : rate.source || 'MASTER_NOT_FOUND' };
  });
  return { rows, metadata: { uploadedRowCount: stock.length, uniqueDmsSkuCount: rows.filter(r=>r.uploadedStockPresent).length,
    scanTransactionCount: scans.length, scanTransactionUnits: scans.reduce((sum,r)=>sum+stockUnitQuantity(r),0),
    rawScanRowCount: rawScans.length, excludedOrMergedScanRows: rawScans.length-scans.length,sourceFilters:filters,
    scans:scans.map(row=>({...row,_centralPart:part(row),_centralBin:stockMovementBin(row),
      _centralStoreQty:String(stockMovementQuantity(row)),_centralAvailableQty:String(stockAvailableQuantity(row)),
      _centralWorkshopQty:String(stockWorkshopQuantity(row))})) } };
}

async function readScans(db,id) {
  return db.$queryRaw`SELECT s || jsonb_build_object('dlc',i.dlc,'dlp',i.dlc,'mrp',i.mrp,
    'currentCatalogueDLC',i.dlc,'currentCatalogueMRP',i.mrp,
    'actualStockValue',round((s->>'_centralAvailableQty')::numeric*i.dlc,2),
    'finalInventoryValue',round((s->>'_centralAvailableQty')::numeric*i.dlc,2),
    'mrpValueReference',round((s->>'_centralAvailableQty')::numeric*i.mrp,2),
    'time',s->>'timestamp','type',s->>'scanType') AS row
    FROM valuation_snapshots v CROSS JOIN LATERAL jsonb_array_elements(v.metadata->'scans') s
    JOIN valuation_items i ON i.snapshot_id=v.id AND i.part_number=s->>'_centralPart' WHERE v.id=${id}`;
}
async function readBins(db,id) {
  return db.$queryRaw`WITH b AS (
    SELECT s->>'_centralPart' part_number,s->>'_centralBin' bin,sum((s->>'_centralStoreQty')::numeric) qty
    FROM valuation_snapshots v CROSS JOIN LATERAL jsonb_array_elements(v.metadata->'scans') s WHERE v.id=${id}
    GROUP BY s->>'_centralPart',s->>'_centralBin'
  ) SELECT i.details || jsonb_build_object('bin',b.bin,'binLocation',b.bin,'qty',b.qty,'availableQty',b.qty,
    'physicalBinQty',b.qty,'actualAuditQty',b.qty,'totalDealerStockQty',b.qty,
    'mrp',i.mrp,'dlc',i.dlc,'finalInventoryValue',CASE WHEN b.qty=0 THEN 0 ELSE round(b.qty*i.dlc,2) END,
    'totalDlcValue',CASE WHEN b.qty=0 THEN 0 ELSE round(b.qty*i.dlc,2) END,
    'totalMrpValue',CASE WHEN b.qty=0 THEN 0 ELSE round(b.qty*i.mrp,2) END,
    'mrpValueReference',CASE WHEN b.qty=0 THEN 0 ELSE round(b.qty*i.mrp,2) END) AS row
    FROM b JOIN valuation_items i ON i.snapshot_id=${id} AND i.part_number=b.part_number ORDER BY b.bin,b.part_number`;
}

async function sourceRevision(db, scope) {
  const [row] = await db.$queryRaw`SELECT concat(count(*),':',coalesce(max(id),0),':',coalesce(sum(id),0)) AS revision FROM valuation_changes c
    WHERE (c.dealer_code=${scope.dealerCode} AND c.audit_id=${scope.auditId})
      OR (c.source='price' AND c.dealer_code IN ('','ALL',${scope.dealerCode}) AND (
        EXISTS (SELECT 1 FROM dealer_stock_master s WHERE s."dealerCode"=${scope.dealerCode} AND s."auditId"=${scope.auditId}
          AND regexp_replace(upper(coalesce(s."normalizedPartNumber",s."partNumber",s.data->>'partNo','')),'[[:space:]*-]','','g')=c.part_number)
        OR EXISTS (SELECT 1 FROM inventories s WHERE s."dealerCode"=${scope.dealerCode} AND s."auditId"=${scope.auditId}
          AND regexp_replace(upper(coalesce(s."normalizedPartNumber",s."partNumber",s.data->>'part','')),'[[:space:]*-]','','g')=c.part_number)))`;
  return row.revision;
}

// Every amount is calculated in PostgreSQL NUMERIC. Round each SKU's DMS and
// physical amount half away from zero to cents, then subtract the same rounded
// amounts so line, shortage/excess and grand totals tie exactly.
async function readItems(db, id) {
  return db.$queryRaw`SELECT details || jsonb_build_object(
    'dmsQuantity',dms_qty,'actualQuantity',physical_qty,'systemQty',dms_qty,'dmsStock',dms_qty,
    'physicalQty',physical_qty,'totalDealerStockQty',physical_qty,'actualStock',physical_qty,
    'dlc',dlc,'mrp',mrp,'dlp',dlc,
    'dmsDlcValue',CASE WHEN dms_qty=0 THEN 0 ELSE round(dms_qty*dlc,2) END,
    'actualDlcValue',CASE WHEN physical_qty=0 THEN 0 ELSE round(physical_qty*dlc,2) END,
    'dmsMrpValue',CASE WHEN dms_qty=0 THEN 0 ELSE round(dms_qty*mrp,2) END,
    'actualMrpValue',CASE WHEN physical_qty=0 THEN 0 ELSE round(physical_qty*mrp,2) END,
    'shortageQty',greatest(dms_qty-physical_qty,0),'excessQty',greatest(physical_qty-dms_qty,0),
    'varianceQty',physical_qty-dms_qty,'variance',physical_qty-dms_qty,
    'missingDlc',dlc IS NULL,'missingMrp',mrp IS NULL,
    'dlcDifference',CASE WHEN dms_qty=0 THEN 0 ELSE round(dms_qty*dlc,2) END * -1 + CASE WHEN physical_qty=0 THEN 0 ELSE round(physical_qty*dlc,2) END,
    'mrpDifference',CASE WHEN dms_qty=0 THEN 0 ELSE round(dms_qty*mrp,2) END * -1 + CASE WHEN physical_qty=0 THEN 0 ELSE round(physical_qty*mrp,2) END
  ) AS row FROM valuation_items WHERE snapshot_id=${id} ORDER BY part_number`;
}
async function aggregate(db, id, selectedParts=null) {
  const [result] = await db.$queryRaw`WITH v AS (
    SELECT *, CASE WHEN dms_qty=0 THEN 0 ELSE round(dms_qty*dlc,2) END ds,
      CASE WHEN physical_qty=0 THEN 0 ELSE round(physical_qty*dlc,2) END ph,
      CASE WHEN dms_qty=0 THEN 0 ELSE round(dms_qty*mrp,2) END dm,
      CASE WHEN physical_qty=0 THEN 0 ELSE round(physical_qty*mrp,2) END pm
    FROM valuation_items WHERE snapshot_id=${id} AND (${selectedParts===null} OR part_number IN (SELECT jsonb_array_elements_text(${JSON.stringify(selectedParts||[])}::jsonb)))
  ) SELECT jsonb_build_object(
    'totalParts',count(*),'dmsParts',count(*) FILTER(WHERE (details->>'uploadedStockPresent')::boolean),
    'totalSystemQty',coalesce(sum(dms_qty),0),'totalPhysicalQty',coalesce(sum(physical_qty),0),
    'totalShortQty',coalesce(sum(greatest(dms_qty-physical_qty,0)),0),'totalExcessQty',coalesce(sum(greatest(physical_qty-dms_qty,0)),0),
    'totalVarianceQty',coalesce(sum(physical_qty-dms_qty),0),
    'quantityCoverage',CASE WHEN sum(dms_qty)>0 THEN round(100*sum(physical_qty)/sum(dms_qty),1) ELSE 0 END,
    'matchedSkuCount',count(*) FILTER(WHERE physical_qty=dms_qty),
    'shortageSkuCount',count(*) FILTER(WHERE physical_qty<dms_qty),'excessSkuCount',count(*) FILTER(WHERE physical_qty>dms_qty),
    'priceMissingParts',count(*) FILTER(WHERE dlc IS NULL OR mrp IS NULL),
    'partsMissingDlc',count(*) FILTER(WHERE dlc IS NULL),'partsMissingMrp',count(*) FILTER(WHERE mrp IS NULL),
    'dmsPriceMissingParts',count(*) FILTER(WHERE dms_qty<>0 AND (dlc IS NULL OR mrp IS NULL)),
    'dmsPriceMissingQty',coalesce(sum(dms_qty) FILTER(WHERE dlc IS NULL OR mrp IS NULL),0),
    'pricedDmsQty',coalesce(sum(dms_qty) FILTER(WHERE dlc IS NOT NULL AND mrp IS NOT NULL),0),
    'quantityPriceCoverage',CASE WHEN sum(dms_qty)>0 THEN round(100*coalesce(sum(dms_qty) FILTER(WHERE dlc IS NOT NULL AND mrp IS NOT NULL),0)/sum(dms_qty),2) ELSE 100 END,
    'valuationComplete',count(*) FILTER(WHERE dlc IS NULL OR mrp IS NULL)=0,
    'totalDmsDlcValue',CASE WHEN count(*) FILTER(WHERE ds IS NULL)=0 THEN coalesce(sum(ds),0) END,
    'totalPhysicalDlcValue',CASE WHEN count(*) FILTER(WHERE ph IS NULL)=0 THEN coalesce(sum(ph),0) END,
    'totalDmsMrpValue',CASE WHEN count(*) FILTER(WHERE dm IS NULL)=0 THEN coalesce(sum(dm),0) END,
    'totalPhysicalMrpValue',CASE WHEN count(*) FILTER(WHERE pm IS NULL)=0 THEN coalesce(sum(pm),0) END,
    'totalDmsDlcValueKnownSubtotal',coalesce(sum(ds),0),'totalPhysicalDlcValueKnownSubtotal',coalesce(sum(ph),0),
    'totalDmsMrpValueKnownSubtotal',coalesce(sum(dm),0),'totalPhysicalMrpValueKnownSubtotal',coalesce(sum(pm),0),
    'totalVarianceDlcValue',CASE WHEN count(*) FILTER(WHERE ds IS NULL OR ph IS NULL)=0 THEN coalesce(sum(ph-ds),0) END,
    'totalVarianceMrpValue',CASE WHEN count(*) FILTER(WHERE dm IS NULL OR pm IS NULL)=0 THEN coalesce(sum(pm-dm),0) END,
    'totalShortValue',CASE WHEN count(*) FILTER(WHERE physical_qty<dms_qty AND (ds IS NULL OR ph IS NULL))=0 THEN coalesce(sum(ds-ph) FILTER(WHERE physical_qty<dms_qty),0) END,
    'totalExcessValue',CASE WHEN count(*) FILTER(WHERE physical_qty>dms_qty AND (ds IS NULL OR ph IS NULL))=0 THEN coalesce(sum(ph-ds) FILTER(WHERE physical_qty>dms_qty),0) END,
    'totalShortMrpValue',CASE WHEN count(*) FILTER(WHERE physical_qty<dms_qty AND (dm IS NULL OR pm IS NULL))=0 THEN coalesce(sum(dm-pm) FILTER(WHERE physical_qty<dms_qty),0) END,
    'totalExcessMrpValue',CASE WHEN count(*) FILTER(WHERE physical_qty>dms_qty AND (dm IS NULL OR pm IS NULL))=0 THEN coalesce(sum(pm-dm) FILTER(WHERE physical_qty>dms_qty),0) END,
    'totalVarianceDlcValueKnownSubtotal',coalesce(sum(ph),0)-coalesce(sum(ds),0),
    'totalVarianceMrpValueKnownSubtotal',coalesce(sum(pm),0)-coalesce(sum(dm),0),
    'totalShortValueKnownSubtotal',coalesce(sum(ds-ph) FILTER(WHERE physical_qty<dms_qty),0),
    'totalExcessValueKnownSubtotal',coalesce(sum(ph-ds) FILTER(WHERE physical_qty>dms_qty),0),
    'totalShortMrpValueKnownSubtotal',coalesce(sum(dm-pm) FILTER(WHERE physical_qty<dms_qty),0),
    'totalExcessMrpValueKnownSubtotal',coalesce(sum(pm-dm) FILTER(WHERE physical_qty>dms_qty),0)
  ) AS summary FROM v`;
  return result.summary;
}
function publicRow(row) {
  const variance = row.varianceQty;
  const dlcDiff = row.dlcDifference;
  const mrpDiff = row.mrpDifference;
  return { ...row.stock, ...row, partNo:row.partNumber, partNum:row.partNumber, physicalStock:row.actualQuantity,
    netDifference:variance,differenceQty:variance,short:row.shortageQty,excess:row.excessQty,
    status: variance<0?'Shortage':variance>0?'Excess':'Matched',notInDms:!row.uploadedStockPresent,
    pricingStatus:row.missingDlc||row.missingMrp?'PRICE MISSING':'VERIFIED',
    actualStockValue:row.actualDlcValue,physicalValueOnDlc:row.actualDlcValue,
    dmsStockValue:row.dmsDlcValue,systemValueOnDlc:row.dmsDlcValue,stockValue:row.dmsDlcValue,
    actualMrpValue:row.actualMrpValue,physicalValueOnMrp:row.actualMrpValue,
    dmsMrpValue:row.dmsMrpValue,systemMrpValue:row.dmsMrpValue,physicalMrpValue:row.actualMrpValue,
    varianceDlc:dlcDiff,varianceOnDlc:dlcDiff,varianceStockValue:dlcDiff,differenceDlcValue:dlcDiff,
    varianceMrp:mrpDiff,varianceOnMrp:mrpDiff,varianceMrpValue:mrpDiff,differenceMrpValue:mrpDiff,
    shortageValue:variance<0?(dlcDiff===null?null:-dlcDiff):0,excessValue:variance>0?dlcDiff:0,
    binLocation:row.bins.join(', '), binLocations:row.bins.join(', '), bin:row.bins.join(', '),productCategory:row.category,
    physicalQty:row.physicalBinQty,fittedQty:row.fittedWorkshopQty,
    inventoryRiskStatus:row.actualQuantity<0?'Negative balance — review movement':row.missingDlc||row.missingMrp?'Price correction required':'Calculated',
    actionRemarks:row.actualQuantity<0?'Signed movement balance retained; source quantities were not changed.':'' };
}
async function materialize(scope,filters={}) {
  return withDatabaseTransaction(async db => {
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`valuation:${scope.dealerCode}:${scope.auditId}`},0))::text`;
    const revision = `${await sourceRevision(db,scope)}:${filterHash(filters)}`;
    const existing = await db.$queryRaw`SELECT * FROM valuation_snapshots WHERE dealer_code=${scope.dealerCode} AND audit_id=${scope.auditId} AND revision=${revision} AND engine_version=${ENGINE}`;
    if (existing.length) return existing[0];
    const source = await loadSource(scope,filters);
    const id = randomUUID();
    await db.$executeRaw`INSERT INTO valuation_snapshots(id,dealer_code,audit_id,revision,engine_version,metadata)
      VALUES(${id},${scope.dealerCode},${scope.auditId},${revision},${ENGINE},${JSON.stringify(source.metadata)}::jsonb)`;
    const input = source.rows.map(row=>({part_number:row.partNumber,dms_qty:String(row.dmsQuantity),physical_qty:String(row.actualQuantity),dlc:row.dlc,mrp:row.mrp,details:row}));
    await db.$executeRaw`INSERT INTO valuation_items(snapshot_id,part_number,dms_qty,physical_qty,dlc,mrp,details)
      SELECT ${id},x.part_number,x.dms_qty,x.physical_qty,x.dlc,x.mrp,x.details FROM jsonb_to_recordset(${JSON.stringify(input)}::jsonb)
      AS x(part_number text,dms_qty numeric,physical_qty numeric,dlc numeric,mrp numeric,details jsonb)`;
    const summary = await aggregate(db,id);
    summary.reconciliationComplete = source.metadata.uploadedRowCount>0;
    summary.finalStatus = !summary.reconciliationComplete?'STOCK UPLOAD REQUIRED':summary.valuationComplete?'Valuation Complete':'Final valuation pending';
    await db.$executeRaw`UPDATE valuation_snapshots SET summary=${JSON.stringify(summary)}::jsonb WHERE id=${id}`;
    return {id,summary,metadata:source.metadata,revision,created_at:new Date(),engine_version:ENGINE};
  }, {timeout:60000});
}
async function getSnapshot(query) {
  const scope = await validateScope(query);
  const filters=sourceFilters(query);
  const key = `${scope.dealerCode}:${scope.auditId}:${filterHash(filters)}`;
  let snapshot;
  if (query.snapshotId) {
    const rows = await getPrismaClient().$queryRaw`SELECT * FROM valuation_snapshots WHERE id=${query.snapshotId} AND dealer_code=${scope.dealerCode} AND audit_id=${scope.auditId}`;
    if (!rows.length) throw Object.assign(new Error('Snapshot does not belong to selected dealer/audit'),{statusCode:404});
    snapshot=rows[0];
    if(Object.keys(filters).length&&filterHash(filters)!==filterHash(snapshot.metadata.sourceFilters||{}))
      throw Object.assign(new Error('Report filters changed. Load a new valuation snapshot before exporting.'),{statusCode:409});
  } else {
    if (!flights.has(key)) flights.set(key,materialize(scope,filters).finally(()=>flights.delete(key)));
    snapshot=await flights.get(key);
  }
  if(!readFlights.has(snapshot.id))readFlights.set(snapshot.id,(async()=>{
    const [items,scanItems,binItems]=await Promise.all([readItems(getPrismaClient(),snapshot.id),readScans(getPrismaClient(),snapshot.id),readBins(getPrismaClient(),snapshot.id)]);
    const rows=items.map(r=>publicRow(r.row));
    const priceExceptions=rows.filter(r=>r.missingDlc||r.missingMrp);
    const {scans:storedScans,...counts}=snapshot.metadata;
    return {scope,rows,scans:scanItems.map(r=>r.row),binRows:binItems.map(r=>r.row),summary:{...scope,...snapshot.summary,...counts,priceExceptions,
      snapshotId:snapshot.id,calculationVersion:snapshot.engine_version,dataRevision:String(snapshot.revision),generatedAt:snapshot.created_at},
      snapshotId:snapshot.id,calculationVersion:snapshot.engine_version,priceExceptions};
  })().finally(()=>readFlights.delete(snapshot.id)));
  return readFlights.get(snapshot.id);
}
async function summarizeSelection(snapshot, rows) {
  const summary=await aggregate(getPrismaClient(),snapshot.snapshotId,rows.map(r=>r.partNumber));
  return {...snapshot.summary,...summary,priceExceptions:rows.filter(r=>r.missingDlc||r.missingMrp)};
}
module.exports={enabled,getSnapshot,validateScope,summarizeSelection,ENGINE};
