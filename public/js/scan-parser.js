(function (global) {
  function clean(value) {
    return String(value === undefined || value === null ? '' : value).trim();
  }

  function normalizePartToken(value) {
    return clean(value).replace(/\s+/g, '').toUpperCase();
  }

  function parseScanValue(rawValue) {
    const raw = clean(rawValue);
    if (!raw) {
      return {
        success: false,
        reason: 'EMPTY_SCAN',
        type: 'EMPTY',
        rawUpi: null,
        partNumber: '',
        rawScan: raw,
        fields: []
      };
    }

    const fields = raw.split('/').map((field) => field.trim());
    const isUpi = fields.length >= 8
      && fields[0].toUpperCase() === 'D'
      && Boolean(fields[4] && fields[4].trim());

    if (isUpi) {
      const partNumber = normalizePartToken(fields[4]);
      return {
        success: true,
        type: 'UPI',
        rawUpi: raw,
        partNumber,
        rawScan: raw,
        fields,
        upiId: fields[1] ? fields[1].trim().toUpperCase() : '',
        qty: undefined,
        mrp: undefined
      };
    }

    return {
      success: true,
      type: 'NORMAL_BARCODE',
      rawUpi: null,
      partNumber: normalizePartToken(raw),
      rawScan: raw,
      fields,
      upiId: '',
      qty: undefined,
      mrp: undefined
    };
  }

  const api = { clean, normalizePartToken, parseScanValue };
  global.DakshScanParser = api;
  global.scanParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
