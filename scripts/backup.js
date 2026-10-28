'use strict';
// Safe copy of the live database (works while the portal is running).
const path = require('node:path');
const fs = require('node:fs');
const { db, DATA_DIR } = require('../server/db');
const dir = path.join(DATA_DIR, 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = path.join(dir, `hakrathon-${stamp}.db`);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
console.log(`Backup written: ${file}`);
console.log('Uploaded videos and code live in data/uploads and data/source; copy the whole data folder for a full backup.');
