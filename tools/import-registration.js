'use strict';
// Import the Microsoft Forms registration spreadsheet (.xlsx) into the portal's registrations,
// so the people and teams show up in Admin > Registrations and Admin > Check-in.
//
//   node tools\import-registration.js "C:\path\HAkrathon 2026 Student Registration.xlsx" [--dry-run]
//
// Uses the same data folder as the server (DATA_DIR, default .\data). Safe to re-run with a newer file:
// people are matched by email and updated; check-ins, access codes and staff decisions are never touched,
// and nobody is deleted. Rows are grouped into teams by the blank rows between them in the sheet.
// The spreadsheet holds real student data: it stays outside the repo, and the import goes to the
// git-ignored data folder.
const fs = require('node:fs');
const { readXlsx } = require('./officefile');

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const file = args.find((a) => !a.startsWith('--'));
if (!file || !fs.existsSync(file)) {
  console.error('Usage: node tools\\import-registration.js "<registration .xlsx>" [--dry-run]');
  process.exit(file ? 2 : 1);
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_IN = /[^\s,;<>()]+@[^\s,;<>()]+\.[a-z]{2,}/gi;
const CLASS_LEVELS = ['Freshman', 'Sophomore', 'Junior', 'Senior', 'Graduate'];
const LANES = { 'student experience': 'student', 'learning': 'learning', 'college operations': 'operations', 'business & community': 'community', 'cybersecurity': 'cyber' };
const TECH_SKILLS = /programming|web or app|cyber|systems|automation|\bai\b|data analysis/i;
const NONE = /^(no|none|n\/?a|nope|-|nothing)\.?$/i;

const rows = readXlsx(file);
const header = (rows[0] || []).map((x) => String(x).trim().toLowerCase());
const col = (...keys) => { for (const k of keys) { const i = header.findIndex((h) => h === k || h.includes(k)); if (i >= 0) return i; } return -1; };
const C = {
  name: col('name'), fullName: col('full name'), formEmail: col('email'), email: col('student email'), major: col('major'), level: col('class level'),
  how: col('how are you registering'), team: col('team name'), mates: col('who is on your team'), skills: col('skills'), exp: col('experience'),
  lane: col('solution lane'), avail: col('available to participate'), food: col('food allergies', 'dietary'), access: col('accessibility', 'accommodation'),
  photo: col('photography'), agree: col('acknowledgment', 'agreement'),
};
if (C.name < 0 && C.fullName < 0) { console.error('This does not look like the registration sheet: no Name column in row 1.'); process.exit(2); }
const cell = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).replace(/\s+/g, ' ').trim() : '');

// Split into blocks at blank rows: one block = one team.
const blocks = [];
let cur = [];
for (const r of rows.slice(1)) {
  const name = cell(r, C.name) || cell(r, C.fullName);
  if (!name) { if (cur.length) blocks.push(cur); cur = []; continue; }
  cur.push(r);
}
if (cur.length) blocks.push(cur);

// "Team shark", "Shark", "Team Shark" -> "Team Shark" (the most common spelling, preferring capitals).
function teamName(block) {
  const names = block.map((r) => cell(r, C.team)).filter(Boolean);
  if (!names.length) return '';
  const key = (s) => s.toLowerCase().replace(/^team\s+/, '');
  const count = new Map();
  for (const n of names) count.set(key(n), (count.get(key(n)) || 0) + 1);
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const caps = (s) => (s.match(/[A-Z]/g) || []).length;
  return names.filter((n) => key(n) === best).sort((a, b) => caps(b) - caps(a))[0];
}
const clean = (s) => (NONE.test(s) ? '' : s);
const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');

