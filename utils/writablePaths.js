const path = require('path');

// Installed customer data must never be written into Program Files. Preserve
// the existing development locations when no deployment data root is supplied.
function writablePath(...segments) {
  return path.resolve(process.env.DAKSH_DATA_ROOT || path.join(__dirname, '..'), ...segments);
}

module.exports = { writablePath };
