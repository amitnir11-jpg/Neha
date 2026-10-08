const Bin = require('../models/Bin');
const { withDatabaseTransaction } = require('./prisma');

function normalizeBin(value) {
  return String(value || '').trim().toUpperCase();
}

async function ensureActiveDealerBin(dealerCode, binLocation, dependencies = {}) {
  const BinModel = dependencies.Bin || Bin;
  const runTransaction = dependencies.withDatabaseTransaction || withDatabaseTransaction;
  const dealer = String(dealerCode || '').trim().toUpperCase();
  const binCode = normalizeBin(binLocation);
  if (!dealer || !binCode) throw new Error('Dealer code and bin location are required.');

  try {
    return await runTransaction(async () => {
      let bin = await BinModel.findOne({ dealerCode: dealer, binCode }).lean();
      if (bin?.active === false) {
        bin = await BinModel.findOneAndUpdate({ dealerCode: dealer, binCode }, {
          $set: { active: true, binName: bin.binName || binCode }
        }, { new: true }).lean();
        return { bin, created: false, reactivated: true };
      }
      if (bin) return { bin, created: false, reactivated: false };

      bin = await BinModel.create({ dealerCode: dealer, binCode, binName: binCode, active: true });
      return { bin, created: true, reactivated: false };
    });
  } catch (error) {
    // A concurrent scanner can win the unique dealer/bin insert. Re-read and
    // accept the winner; propagate real database failures instead of disguising
    // them as an invalid-bin validation error.
    const existing = await BinModel.findOne({ dealerCode: dealer, binCode }).lean();
    if (!existing) throw error;
    if (existing.active === false) {
      const bin = await BinModel.findOneAndUpdate({ dealerCode: dealer, binCode }, {
        $set: { active: true, binName: existing.binName || binCode }
      }, { new: true }).lean();
      return { bin, created: false, reactivated: true };
    }
    return { bin: existing, created: false, reactivated: false };
  }
}

module.exports = { ensureActiveDealerBin, normalizeBin };
