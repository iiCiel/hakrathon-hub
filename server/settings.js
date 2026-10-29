'use strict';
const { all, run } = require('./db');

// Defaults come straight from the HAkrathon 2026 Event Scope (Nov 6, 2026, Eastern time = UTC-5).
const D = '2026-11-06T';
const T = (hm) => `${D}${hm}:00-05:00`;

const LANES = [
  { id: 'student', name: 'Student experience & success', hint: 'Navigation, scheduling, advising, retention, collaboration, accessibility' },
  { id: 'learning', name: 'Learning & career readiness', hint: 'Skills practice, tutoring, business simulations, portfolios, interview prep' },
  { id: 'operations', name: 'College operations', hint: 'Rooms and resources, service requests, workflow automation, event operations' },
  { id: 'community', name: 'Business & community impact', hint: 'Small-business tools, entrepreneurship, customer experience, partner engagement' },
  { id: 'cyber', name: 'Cybersecurity & trusted data', hint: 'Awareness, privacy, identity, safe data use, fraud prevention, risk reporting' },
];

const CRITERIA = [
  { id: 'innovation', name: 'Innovation & Creativity', weight: 25, hint: 'Originality of the approach; meaningful differentiation; thoughtful use of technology rather than novelty alone.' },
  { id: 'impact', name: 'Problem / Potential Impact', weight: 25, hint: 'Clarity and importance of the College-connected problem; fit for the user; credible measurable benefit.' },
  { id: 'technical', name: 'Technical Implementation', weight: 25, hint: 'Working depth, architecture, integration, reliability, data handling, security/privacy thinking, original contribution.' },
  { id: 'usability', name: 'Usability & Practicality', weight: 15, hint: 'Ease of use, accessibility, feasibility, resource needs, maintainability, realistic path to implementation.' },
  { id: 'presentation', name: 'Final Presentation', weight: 10, hint: 'Clear, concise explanation; demo quality; evidence; response to questions; time limit.' },
];

const AWARDS = [
  { id: 'champion', name: 'HAkrathon Champion', hint: 'Highest final weighted score after finalist Q&A and verification.' },
  { id: 'ai', name: 'Best Use of AI', hint: 'Most purposeful, responsible, technically meaningful use of the approved AI environment.' },
  { id: 'creative', name: 'Most Creative', hint: 'Strongest innovation/creativity evidence.' },
  { id: 'practical', name: 'Most Practical', hint: 'Strongest combined usability, feasibility, and implementation path.' },
];

const SCHEDULE = [
  ['07:30', '08:00', 'Arrival & check-in', 'Scan in, badges, table assignments, Wi-Fi and account test, breakfast.'],
  ['08:00', '08:20', 'Welcome & rules', 'Purpose, common challenge, safety, tool rules, judging, deadlines, awards.'],
  ['08:20', '08:35', 'Challenge release', 'Detailed brief and solution lanes released. Questions answered publicly.'],
  ['08:35', '09:15', 'Team lock & ideation', 'Finalize roles, lane, user, problem. Rosters lock at 9:15.'],
  ['09:15', '10:00', 'Problem-definition sprint', 'Complete the problem canvas and initial plan with mentors.'],
  ['10:00', '10:00', 'Checkpoint 1', 'Roster, lane, one-sentence problem, target user, success measure, planned tech.'],
  ['10:00', '12:00', 'Build Sprint 1', 'Core architecture, data flow, proof of concept, first testable feature.'],
  ['12:00', '12:30', 'Working lunch', 'Teams stay at tables. Status reminder from staff.'],
  ['12:30', '15:00', 'Build Sprint 2', 'Working prototype, main user journey, sources, demo outline.'],
  ['15:00', '15:15', 'Checkpoint 2', 'Show a mentor the working core, report blockers, submit 3-bullet demo plan.'],
  ['15:15', '16:15', 'Final build & demo production', 'Finish essentials, final tests, one-page brief, record 5-minute demo.'],
  ['16:15', '16:30', 'Upload window', 'Upload all deliverables and verify judge access. No new features.'],
  ['16:30', '16:30', 'Build freeze', 'Code and content changes stop.'],
  ['16:30', '17:00', 'Validation & meal break', 'Staff check links, video length, disclosures, eligibility.'],
  ['17:00', '18:10', 'Primary judging', 'Judges review every recording and brief and score independently.'],
  ['18:10', '18:20', 'Tabulation', 'Scoring lead validates totals and identifies finalists.'],
  ['18:20', '18:50', 'Finalist Q&A', 'Top three: 2-minute recap + 6-minute live judge Q&A.'],
  ['18:50', '19:00', 'Final decision', 'Judges finalize Champion and specialty awards.'],
  ['19:00', '19:10', 'Awards', 'Specialty awards first, then the HAkrathon Champion.'],
  ['19:10', '19:30', 'Photos & close', 'Photos, sponsor recognition, survey, dismissal.'],
].map(([s, e, title, detail]) => ({ start: T(s), end: T(e), title, detail }));

