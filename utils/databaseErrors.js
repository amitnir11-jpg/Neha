function isDatabaseConnectionError(error) {
  const code = error && (error.code || error.errorCode);
  return ['P1001', 'P1002', 'P1017'].includes(code)
    || /can't reach database server|server has closed the connection/i.test(String(error && error.message || ''));
}

const DATABASE_UNAVAILABLE_MESSAGE = 'The application database is temporarily unavailable. Please try logging in again shortly.';

module.exports = { isDatabaseConnectionError, DATABASE_UNAVAILABLE_MESSAGE };
