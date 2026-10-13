const {randomUUID,createHash}=require('crypto');
const {Prisma,getPrismaClient,withDatabaseTransaction}=require('./prisma');
const valuation=require('./CentralValuationService');
const {getPricesFromPartMaster}=require('../utils/partMasterPrice');
const MasterPart=require('../models/MasterPart');
const DealerStock=require('../models/DealerStock');
const {normalizePartNumber}=require('../utils/normalize');

async function previewUpload(req,scope,parse) {
  await valuation.validateScope(scope);
  const file=req.file;
  if(!file?.buffer)throw Object.assign(new Error('Select stock Excel or CSV file'),{statusCode:400});
  const parsed=await parse();
  if(!parsed.records.length || parsed.errorRows.length)throw Object.assign(new Error(`Fix invalid upload rows before confirmation: ${parsed.errorRows[0]?.message||'No valid rows'}`),{statusCode:400});
  if(parsed.records.some(r=>!Number.isFinite(Number(r.dmsStock??r.systemQty))||Number(r.dmsStock??r.systemQty)<0))
    throw Object.assign(new Error('Uploaded DMS quantities must be finite and non-negative'),{statusCode:400});
  const hash=createHash('sha256').update(file.buffer).digest('hex');
  const id=randomUUID();
  const actor=String(req.user.id||req.user.username);
  const imports=await getPrismaClient().$queryRaw`INSERT INTO dealer_stock_imports(id,dealer_code,audit_id,file_hash,file_name,original_file,parsed,actor)
    VALUES(${id},${scope.dealerCode},${scope.auditId},${hash},${file.originalname},${file.buffer},${JSON.stringify(parsed)}::jsonb,${actor})
    ON CONFLICT(dealer_code,audit_id,file_hash) DO UPDATE SET file_hash=EXCLUDED.file_hash
    RETURNING id,status,actor`;
  const prices=await getPricesFromPartMaster(parsed.records.map(r=>r.partNumber),scope.dealerCode);
  const preview=parsed.records.slice(0,100).map(row=>{const price=prices.get(row.normalizedPartNumber||row.partNumber)||{};
    return {...row,dlc:price.dlc||null,mrp:price.mrp||null,partDescription:price.description||price.partDescription||row.partDescription||''};});
  return {success:true,...scope,requiresConfirmation:true,importId:imports[0].id,alreadyConfirmed:imports[0].status==='CONFIRMED',
    preview,savedCount:0,acceptedRows:parsed.records.length,skippedCount:0,duplicateRowsMerged:parsed.duplicateRowsMerged,
    errorRows:[],summary:{previewPending:true,partLineCount:parsed.records.length,dmsStock:parsed.records.reduce((sum,r)=>sum+Number(r.dmsStock||r.systemQty||0),0)},
    message:'Preview ready. Confirm to save stock. Existing parts are updated by exact SKU; other uploaded stock is preserved.'};
}
async function confirmUpload(req,scope) {
  await valuation.validateScope(scope);
  const id=String(req.body.importId||'');
  return withDatabaseTransaction(async db=>{
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dealer-stock:${scope.dealerCode}:${scope.auditId}`},0))::text`;
    const [batch]=await db.$queryRaw`SELECT id,status,parsed,actor FROM dealer_stock_imports
      WHERE id=${id} AND dealer_code=${scope.dealerCode} AND audit_id=${scope.auditId} FOR UPDATE`;
    if(!batch)throw Object.assign(new Error('Upload preview does not belong to selected dealer/audit'),{statusCode:404});
    if(batch.status==='CONFIRMED')return {success:true,...scope,importId:id,alreadyConfirmed:true,message:'This file has already been confirmed. Stock was not duplicated.'};
    if(batch.actor!==String(req.user.id||req.user.username))throw Object.assign(new Error('Only the uploader can confirm this preview'),{statusCode:403});
    const partNumbers=batch.parsed.records.map(r=>r.normalizedPartNumber||r.partNumber);
    const prices=await getPricesFromPartMaster(partNumbers,scope.dealerCode);
    const rates=await require('./CentralMasterPriceService').resolvePrices(partNumbers,scope.dealerCode);
    const records=batch.parsed.records.map(row=>{const price=prices.get(row.normalizedPartNumber||row.partNumber)||{},rate=rates.get(row.normalizedPartNumber||row.partNumber)||{};
      return {...row,...scope,uploadBatchId:id,partDescription:price.description||price.partDescription||row.partDescription||'',
        dlc:rate.dlc||null,dlp:rate.dlc||null,mrp:rate.mrp||null,dlcPriceVersion:rate.dlc_version||null,mrpPriceVersion:rate.mrp_version||null,
        dlcPriceDate:rate.dlc_date||null,mrpPriceDate:rate.mrp_date||null};});
    // All chunks, import state and source invalidation commit together.
    for(let i=0;i<records.length;i+=500)await DealerStock.bulkUpsertBy(records.slice(i,i+500),['dealerCode','auditId','normalizedPartNumber']);
    await db.$executeRaw`UPDATE dealer_stock_imports SET status='CONFIRMED',confirmed_at=now() WHERE id=${id}`;
    return {success:true,...scope,importId:id,savedCount:records.length,preview:records.slice(0,100),errorRows:[],
      message:`Confirmed ${records.length} dealer stock SKUs. Original file and import history retained.`};
  },{timeout:60000});
}
async function correctPrice(req,scope) {
  await valuation.validateScope(scope);
  const partNumber=normalizePartNumber(req.body.partNumber);
  const reason=String(req.body.reason||'').trim();
  let dlc,mrp;
  try {dlc=new Prisma.Decimal(String(req.body.dlc));mrp=new Prisma.Decimal(String(req.body.mrp));}catch{throw Object.assign(new Error('Enter valid DLC and MRP'),{statusCode:400});}
  if(!partNumber||!dlc.isFinite()||!mrp.isFinite()||!dlc.gt(0)||!mrp.gt(0)||!reason)
    throw Object.assign(new Error('Part number, positive DLC/MRP and correction reason are required'),{statusCode:400});
  if(dlc.decimalPlaces()>8||mrp.decimalPlaces()>8||dlc.gte('10000000000000000')||mrp.gte('10000000000000000'))
    throw Object.assign(new Error('Master prices support up to eight decimal places and sixteen integer digits'),{statusCode:400});
  const id=randomUUID();
  await withDatabaseTransaction(async db=>{
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`price:${scope.dealerCode}:${partNumber}`},0))::text`;
    await db.$executeRaw`INSERT INTO master_price_revisions(id,dealer_code,part_number,dlc,mrp,reason,actor)
      VALUES(${id},${scope.dealerCode},${partNumber},${dlc.toString()}::numeric,${mrp.toString()}::numeric,${reason},${String(req.user.id||req.user.username)})`;
    // Dealer-specific master record preserves the shared catalogue and other dealers.
    const old=await MasterPart.findOne({dealerCode:scope.dealerCode,normalizedPartNumber:partNumber}).lean();
    const values={dealerCode:scope.dealerCode,partNumber,normalizedPartNumber:partNumber,dlc:dlc.toFixed(),dlp:dlc.toFixed(),mrp:mrp.toFixed(),priceRevisionId:id,effectiveFrom:new Date()};
    if(old)await MasterPart.updateOne({_id:old._id},{$set:values});else await MasterPart.create(values);
  });
  return {success:true,...scope,priceVersion:id,message:'Dealer master price corrected. Affected audit snapshots will refresh automatically.'};
}
module.exports={previewUpload,confirmUpload,correctPrice};