// Food service (Event Scope §6): breakfast at check-in, working lunch, meal break during validation.
// Shown as a reminder in the top-right corner of every screen; staff can edit or add (e.g. snacks).
const MEALS = [
  ['07:30', '08:00', 'Breakfast', 'Breakfast is out at check-in.'],
  ['12:00', '12:30', 'Lunch', 'Working lunch: teams stay at their tables.'],
  ['16:30', '17:00', 'Dinner', 'Meal break while staff validate submissions.'],
].map(([s, e, title, detail]) => ({ start: T(s), end: T(e), title, detail }));

const DEFAULTS = {
  event_name: 'HAkrathon 2026',
  tagline: 'Build • Solve • Innovate',
  challenge: 'How might we use technology to measurably improve the College of Business experience, operations, learning, or impact for students, faculty, staff, employers, or community partners?',
  challenge_released: false,
  roster_lock_at: T('09:15'),
  cp1_at: T('10:00'),
  cp2_at: T('15:15'),
  upload_open_at: T('16:15'),
  build_freeze_at: T('16:30'),
  validation_end_at: T('17:00'),
  global_extension_minutes: 0,
  judging_open: false,
  finalists_open: false,
  results_published: false,
  registration_open: true,
  signup_open: true, // the public event registration form (before the event)
  max_teams: 10,
  team_min: 3,
  team_max: 5,
  participant_email_domains: 'uakron.edu,zips.uakron.edu',
  max_video_seconds: 300,
  lanes: LANES,
  criteria: CRITERIA,
  awards: AWARDS,
  schedule: SCHEDULE,
  meals: MEALS,
  one_prize_per_team: true,
  finalists: [],
  min_judges: 3,
  runner_enabled: true,
  is_demo: false,
  demo_shift_ms: 0, // demo only: how far event times were moved so "now" lands on a chosen event-day moment
  rehearsal: {}, // manual rehearsal checklist ticks: { id: { done, by, at } }
};

let cache = null;
function load() {
  const rows = all('SELECT key, value FROM settings');
  const out = { ...DEFAULTS };
  for (const r of rows) { try { out[r.key] = JSON.parse(r.value); } catch {} }
  cache = out;
  return out;
}
function getSettings() { return cache || load(); }
function setSettings(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) continue;
    run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
  }
  cache = null;
  return getSettings();
}

// Effective build freeze for a team: scheduled freeze + global extension + that team's extension.
function freezeAt(team) {
  const s = getSettings();
  const base = Date.parse(s.build_freeze_at);
  const ext = (Number(s.global_extension_minutes) || 0) + (Number(team && team.extension_minutes) || 0);
  return base + ext * 60000;
}
function isFrozen(team, now = Date.now()) { return now >= freezeAt(team); }
function rosterLocked(now = Date.now()) { return now >= Date.parse(getSettings().roster_lock_at); }

// Demo only: turn a stored/real time (ms) into the event-day time the demo pretends it is,
// so server-made text matches what the browser shows. On the real server the shift is never
// applied (is_demo is false), so this returns ms unchanged.
function displayMs(ms) {
  const s = getSettings();
  return s.is_demo ? ms - (Number(s.demo_shift_ms) || 0) : ms;
}

module.exports = { T, DEFAULTS, getSettings, setSettings, freezeAt, isFrozen, rosterLocked, displayMs };
