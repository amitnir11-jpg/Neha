const assert = require('assert');
const fs = require('fs');
const ExcelJS = require('exceljs');
const MasterCatalogue = require('../models/MasterCatalogue');
const MasterPart = require('../models/MasterPart');
const PartPriceHistory = require('../models/PartPriceHistory');
const { CATALOGUE_COLUMNS, createCatalogueTemplateWorkbook, failureFilePath, importCatalogue, parseCatalogueUpload } = require('../utils/catalogueUpload');
const { findCataloguePart } = require('../utils/catalogue');
const { normalizePartNumber } = require('../utils/normalize');

const catalogue = new Map([
  ['PART00001', { normalizedPartNumber: 'PART00001', partNumber: 'PART00001', partDescription: 'OLD DESCRIPTION' }]
]);
const prices = new Map();

function queryResult(rows) {
  return {
    select() { return this; },
    lean() { return Promise.resolve(rows); }
  };
}

MasterCatalogue.find = (filter = {}) => {
  const requested = new Set(filter.normalizedPartNumber && filter.normalizedPartNumber.$in || []);
  return queryResult(Array.from(catalogue.values()).filter((row) => requested.has(row.normalizedPartNumber)));
};
MasterCatalogue.bulkWrite = async (operations) => {
  operations.forEach(({ updateOne }) => {
    const part = updateOne.filter.normalizedPartNumber;
    catalogue.set(part, { ...(catalogue.get(part) || {}), ...updateOne.update.$set });
  });
};
MasterCatalogue.updateOne = async (filter, update) => {
  catalogue.set(filter.normalizedPartNumber, { ...(catalogue.get(filter.normalizedPartNumber) || {}), ...update.$set });
};
MasterCatalogue.countDocuments = async () => catalogue.size;
MasterCatalogue.deleteMany = async () => {
  const deletedCount = catalogue.size;
  catalogue.clear();
  return { deletedCount };
};

PartPriceHistory.bulkWrite = async (operations) => {
  operations.forEach(({ updateOne }) => prices.set(updateOne.filter.normalizedPartNumber, updateOne.update.$set));
};
PartPriceHistory.updateOne = async (filter, update) => prices.set(filter.normalizedPartNumber, update.$set);
PartPriceHistory.deleteMany = async () => {
  const deletedCount = prices.size;
  prices.clear();
  return { deletedCount };
};

