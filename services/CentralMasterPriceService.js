const {getPrismaClient}=require('./prisma');

// Read numeric text directly from PostgreSQL JSON. Legacy master documents need
// no rewrite; rates never pass through JavaScript floating-point arithmetic.
async function resolvePrices(parts,dealerCode) {
  if(!parts.length)return new Map();
  const rows=await getPrismaClient().$queryRaw`WITH documents AS (
    SELECT id,data,"dealerCode","normalizedPartNumber","partNumber","updatedAt","createdAt",'MASTER_CATALOGUE' source,30 rank FROM mastercatalogues
    WHERE coalesce("dealerCode",'') IN ('','ALL',${dealerCode})
    UNION ALL
    SELECT id,data,"dealerCode","normalizedPartNumber","partNumber","updatedAt","createdAt",'MASTER_PART',10 FROM masterparts
    WHERE coalesce("dealerCode",'') IN ('','ALL',${dealerCode})
  ), normalized AS (
    SELECT *,regexp_replace(upper(coalesce(nullif("normalizedPartNumber",''),nullif("partNumber",''),data->>'partNo',data->>'part','')),'[[:space:]*-]','','g') part,
      coalesce(data->>'dlc',data->>'dlp',data->>'currentCatalogueDLC',data->>'currentCatalogueDlc',data->>'catalogueDLC',data->>'catalogueDlc') dlc_text,
      coalesce(data->>'mrp',data->>'currentCatalogueMRP',data->>'currentCatalogueMrp',data->>'rate',data->>'price') mrp_text,
      CASE WHEN coalesce(data->>'effectiveFrom','') ~ '^\\d{4}-\\d{2}-\\d{2}T' THEN (data->>'effectiveFrom')::timestamptz ELSE "updatedAt" END effective_at
    FROM documents
  ), rates AS (
    SELECT *,CASE WHEN regexp_replace(dlc_text,'[,[:space:]]','','g') ~ '^\\d+(\\.\\d+)?$' THEN regexp_replace(dlc_text,'[,[:space:]]','','g')::numeric END dlc,
      CASE WHEN regexp_replace(mrp_text,'[,[:space:]]','','g') ~ '^\\d+(\\.\\d+)?$' THEN regexp_replace(mrp_text,'[,[:space:]]','','g')::numeric END mrp
    FROM normalized WHERE part IN (SELECT jsonb_array_elements_text(${JSON.stringify(parts)}::jsonb)) AND effective_at<=now()
  ), d AS (
    SELECT DISTINCT ON(part) part,dlc,id,effective_at,source FROM rates WHERE dlc>0
    ORDER BY part,effective_at DESC,rank DESC,("dealerCode"=${dealerCode}) DESC,id
  ), m AS (
    SELECT DISTINCT ON(part) part,mrp,id,effective_at,source FROM rates WHERE mrp>0
    ORDER BY part,effective_at DESC,rank DESC,("dealerCode"=${dealerCode}) DESC,id
  ) SELECT coalesce(d.part,m.part) part,d.dlc::text dlc,m.mrp::text mrp,
    d.id dlc_version,m.id mrp_version,d.effective_at dlc_date,m.effective_at mrp_date,
    coalesce(d.source,m.source) source FROM d FULL JOIN m USING(part)`;
  return new Map(rows.map(r=>[r.part,r]));
}
module.exports={resolvePrices};
