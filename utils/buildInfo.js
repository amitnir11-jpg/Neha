const fs = require('fs');
const path = require('path');

function readBuildInfo() {
  let value;
  try { value = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build-info.json'), 'utf8')); }
  catch (_) { value = require('../version.json'); }
  // Only public release identifiers are exposed; never return arbitrary config.
  return Object.fromEntries(['product', 'version', 'appVersion', 'build', 'buildDate', 'databaseSchema', 'latestMigration', 'sourceHash', 'gitCommit', 'nodeVersion', 'postgresqlVersion']
    .filter(key => value[key] !== undefined).map(key => [key, value[key]]));
}

module.exports = { readBuildInfo };
