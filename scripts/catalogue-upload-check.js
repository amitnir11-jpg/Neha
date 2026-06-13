const assert = require('assert');
const fs = require('fs');
const ExcelJS = require('exceljs');
const MasterCatalogue = require('../models/MasterCatalogue');
const MasterPart = require('../models/MasterPart');
const PartPriceHistory = require('../models/PartPriceHistory');
const { CATALOGUE_COLUMNS, failureFilePath, importCatalogue, parseCatalogueUpload } = require('../utils/catalogueUpload');
const { findCataloguePart } = require('../utils/catalogue');

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
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Full Master');
  sheet.addRow(CATALOGUE_COLUMNS.map((column) => `  ${column.header}  `));
  for (let index = 1; index <= 5000; index += 1) {
    sheet.addRow([
      `PART-${String(index).padStart(5, '0')}`,
      `Part description ${index}`,
      index % 2 ? 'Y' : 'N',
      'FILTERS',
      'ENGINE',
      `MODEL ${index % 10}`,
      'SPARE',
      '',
      'GROUP A',
      'SUBGROUP A',
      '18%',
      index % 2 ? 'NO' : 'YES',
      100 + index,
      70 + index
    ]);
  }
  sheet.addRow(['PART-00001', 'Duplicate row', 'Y', 'FILTERS', 'ENGINE', 'MODEL', 'SPARE', '', 'GROUP A', 'SUBGROUP A', '18%', 'NO', 100, 70]);
  sheet.addRow(['', 'Missing part', 'Y', 'FILTERS', 'ENGINE', 'MODEL', 'SPARE', '', 'GROUP A', 'SUBGROUP A', '18%', 'NO', 100, 70]);
  sheet.addRow(['PART-MISSING-DESC', '', 'Y', 'FILTERS', 'ENGINE', 'MODEL', 'SPARE', '', 'GROUP A', 'SUBGROUP A', '18%', 'NO', 100, 70]);
  sheet.addRow(['PART-BAD-MRP', 'Bad MRP', 'Y', 'FILTERS', 'ENGINE', 'MODEL', 'SPARE', '', 'GROUP A', 'SUBGROUP A', '18%', 'NO', 'ABC', 70]);
  sheet.addRow(['PART-BAD-DLC', 'Bad DLC', 'Y', 'FILTERS', 'ENGINE', 'MODEL', 'SPARE', '', 'GROUP A', 'SUBGROUP A', '18%', 'NO', 100, 'XYZ']);
  sheet.addRow([]);
  sheet.addRow(['PART-LAST', 'Last valid row', 'Y', 'FILTERS', 'ENGINE', 'MODEL', 'SPARE', '', 'GROUP A', 'SUBGROUP A', '18%', 'NO', 125, 75]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function incompleteMasterBuffer() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Incomplete');
  sheet.addRow(['Part Number', 'Part Description', 'MRP', 'DLC']);
  sheet.addRow(['P1', 'Part 1', 10, 5]);
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
      total: result.totalRowsCount,
      imported: result.importedRowsCount,
      failed: result.failedRowsCount,
      duplicates: result.duplicateRowsCount,
      skipped: result.skippedRowsCount,
      missingMandatory: result.missingMandatoryFieldsCount,
      inserted: result.insertedRowsCount,
      updated: result.updatedRowsCount,
      current: result.currentMasterRecordCount
    },
    { total: 5007, imported: 5001, failed: 4, duplicates: 1, skipped: 1, missingMandatory: 2, inserted: 5000, updated: 1, current: 5001 }
  );

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
  assert.equal(saved.splitFlag, 'NO');

  MasterCatalogue.findOne = () => ({ lean: () => Promise.resolve(saved) });
  MasterPart.findOne = () => ({ lean: () => Promise.resolve(null) });
  const lookup = await findCataloguePart('PART-00001');
  assert.deepEqual(
    { mrp: lookup.mrp, dlc: lookup.dlc, category: lookup.productCategory, productGroup: lookup.productGroup },
    { mrp: 101, dlc: 71, category: 'FILTERS', productGroup: 'ENGINE' }
  );

  const recordsBeforeBlockedReplace = catalogue.size;
  const blockedReplace = await importCatalogue(file, { replaceExisting: true, rejectOnValidationIssues: true });
  assert.equal(blockedReplace.blocked, true);
  assert.equal(catalogue.size, recordsBeforeBlockedReplace);

  const incompleteBuffer = await incompleteMasterBuffer();
  await assert.rejects(
    () => parseCatalogueUpload({ originalname: 'incomplete.xlsx', size: incompleteBuffer.length, buffer: incompleteBuffer }),
    (error) => error.statusCode === 400 && error.missingColumns.includes('Active Flag') && error.missingColumns.includes('Split Flag')
  );

  fs.unlinkSync(failedWorkbookPath);
  fs.unlinkSync(failureFilePath(blockedReplace.failureDownloadId));
  process.stdout.write(`Catalogue upload check passed (${result.totalRowsCount} source rows, ${result.importedRowsCount} imported).\n`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
