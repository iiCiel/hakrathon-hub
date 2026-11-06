'use strict';
// tools/import-registration.js on a small made-up sheet: blank rows split teams, team spellings merge,
// missing emails come from a teammate's list, and re-importing keeps check-ins.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const AdmZip = require('adm-zip');

const ROOT = path.join(__dirname, '..');
const HEAD = ['ID', 'Email', 'Name', 'Last modified time', 'What is your full name?', 'What is your University of Akron student email address?', 'What is your major or academic program?', 'What is your class level?', 'How are you registering?', 'What is your team name?', 'Who is on your team?', 'Which skills can you contribute to your team?', 'Briefly describe your relevant project or build experience.', 'Which solution lane are you most interested in?', 'Are you available to participate on November 6, from 7:30 a.m. to 7:30 p.m.?', 'Do you have any food allergies or dietary restrictions we should plan for?', 'Are there any accessibility arrangements or accommodations that would help you participate?', 'What is your preference regarding event photography and promotional videos?', 'Participant acknowledgment and agreement'];
const row = (o) => HEAD.map((_, i) => o[i] ?? '');
const ROWS = [HEAD,
  row({ 1: 'aa1@uakron.edu', 2: 'Ann Able', 5: 'aa1@uakron.edu', 6: 'CS', 7: 'Junior', 9: 'Team shark ', 10: 'Ann, Bo Bell - bb2@uakron.edu', 11: 'Programming;', 13: 'Cybersecurity & trusted data', 15: 'No', 17: 'I am comfortable being featured', 18: 'I understand and agree.' }),
  row({ 2: 'Bo Bell', 5: "Haven't registered yet", 9: 'Shark' }),
  row({ 2: 'Cy Cole', 5: 'cc3@uakron.edu', 6: 'MBA', 9: 'Team Shark', 15: 'Vegetarian', 18: 'I understand and agree.' }),
  [],
  row({ 2: 'Di Dunn', 5: 'dd4@uakron.edu', 6: 'IS', 9: 'Team B', 18: 'I understand and agree.' }),
];
function xlsx(file, rows) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const col = (i) => String.fromCharCode(65 + (i % 26)).padStart(i >= 26 ? 2 : 1, 'A');
  const data = rows.map((r, i) => `<row r="${i + 1}">${r.map((v, j) => (v === '' ? '' : `<c r="${col(j)}${i + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)).join('')}</row>`).join('');
  const z = new AdmZip();
  z.addFile('xl/workbook.xml', Buffer.from('<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>'));
  z.addFile('xl/_rels/workbook.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'));
  z.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<worksheet><sheetData>${data}</sheetData></worksheet>`));
  z.writeZip(file);
}

test('registration import groups teams and keeps check-ins on re-import', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hak-import-'));
  try {
    const file = path.join(dir, 'reg.xlsx');
    xlsx(file, ROWS);
    const env = { ...process.env, DATA_DIR: path.join(dir, 'data') };
    const imp = () => execFileSync(process.execPath, [path.join(ROOT, 'tools', 'import-registration.js'), file], { env, encoding: 'utf8' });
    assert.match(imp(), /4 added, 0 updated/);
    const q = (sql) => JSON.parse(execFileSync(process.execPath, ['-e', `const {all}=require(${JSON.stringify(path.join(ROOT, 'server', 'db'))});console.log(JSON.stringify(all(${JSON.stringify(sql)})))`], { env, encoding: 'utf8' }));
    const regs = q('SELECT email, name, team_name, team_mode, status, dietary FROM registrations ORDER BY email');
    assert.deepStrictEqual(regs.map((r) => [r.email, r.team_name]), [['aa1@uakron.edu', 'Team Shark'], ['bb2@uakron.edu', 'Team Shark'], ['cc3@uakron.edu', 'Team Shark'], ['dd4@uakron.edu', 'Team B']]);
    assert.ok(regs.every((r) => r.status === 'confirmed' && r.team_mode === 'team'));
    assert.strictEqual(regs.find((r) => r.email === 'aa1@uakron.edu').dietary, ''); // "No" means none
    q("UPDATE registrations SET checked_in_at = '2026-11-06T12:00:00Z', invite_code = 'PAR-KEEP' WHERE email = 'cc3@uakron.edu' RETURNING id");
    assert.match(imp(), /0 added, 4 updated/);
    const kept = q("SELECT checked_in_at, invite_code FROM registrations WHERE email = 'cc3@uakron.edu'")[0];
    assert.deepStrictEqual(kept, { checked_in_at: '2026-11-06T12:00:00Z', invite_code: 'PAR-KEEP' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
