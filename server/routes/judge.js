'use strict';
const express = require('express');
const { get, all, run, audit } = require('../db');
const A = require('../auth');
const S = require('../settings');
const { teamOr404 } = require('./workspace');
const { completeness, subRow } = require('./submit');
const { getCheckpoints } = require('./core');
const { wrap, str, int, now, bus, HttpError } = require('../util');

const r = express.Router();
const CRIT = ['innovation', 'impact', 'technical', 'usability', 'presentation'];
const ANCHORS = [
  { range: '1–2', text: 'Little evidence; major requirement absent or not credible' },
  { range: '3–4', text: 'Partial evidence; concept is understandable but weakly executed' },
  { range: '5–6', text: 'Competent and complete at a basic level; meaningful limitations remain' },
  { range: '7–8', text: 'Strong, convincing work with a functioning solution and good evidence' },
  { range: '9–10', text: 'Exceptional for the event window; unusually strong execution, insight, and proof' },
];

const weights = () => Object.fromEntries(S.getSettings().criteria.map((c) => [c.id, c.weight]));
// Finalist Q&A may only adjust Technical Implementation and Final Presentation (scope §6).
function effective(sc) {
  return { innovation: sc.innovation, impact: sc.impact, usability: sc.usability,
    technical: sc.adj_technical ?? sc.technical, presentation: sc.adj_presentation ?? sc.presentation };
}
function weightedTotal(sc) {
  const w = weights(), e = effective(sc);
  return CRIT.reduce((sum, k) => sum + (e[k] / 10) * (w[k] || 0), 0);
}
const round2 = (n) => Math.round(n * 100) / 100;

function tabulate() {
  const st = S.getSettings();
  const teams = all('SELECT * FROM teams ORDER BY id');
  const judges = all("SELECT id, name FROM users WHERE role = 'judge' AND disabled = 0 ORDER BY name");
  const conflicts = all('SELECT judge_id, team_id, reason FROM conflicts');
  const isConf = (j, t) => conflicts.some((c) => c.judge_id === j && c.team_id === t);
  const scores = all('SELECT s.*, u.name AS judge_name FROM scores s JOIN users u ON u.id = s.judge_id');
  const rows = teams.map((t) => {
    const cards = scores.filter((s) => s.team_id === t.id);
    const valid = cards.filter((s) => s.submitted && !s.excluded && !isConf(s.judge_id, t.id) && CRIT.every((k) => s[k] != null));
    const totals = valid.map((s) => ({ judge_id: s.judge_id, judge: s.judge_name, total: round2(weightedTotal(s)), adjusted: s.adj_technical != null || s.adj_presentation != null }));
    const avg = totals.length ? totals.reduce((a, b) => a + b.total, 0) / totals.length : null;
    const crit = {};
    for (const k of CRIT) crit[k] = valid.length ? round2(valid.reduce((a, s) => a + effective(s)[k], 0) / valid.length) : null;
    const flags = [];
    if (valid.length < (st.min_judges || 3)) flags.push(`Only ${valid.length} valid scorecard${valid.length === 1 ? '' : 's'} (minimum ${st.min_judges || 3})`);
    if (avg != null && totals.length >= 3) for (const x of totals) if (Math.abs(x.total - avg) >= 20) flags.push(`Outlier: ${x.judge} (${x.total} vs avg ${round2(avg)})`);
    const pending = judges.filter((j) => !isConf(j.id, t.id) && !valid.some((v) => v.judge_id === j.id)).map((j) => j.name);
    const s = subRow(t.id);
    const comp = completeness(t, s, getCheckpoints(t.id));
    if (!comp.complete) flags.push('Submission package incomplete');
    const val = get('SELECT * FROM validations WHERE team_id = ?', t.id);
    const validated = !!(val && val.links_ok && val.video_ok && val.brief_ok && val.disclosure_ok && val.eligibility_ok);
    if (!validated) flags.push('Not fully validated by staff');
    return {
      team_id: t.id, team: t.name, lane: t.lane, table_no: t.table_no, project_title: s.project_title,
      average: avg == null ? null : round2(avg), criteria: crit, totals, pending,
      excluded: cards.filter((c) => c.excluded).map((c) => c.judge_name),
      conflicts: conflicts.filter((c) => c.team_id === t.id).map((c) => ({ judge: (judges.find((j) => j.id === c.judge_id) || {}).name || '?', reason: c.reason })),
      flags, complete: comp.complete, validated,
    };
  });
  // Ranking with tie-breakers within 0.25: impact → technical → innovation → judge vote.
  const scored = rows.filter((x) => x.average != null);
  const cmp = (a, b) => {
    if (Math.abs(a.average - b.average) > 0.25) return b.average - a.average;
    for (const k of ['impact', 'technical', 'innovation']) if (a.criteria[k] !== b.criteria[k]) return b.criteria[k] - a.criteria[k];
    return b.average - a.average;
  };
  scored.sort(cmp);
  scored.forEach((x, i) => {
    x.rank = i + 1;
    const next = scored[i + 1], prev = scored[i - 1];
    for (const o of [prev, next]) {
      if (!o || Math.abs(o.average - x.average) > 0.25) continue;
      const decided = ['impact', 'technical', 'innovation'].find((k) => o.criteria[k] !== x.criteria[k]);
      x.flags.push(decided ? `Within 0.25 of ${o.team}; tie-breaker: ${decided} average` : `Tied with ${o.team} on all tie-breakers: judge vote needed`);
    }
  });
  const unscored = rows.filter((x) => x.average == null);
  const ranked = scored.concat(unscored);

  // Award suggestions following "one funded prize per team": champion first, then specialty awards to the best remaining team.
  const suggestions = {};
  const used = new Set();
  if (scored[0]) { suggestions.champion = scored[0].team_id; if (st.one_prize_per_team) used.add(scored[0].team_id); }
  const best = (key, alt) => scored.filter((x) => !used.has(x.team_id)).sort((a, b) => (b.criteria[key] - a.criteria[key]) || (b.criteria[alt] - a.criteria[alt]))[0];
  const cr = best('innovation', 'impact'); if (cr) { suggestions.creative = cr.team_id; if (st.one_prize_per_team) used.add(cr.team_id); }
  const pr = best('usability', 'impact'); if (pr) { suggestions.practical = pr.team_id; if (st.one_prize_per_team) used.add(pr.team_id); }
  return { rows: ranked, judges, suggestions, top3: scored.slice(0, 3).map((x) => x.team_id) };
}