const people = [];
const problems = [];
for (const block of blocks) {
  const team = teamName(block);
  const blockText = block.map((r) => cell(r, C.mates)).join(' ');
  for (const r of block) {
    const name = cell(r, C.name) || cell(r, C.fullName);
    const notRegistered = /haven.?t registered/i.test(cell(r, C.email)) || (!cell(r, C.agree) && !cell(r, C.major));
    // Email: the form's student email, else the Forms account email, else found next to their name in a teammate's list.
    let email = [cell(r, C.email), cell(r, C.formEmail)].find((e) => EMAIL_RE.test(e)) || '';
    if (!email) {
      const last = name.split(' ').pop().toLowerCase();
      const seg = blockText.split(',').find((s) => s.toLowerCase().includes(last) && EMAIL_IN.test(s));
      EMAIL_IN.lastIndex = 0;
      email = seg ? (seg.match(EMAIL_IN) || [''])[0] : '';
    }
    let noEmail = false;
    if (!email) { email = `${slug(name) || 'person'}@no-email.invalid`; noEmail = true; problems.push(`${name} (${team || 'no team'}): no email anywhere in the sheet; imported as ${email}.`); }
    const how = cell(r, C.how).toLowerCase();
    const level = CLASS_LEVELS.find((l) => l.toLowerCase() === cell(r, C.level).toLowerCase()) || '';
    const laneText = cell(r, C.lane).toLowerCase();
    const lane = Object.entries(LANES).find(([k]) => laneText.startsWith(k));
    const skills = cell(r, C.skills).split(';').map((x) => x.trim()).filter(Boolean).join(', ');
    const notes = [];
    if (notRegistered) notes.push('Did not fill in the form (listed with the team)');
    if (noEmail) notes.push('No email on file');
    if (/conflict/i.test(cell(r, C.avail))) notes.push('Scheduling conflict, wants to discuss');
    if (how.includes('individually')) notes.push('Matched into this team');
    if (/prefer not/i.test(cell(r, C.photo))) notes.push('No photos please');
    people.push({
      email: email.toLowerCase(), name: name.slice(0, 80), major: cell(r, C.major).slice(0, 80), class_level: level,
      team_mode: team ? 'team' : 'match', team_name: team.slice(0, 60), teammates: cell(r, C.mates).slice(0, 1000),
      lane: lane ? lane[1] : '', skills: skills.slice(0, 500), experience: cell(r, C.exp).slice(0, 1000),
      technical: TECH_SKILLS.test(skills) ? 1 : 0, dietary: clean(cell(r, C.food)).slice(0, 300), accommodations: clean(cell(r, C.access)).slice(0, 500),
      media_ok: /comfortable/i.test(cell(r, C.photo)) && !/not/i.test(cell(r, C.photo)) ? 1 : 0,
      staff_note: notes.length ? `From spreadsheet: ${notes.join('; ')}.` : '',
    });
  }
}
// Same email twice in the file: keep the later row.
const byEmail = new Map(people.map((p) => [p.email, p]));
if (byEmail.size < people.length) problems.push(`${people.length - byEmail.size} duplicate email(s) in the file; the later row was used.`);

const teams = new Map();
for (const p of byEmail.values()) { const k = p.team_name || '(needs a team)'; teams.set(k, (teams.get(k) || 0) + 1); }
console.log(`Read ${byEmail.size} people in ${teams.size} groups from ${file}`);
for (const [t, n] of teams) console.log(`  ${t}: ${n}`);
for (const p of problems) console.log(`  Note: ${p}`);
if (dry) { console.log('Dry run: nothing written.'); process.exit(0); }

const { get, run, tx, audit, DATA_DIR } = require('../server/db');
const stamp = new Date().toISOString();
let added = 0, updated = 0;
tx(() => {
  for (const p of byEmail.values()) {
    const old = get('SELECT * FROM registrations WHERE email = ?', p.email);
    if (!old) {
      run(`INSERT INTO registrations (email, name, major, class_level, team_mode, team_name, teammates, lane, skills, experience, technical,
        dietary, accommodations, media_ok, status, staff_note, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      p.email, p.name, p.major, p.class_level, p.team_mode, p.team_name, p.teammates, p.lane, p.skills, p.experience, p.technical,
      p.dietary, p.accommodations, p.media_ok, 'confirmed', p.staff_note, stamp);
      added++;
    } else {
      // Keep check-in, access code and anything staff decided (status other than pending, their own notes).
      const status = old.status === 'pending' ? 'confirmed' : old.status;
      const note = !old.staff_note || old.staff_note.startsWith('From spreadsheet') ? p.staff_note : old.staff_note;
      run(`UPDATE registrations SET name = ?, major = ?, class_level = ?, team_mode = ?, team_name = ?, teammates = ?, lane = ?, skills = ?, experience = ?,
        technical = ?, dietary = ?, accommodations = ?, media_ok = ?, status = ?, staff_note = ?, updated_at = ? WHERE id = ?`,
      p.name, p.major || old.major, p.class_level || old.class_level, p.team_mode, p.team_name, p.teammates, p.lane || old.lane, p.skills || old.skills, p.experience || old.experience,
      p.technical, p.dietary, p.accommodations, p.media_ok, status, note, stamp, old.id);
      updated++;
    }
  }
  audit(null, 'registration.import', { added, updated });
});
console.log(`Done: ${added} added, ${updated} updated, in ${DATA_DIR}. Open Admin > Check-in (reload the page if it is open).`);
