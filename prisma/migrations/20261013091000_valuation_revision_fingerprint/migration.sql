-- Include every committed event, including transactions that commit out of sequence.
ALTER TABLE valuation_snapshots ALTER COLUMN revision TYPE TEXT USING revision::text;