async function fullMasterBuffer() {
  const workbook = await createCatalogueTemplateWorkbook();
  const sheet = workbook.getWorksheet('Part Master Template');
  for (let index = 1; index <= 5000; index += 1) {
    sheet.addRow({
      partNumber: `PART-${String(index).padStart(5, '0')}`,
      partDescription: `Part description ${index}`,
      activeFlag: index % 2 ? 'Y' : 'N',
      productCategory: 'FILTERS',
      productGroup: 'ENGINE',
      partSubGroup: 'SUBGROUP A',
      model: `MODEL ${index % 10}`,
      manufacturingYear: '2024',
      productType: 'SPARE',
      mrp: 100 + index,
      dlc: 70 + index
    });
  }
  sheet.addRow({
    partNumber: 'PART-00001',
    partDescription: 'Duplicate row',
    activeFlag: 'Y',
    productCategory: 'FILTERS',
    productGroup: 'ENGINE',
    partSubGroup: 'SUBGROUP A',
    model: 'MODEL 1',
    manufacturingYear: '2024',
    productType: 'SPARE',
    mrp: 100,
    dlc: 70
  });
  sheet.addRow({
    partDescription: 'Missing part',
    activeFlag: 'Y',
    productCategory: 'FILTERS',
    productGroup: 'ENGINE',
    partSubGroup: 'SUBGROUP A',
    model: 'MODEL 1',
    manufacturingYear: '2024',
    productType: 'SPARE',
    mrp: 100,
    dlc: 70
  });
  sheet.addRow({
    partNumber: 'PART-MISSING-DESC',
    activeFlag: 'Y',
    productCategory: 'FILTERS',
    productGroup: 'ENGINE',
    partSubGroup: 'SUBGROUP A',
    model: 'MODEL 1',
    manufacturingYear: '2024',
    productType: 'SPARE',
    mrp: 100,
    dlc: 70
  });
  sheet.addRow({
    partNumber: 'PART-BAD-MRP',
    partDescription: 'Bad MRP',
    activeFlag: 'Y',
    productCategory: 'FILTERS',
    productGroup: 'ENGINE',
    partSubGroup: 'SUBGROUP A',
    model: 'MODEL 1',
    manufacturingYear: '2024',
    productType: 'SPARE',
    mrp: 'ABC',
    dlc: 70
  });
  sheet.addRow({
    partNumber: 'PART-BAD-DLC',
    partDescription: 'Bad DLC',
    activeFlag: 'Y',
    productCategory: 'FILTERS',
    productGroup: 'ENGINE',
    partSubGroup: 'SUBGROUP A',
    model: 'MODEL 1',
    manufacturingYear: '2024',
    productType: 'SPARE',
    mrp: 100,
    dlc: 'XYZ'
  });
  sheet.addRow([]);
  sheet.addRow({
    partNumber: 'PART-LAST',
    partDescription: 'Last valid row',
    activeFlag: 'Y',
    productCategory: 'FILTERS',
    productGroup: 'ENGINE',
    partSubGroup: 'SUBGROUP A',
    model: 'MODEL 9',
    manufacturingYear: '2024',
    productType: 'SPARE',
    mrp: 125,
    dlc: 75
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function incompleteMasterBuffer() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Incomplete');
  sheet.addRow(['Part Number', 'Part Description', 'MRP']);
  sheet.addRow(['P1', 'Part 1', 10]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function run() {
  const buffer = await fullMasterBuffer();
  const file = {
    originalname: 'full-master.xlsx',
    mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: buffer.length,
    buffer
  };
  const parsed = await parseCatalogueUpload(file);
  assert.equal(parsed.rows.length, 5007);

  const result = await importCatalogue(file);
  assert.deepEqual(
    {
      fileRows: result.fileRowsCount,
      total: result.totalRowsCount,
      imported: result.importedRowsCount,
      saved: result.savedRowsCount,
      failed: result.failedRowsCount,
      duplicates: result.duplicateRowsCount,
      blankRows: result.blankRowsCount,
      missingMandatory: result.missingMandatoryFieldsCount,
      accountingGap: result.accountingGapCount,
      inserted: result.insertedRowsCount,
      updated: result.updatedRowsCount,
      current: result.currentMasterRecordCount,
      finalCount: result.finalMasterRecordCount,
      mismatch: result.rowCountMismatch
    },
    { fileRows: 5007, total: 5007, imported: 5001, saved: 5001, failed: 5, duplicates: 1, blankRows: 1, missingMandatory: 3, accountingGap: 0, inserted: 5000, updated: 1, current: 5001, finalCount: 5001, mismatch: true }
  );
  assert.deepEqual(result.failureReasons, {
    'Missing Part Number': 1,
    'Blank mandatory fields': 2,
    'Invalid MRP/DLC': 2,
    'Duplicate conflict': 1
  });
  assert.equal(normalizePartNumber('  part\u200b-00001  '), 'PART00001');

  const failedWorkbookPath = failureFilePath(result.failureDownloadId);
  assert.ok(fs.existsSync(failedWorkbookPath));
  const failedWorkbook = new ExcelJS.Workbook();
  await failedWorkbook.xlsx.readFile(failedWorkbookPath);
  const failedSheet = failedWorkbook.getWorksheet('Failed Rows');
  assert.equal(failedSheet.rowCount, 7);
  assert.equal(failedSheet.getRow(1).getCell(failedSheet.columnCount).value, 'Error Reason');

  const saved = catalogue.get('PART00001');
  assert.equal(saved.partDescription, 'PART DESCRIPTION 1');
  assert.equal(saved.productCategory, 'FILTERS');
  assert.equal(saved.productGroup, 'ENGINE');
  assert.equal(saved.mrp, 101);
  assert.equal(saved.dlc, 71);
  assert.equal(saved.activeFlag, 'Y');
  assert.equal(saved.splitFlag, '');

  MasterCatalogue.findOne = () => ({ lean: () => Promise.resolve(saved) });
  MasterPart.findOne = () => ({ lean: () => Promise.resolve(null) });
  const lookup = await findCataloguePart('PART-00001');
  assert.deepEqual(
    { mrp: lookup.mrp, dlc: lookup.dlc, category: lookup.productCategory, productGroup: lookup.productGroup },
    { mrp: 101, dlc: 71, category: 'Filters', productGroup: 'ENGINE' }
  );

  const recordsBeforeBlockedReplace = catalogue.size;
  const blockedReplace = await importCatalogue(file, { replaceExisting: true, rejectOnValidationIssues: true });
  assert.equal(blockedReplace.blocked, true);
  assert.equal(catalogue.size, recordsBeforeBlockedReplace);
  assert.equal(blockedReplace.rowCountMismatch, true);

  const incompleteBuffer = await incompleteMasterBuffer();
  await assert.rejects(
    () => parseCatalogueUpload({ originalname: 'incomplete.xlsx', size: incompleteBuffer.length, buffer: incompleteBuffer }),
    (error) => error.statusCode === 400 && error.missingColumns.includes('DLP')
  );

  fs.unlinkSync(failedWorkbookPath);
  fs.unlinkSync(failureFilePath(blockedReplace.failureDownloadId));
  process.stdout.write(`Catalogue upload check passed (${result.totalRowsCount} source rows, ${result.importedRowsCount} imported).\n`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
