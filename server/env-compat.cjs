'use strict';
// Settings written for earlier names keep working: PRISM_* and MARSAD_* variables are copied to
// RUBBAN_* unless the new name is already set (MARSAD_* wins over PRISM_*).
const LEGACY_PREFIXES = ['MARSAD_', 'PRISM_'];
for (const prefix of LEGACY_PREFIXES) {
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(prefix)) continue;
    const renamed = `RUBBAN_${key.slice(prefix.length)}`;
    if (process.env[renamed] === undefined) process.env[renamed] = value;
  }
}
module.exports = { LEGACY_PREFIXES };