function judgeGate(req) {
  const u = A.requireRole(req, 'judge', 'admin');
  return u;
}
function cardFor(judgeId, teamId) {
  return get('SELECT * FROM scores WHERE judge_id = ? AND team_id = ?', judgeId, teamId);
}

r.get('/judge/overview', wrap((req) => {
  const u = judgeGate(req);
  const st = S.getSettings();
  const conflicts = all('SELECT team_id, reason FROM conflicts WHERE judge_id = ?', u.id);
  const teams = all('SELECT * FROM teams ORDER BY CAST(table_no AS INTEGER), name').map((t) => {
    const s = subRow(t.id);
    const card = cardFor(u.id, t.id);
    const conf = conflicts.find((c) => c.team_id === t.id);
    return {
      id: t.id, name: t.name, lane: t.lane, table_no: t.table_no, project_title: s.project_title,
      complete: completeness(t, s, getCheckpoints(t.id)).complete, frozen: S.isFrozen(t),
      conflict: !!conf, conflict_reason: conf ? conf.reason : '',
      my: card ? { submitted: !!card.submitted, total: CRIT.every((k) => card[k] != null) ? round2(weightedTotal(card)) : null, adjusted: card.adj_technical != null || card.adj_presentation != null } : null,
      finalist: (st.finalists || []).includes(t.id),
    };
  });
  return { teams, criteria: st.criteria, anchors: ANCHORS, judging_open: !!st.judging_open, finalists_open: !!st.finalists_open, results_published: !!st.results_published };
}));

r.get('/judge/scores/:teamId', wrap((req) => {
  const u = judgeGate(req);
  const t = teamOr404(req.params.teamId);
  const conf = get('SELECT reason FROM conflicts WHERE judge_id = ? AND team_id = ?', u.id, t.id);
  return { card: cardFor(u.id, t.id) || null, conflict: conf ? conf.reason || 'Declared' : null, finalist: (S.getSettings().finalists || []).includes(t.id) };
}));

