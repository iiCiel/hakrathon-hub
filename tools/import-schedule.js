'use strict';
// Import the organizer schedule (.docx) for Admin > Staff schedule (organizers only; students never see it).
//
//   node tools\import-schedule.js "C:\path\HAkrathon_2026_Organizer_Schedule.docx" [--dry-run]
//
// Each numbered heading ("2  Event timeline and assignments") starts a section; its tables and notes follow.
// Saved as staff-schedule.json in the server's data folder (DATA_DIR, default .\data; git-ignored).
// Re-run with a newer file at any time; the page shows the new version on its next load. No restart needed.
const fs = require('node:fs');
const path = require('node:path');
const { readDocx } = require('./officefile');

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const file = args.find((a) => !a.startsWith('--'));
if (!file || !fs.existsSync(file)) {
  console.error('Usage: node tools\\import-schedule.js "<organizer schedule .docx>" [--dry-run]');
  process.exit(file ? 2 : 1);
}

const blocks = readDocx(file);
const HEADING = /^(\d{1,2})\s+(\S.*)$/;
const out = { title: '', intro: [], sections: [], source: path.basename(file), imported_at: new Date().toISOString() };
let sec = null;
for (const b of blocks) {
  if (b.type === 'p') {
    const m = b.text.match(HEADING);
    if (m && b.text.length < 80) { sec = { title: m[2].trim(), tables: [], notes: [] }; out.sections.push(sec); continue; }
    if (!sec) { if (!out.title && /schedule/i.test(b.text)) out.title = b.text; else out.intro.push(b.text); continue; }
    sec.notes.push(b.text);
  } else if (b.rows.length) {
    if (!sec) { sec = { title: 'Schedule', tables: [], notes: [] }; out.sections.push(sec); }
    const [head, ...rows] = b.rows;
    sec.tables.push({ headers: head, rows });
  }
}
if (!out.sections.some((s) => s.tables.length)) { console.error('No tables found in this .docx; nothing imported.'); process.exit(2); }
for (const s of out.sections) console.log(`  ${s.title}: ${s.tables.map((t) => `${t.rows.length} rows`).join(', ') || 'notes only'}`);
if (dry) { console.log('Dry run: nothing written.'); process.exit(0); }

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const dest = path.join(DATA_DIR, 'staff-schedule.json');
fs.writeFileSync(`${dest}.tmp`, JSON.stringify(out, null, 1));
fs.renameSync(`${dest}.tmp`, dest);
console.log(`Done: ${out.sections.length} sections saved to ${dest}. Open Admin > Staff schedule.`);
