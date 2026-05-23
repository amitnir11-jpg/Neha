const IST_TIME_ZONE = 'Asia/Kolkata';
const IST_FORMAT_LOCALE = 'en-IN';

function validDate(value) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}:\d{2}\s+(AM|PM)$/i.test(value.trim())) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatIstDateTime(value) {
  const date = validDate(value);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat(IST_FORMAT_LOCALE, {
    timeZone: IST_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  return `${parts.day}-${parts.month}-${parts.year} ${parts.hour}:${parts.minute}:${parts.second} ${String(parts.dayPeriod || '').toUpperCase()}`;
}

function dateDebugPayload({ serverTime = new Date(), mobileTime = '', savedTime = null } = {}) {
  const serverDate = validDate(serverTime) || new Date();
  const mobileDate = validDate(mobileTime);
  const savedDate = validDate(savedTime);
  return {
    serverUtcTime: serverDate.toISOString(),
    convertedIstTime: formatIstDateTime(serverDate),
    mobileReceivedTime: mobileTime || '',
    mobileReceivedTimeUtc: mobileDate ? mobileDate.toISOString() : '',
    savedMongoTimestamp: savedDate ? savedDate.toISOString() : ''
  };
}

function isDateLikeKey(key = '') {
  return /date|time|timestamp|createdAt|updatedAt|printedAt|transferredAt|generatedAt/i.test(String(key));
}

function formatDateLikeFields(row = {}) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    isDateLikeKey(key) && value ? formatIstDateTime(value) || value : value
  ]));
}

module.exports = {
  IST_TIME_ZONE,
  formatDateLikeFields,
  formatIstDateTime,
  dateDebugPayload,
  isDateLikeKey,
  validDate
};
