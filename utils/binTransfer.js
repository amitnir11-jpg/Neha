const BLANK_MARKERS = new Set(['', 'NULL', 'UNDEFINED', 'N/A', 'NA', '-']);

function firstNonBlankValue(row = {}, fields = []) {
  for (const field of fields) {
    const value = String(row[field] || '').trim();
    if (value && !BLANK_MARKERS.has(value.toUpperCase())) return value;
  }
  return '';
}

module.exports = { firstNonBlankValue };