r.put('/judge/scores/:teamId', wrap((req) => {
  const u = A.requireRole(req, 'judge');
  const st = S.getSettings();
  const t = teamOr404(req.params.teamId);
  if (!st.judging_open) throw new HttpError(403, 'Judging has not opened yet.');
  if (st.results_published) throw new HttpError(403, 'Results are published. Scores are locked.');
  if (get('SELECT 1 FROM conflicts WHERE judge_id = ? AND team_id = ?', u.id, t.id)) throw new HttpError(403, 'You declared a conflict with this team.');
  const b = req.body || {};
  const existing = cardFor(u.id, t.id);
  if (existing && existing.submitted && (st.finalists || []).includes(t.id) && st.finalists_open) {
    throw new HttpError(403, 'Finalist Q&A is open: you can only adjust Technical Implementation and Final Presentation.');
  }
  const submit = !!b.submitted;
  const vals = {};
  for (const k of CRIT) vals[k] = int(b[k], { min: 1, max: 10, name: k, nullable: !submit });
  const notes = {
    strength: str(b.strength, { max: 1000, required: submit, name: 'One strength' }),
    risk: str(b.risk, { max: 1000, required: submit, name: 'One question or risk' }),
    next_step: str(b.next_step, { max: 1000, required: submit, name: 'One recommended next step' }),
  };
  run(`INSERT INTO scores (judge_id, team_id, innovation, impact, technical, usability, presentation, strength, risk, next_step, submitted, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(judge_id, team_id) DO UPDATE SET innovation = excluded.innovation, impact = excluded.impact, technical = excluded.technical,
       usability = excluded.usability, presentation = excluded.presentation, strength = excluded.strength, risk = excluded.risk,
       next_step = excluded.next_step, submitted = excluded.submitted, updated_at = excluded.updated_at`,
  u.id, t.id, vals.innovation, vals.impact, vals.technical, vals.usability, vals.presentation, notes.strength, notes.risk, notes.next_step, submit ? 1 : 0, now());
  audit(u.id, submit ? 'score.submit' : 'score.draft', { team: t.id });
  bus.emit('admins', 'staff:update', { kind: 'score' });
  return { card: cardFor(u.id, t.id) };
}));

r.put('/judge/adjust/:teamId', wrap((req) => {
  const u = A.requireRole(req, 'judge');
  const st = S.getSettings();
  const t = teamOr404(req.params.teamId);
  if (!st.finalists_open) throw new HttpError(403, 'Finalist Q&A adjustments are not open.');
  if (!(st.finalists || []).includes(t.id)) throw new HttpError(403, 'This team is not a finalist.');
  if (st.results_published) throw new HttpError(403, 'Results are published.');
  const card = cardFor(u.id, t.id);
  if (!card || !card.submitted) throw new HttpError(400, 'Submit your primary scorecard first.');
  const b = req.body || {};
  run('UPDATE scores SET adj_technical = ?, adj_presentation = ?, adj_note = ?, updated_at = ? WHERE judge_id = ? AND team_id = ?',
    int(b.adj_technical, { min: 1, max: 10, name: 'Technical', nullable: true }), int(b.adj_presentation, { min: 1, max: 10, name: 'Presentation', nullable: true }),
    str(b.adj_note, { max: 1000, required: b.adj_technical != null || b.adj_presentation != null, name: 'Evidence note for the adjustment' }), now(), u.id, t.id);
  audit(u.id, 'score.adjust', { team: t.id });
  bus.emit('admins', 'staff:update', { kind: 'score' });
  return { card: cardFor(u.id, t.id) };
}));

r.put('/judge/conflicts/:teamId', wrap((req) => {
  const u = A.requireRole(req, 'judge');
  const t = teamOr404(req.params.teamId);
  if (S.getSettings().results_published) throw new HttpError(403, 'Results are published.');
  if ((req.body || {}).conflict) {
    run('INSERT OR REPLACE INTO conflicts (judge_id, team_id, reason) VALUES (?,?,?)', u.id, t.id, str(req.body.reason, { max: 300 }));
  } else run('DELETE FROM conflicts WHERE judge_id = ? AND team_id = ?', u.id, t.id);
  audit(u.id, 'judge.conflict', { team: t.id, conflict: !!req.body.conflict });
  bus.emit('admins', 'staff:update', { kind: 'score' });
  return { ok: true };
}));

// ---------- results (after publish) ----------
r.get('/results', wrap((req) => {
  const u = A.requireUser(req);
  const st = S.getSettings();
  if (!st.results_published && u.role !== 'admin') return { published: false };
  const awards = st.awards.map((a) => {
    const row = get('SELECT a.team_id, a.rationale, t.name AS team, s.project_title FROM awards a LEFT JOIN teams t ON t.id = a.team_id LEFT JOIN submissions s ON s.team_id = a.team_id WHERE a.award = ?', a.id);
    return { id: a.id, name: a.name, team_id: row ? row.team_id : null, team: row ? row.team : null, project_title: row ? row.project_title : '', rationale: row ? row.rationale : '' };
  });
  let feedback = null;
  const teamId = u.team_id || (u.role === 'admin' && req.query.team ? Number(req.query.team) : null);
  if (teamId) {
    // Summarized criterion feedback; raw scorecards stay internal (scope §11).
    const tab = tabulate().rows.find((x) => x.team_id === teamId);
    const cards = all('SELECT strength, next_step FROM scores WHERE team_id = ? AND submitted = 1 AND excluded = 0', teamId);
    if (tab) feedback = { criteria: tab.criteria, strengths: cards.map((c) => c.strength).filter(Boolean), next_steps: cards.map((c) => c.next_step).filter(Boolean) };
  }
  return { published: !!st.results_published, awards, feedback, criteria: st.criteria };
}));

module.exports = { router: r, tabulate, ANCHORS, CRIT, weightedTotal };
