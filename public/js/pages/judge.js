import { h, clear, field, toast, busy, badge, confirmBox, promptBox } from '../ui.js';
import { api } from '../api.js';
import { on, role, go, laneName, now, freezeAt, route } from '../app.js';
import { submissionView } from '../components.js';

export async function render(route) {
  const teamId = Number(route.params[0]);
  if (teamId) {
    if (role() === 'admin') { go(`#/review/${teamId}`); return h('div'); }
    return scorecardPage(teamId);
  }
  return listPage();
}

async function listPage() {
  const root = h('div');
  const draw = async () => {
    const d = await api.get('/api/judge/overview');
    const done = d.teams.filter((t) => t.my && t.my.submitted).length;
    const eligible = d.teams.filter((t) => !t.conflict).length;
    clear(root,
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Judging'),
        h('p', null, d.judging_open ? `Scored ${done} of ${eligible} teams. Score independently before discussion.` : 'Judging opens after build freeze and staff validation. You can preview submissions once teams freeze.')),
        role() === 'admin' ? h('a', { class: 'btn', href: '#/admin/scoring' }, 'Tabulation & awards') : null),
      d.finalists_open ? h('div', { class: 'card', style: { borderColor: 'var(--gold)', marginBottom: '16px' } }, h('b', null, 'Finalist Q&A is open. '),
        'For finalists you may adjust only Technical Implementation and Final Presentation, based on verified evidence from the Q&A.') : null,
      h('div', { class: 'split' },
        h('section', { class: 'card table-wrap' }, h('table', { class: 'tbl cards-sm' },
          h('thead', null, h('tr', null, ['Team', 'Project', 'Package', 'My score', ''].map((x) => h('th', null, x)))),
          h('tbody', null, d.teams.map((t) => h('tr', null,
            h('td', null, h('b', null, t.name), h('div', { class: 'faint' }, `Table ${t.table_no || '—'} · ${laneName(t.lane) || '—'}`), t.finalist ? badge('Finalist', 'gold') : null),
            h('td', { 'data-label': 'Project' }, t.project_title || h('span', { class: 'faint' }, '—')),
            h('td', { 'data-label': 'Package' }, t.complete ? badge('Complete', 'ok') : badge('Incomplete', 'bad')),
            h('td', { 'data-label': 'My score' }, t.conflict ? badge('Conflict', 'bad') : t.my ? (t.my.submitted ? badge(`${t.my.total} / 100${t.my.adjusted ? ' (adj.)' : ''}`, 'ok') : badge('Draft', 'warn')) : h('span', { class: 'faint' }, 'Not started')),
            h('td', { class: 'num' }, role() === 'judge' ? h('div', { class: 'row end', style: { flexWrap: 'nowrap' } },
              !t.frozen ? h('span', { class: 'faint', title: 'Submissions open to judges when this team reaches build freeze.' }, 'Still building')
                : h('a', { class: `btn sm ${t.conflict || !d.judging_open ? 'secondary' : ''}`, href: `#/judge/${t.id}` }, t.conflict || !d.judging_open ? 'Preview' : t.my && t.my.submitted ? 'Review' : 'Score'),
              h('button', { class: 'btn ghost sm', title: t.conflict ? 'Remove conflict' : 'Declare a conflict of interest', onclick: async () => {
                if (t.conflict) { if (!(await confirmBox('Remove conflict?', `You will be able to score ${t.name}.`, 'Remove'))) return; await api.put(`/api/judge/conflicts/${t.id}`, { conflict: false }); }
                else { const reason = await promptBox('Declare conflict', `Why can’t you score ${t.name}? (mentored closely, supervise, teach with unresolved conflict, other relationship)`); if (reason === null) return; await api.put(`/api/judge/conflicts/${t.id}`, { conflict: true, reason }); }
                draw();
              } }, t.conflict ? 'Undo conflict' : 'Conflict')) : h('a', { class: 'btn sm secondary', href: `#/review/${t.id}` }, 'View'))))))),
        h('aside', { class: 'stack sticky' }, rubricCard(d))));
  };
  let lastDraw = Date.now(), waiting = true;
  const draw2 = async () => { lastDraw = Date.now(); await draw(); waiting = !!root.querySelector('[title^="Submissions open to judges"]'); };
  await draw2();
  on('event:update', draw2);
  // Teams freeze on the clock (some with extensions): refresh while any is still building.
  on('tick', (t) => { if (waiting && t >= freezeAt() && Date.now() - lastDraw > 10000) draw2(); });
  return root;
}

function rubricCard(d) {
  return h('section', { class: 'card' }, h('h3', null, 'Rubric (100 points)'),
    h('table', { class: 'tbl' }, h('tbody', null, d.criteria.map((c) => h('tr', null, h('td', null, h('b', null, c.name), h('div', { class: 'faint' }, c.hint)), h('td', { class: 'num' }, `${c.weight}%`))))),
    h('h3', { style: { marginTop: '14px' } }, 'Score anchors'),
    h('div', { class: 'anchors' }, d.anchors.map((a) => h('div', null, h('b', null, a.range), h('span', null, a.text)))),
    h('p', { class: 'faint', style: { marginTop: '10px' } }, 'Each criterion is scored 1–10, divided by 10 and multiplied by its weight. Notes should cite observable evidence: one strength, one question or risk, one next step.'));
}

let lastScoreRetry = 0;
async function scorecardPage(teamId) {
  let ov, sub, mine;
  try { [ov, sub, mine] = await Promise.all([api.get('/api/judge/overview'), api.get(`/api/submissions/${teamId}`), api.get(`/api/judge/scores/${teamId}`)]); }
  catch (e) {
    if (e.status !== 403 && e.status !== 404) throw e;
    // "Still building": try again by itself after the freeze (every 15 s while it's still closed).
    let retried = false;
    const again = () => { if (retried || Date.now() - lastScoreRetry < 15000) return; retried = true; lastScoreRetry = Date.now(); route(); };
    on('tick', (t) => { if (t >= freezeAt() + 2000) again(); });
    on('event:update', again);
    return h('div', { class: 'empty' }, h('div', { class: 'big', 'aria-hidden': 'true' }, '⏳'), h('p', null, e.message), h('a', { class: 'btn secondary', href: '#/judge' }, '← All teams'));
  }
  const crit = ov.criteria;
  const card = mine.card || {};
  const vals = Object.fromEntries(crit.map((c) => [c.id, card[c.id] ?? null]));
  const submitted = !!card.submitted;
  const finalistAdjust = ov.finalists_open && mine.finalist && submitted;
  // Primary cards are locked during finalist Q&A for every team (the server refuses them too).
  const locked = !ov.judging_open || ov.results_published || !!mine.conflict || !!ov.finalists_open;

  const totalEl = h('b');
  const adj = { technical: card.adj_technical ?? null, presentation: card.adj_presentation ?? null };
  const total = () => crit.reduce((s, c) => {
    const v = (c.id === 'technical' && adj.technical != null && finalistAdjust) ? adj.technical : (c.id === 'presentation' && adj.presentation != null && finalistAdjust) ? adj.presentation : vals[c.id];
    return s + (v ? (v / 10) * c.weight : 0);
  }, 0);
  const drawTotal = () => { totalEl.textContent = `${(Math.round(total() * 100) / 100).toFixed(2)}`; };

  // One tab stop per criterion; arrow keys move the choice (radio-group pattern). Buttons are
  // updated in place so keyboard focus stays put.
  const scale = (get, set, disabled, label) => {
    const box = h('div', { class: 'scale', role: 'radiogroup', 'aria-label': label });
    const btns = Array.from({ length: 10 }, (_, i) => i + 1).map((n) => h('button', { type: 'button', role: 'radio', disabled, 'aria-label': `${n} of 10`,
      onclick: () => pick(n), onkeydown: (e) => {
        const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (e.key === 'Home' || e.key === 'End' || d) { e.preventDefault(); pick(e.key === 'Home' ? 1 : e.key === 'End' ? 10 : Math.min(10, Math.max(1, (get() || n) + d)), true); }
      } }, String(n)));
    const sync = () => btns.forEach((b, i) => { const on = get() === i + 1; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); b.tabIndex = on || (!get() && i === 0) ? 0 : -1; });
    const pick = (n, focus) => { set(n); sync(); drawTotal(); if (focus) btns[n - 1].focus(); };
    box.append(...btns);
    sync();
    return box;
  };
  const critBlocks = crit.map((c) => {
    const valEl = h('span', { class: 'val' }, vals[c.id] ?? '–');
    return h('div', { class: 'crit' }, h('div', { class: 'top' }, h('b', null, c.name), h('span', { class: 'w' }, `${c.weight}%`), valEl),
      h('div', { class: 'hint' }, c.hint),
      scale(() => vals[c.id], (n) => { vals[c.id] = n; valEl.textContent = n; }, locked, `${c.name} score`));
  });
  const notes = {
    strength: h('textarea', { maxlength: 1000, disabled: locked, placeholder: 'Cite what you saw…' }, card.strength || ''),
    risk: h('textarea', { maxlength: 1000, disabled: locked }, card.risk || ''),
    next_step: h('textarea', { maxlength: 1000, disabled: locked }, card.next_step || ''),
  };
  const payload = (submit) => ({ ...vals, strength: notes.strength.value, risk: notes.risk.value, next_step: notes.next_step.value, submitted: submit });
  const draftBtn = submitted ? null : h('button', { class: 'btn secondary', disabled: locked, onclick: async () => {
    try { await api.put(`/api/judge/scores/${teamId}`, payload(false)); toast('Draft saved.', 'ok'); } catch (e) { toast(e.message, 'bad'); }
  } }, 'Save draft');
  const submitBtn = h('button', { class: 'btn', disabled: locked, onclick: async () => {
    if (crit.some((c) => !vals[c.id])) return toast('Score all five criteria.', 'bad');
    busy(submitBtn, true, 'Submitting…');
    try { await api.put(`/api/judge/scores/${teamId}`, payload(true)); toast('Scorecard submitted.', 'ok'); go('#/judge'); }
    catch (e) { toast(e.message, 'bad'); busy(submitBtn, false); }
  } }, submitted ? 'Update scorecard' : 'Submit scorecard');

  let adjPanel = null;
  if (finalistAdjust) {
    const note = h('textarea', { maxlength: 1000, placeholder: 'What verified evidence from the Q&A supports the change?' }, card.adj_note || '');
    adjPanel = h('section', { class: 'card', style: { borderColor: 'var(--gold)' } }, h('h3', null, 'Finalist Q&A adjustment'),
      h('p', { class: 'faint' }, 'Only Technical Implementation and Final Presentation may change. Leave unchanged to keep your primary score.'),
      h('div', { class: 'crit' }, h('div', { class: 'top' }, h('b', null, 'Technical Implementation'), h('span', { class: 'w' }, `primary ${vals.technical}`)), scale(() => adj.technical, (n) => { adj.technical = n; }, false, 'Adjusted Technical Implementation score')),
      h('div', { class: 'crit' }, h('div', { class: 'top' }, h('b', null, 'Final Presentation'), h('span', { class: 'w' }, `primary ${vals.presentation}`)), scale(() => adj.presentation, (n) => { adj.presentation = n; }, false, 'Adjusted Final Presentation score')),
      field('Evidence note', note),
      h('div', { class: 'row' },
        h('button', { class: 'btn gold', onclick: async () => {
          try { await api.put(`/api/judge/adjust/${teamId}`, { adj_technical: adj.technical, adj_presentation: adj.presentation, adj_note: note.value }); toast('Adjustment saved.', 'ok'); } catch (e) { toast(e.message, 'bad'); }
        } }, 'Save adjustment'),
        h('button', { class: 'btn ghost sm', onclick: async () => {
          try { await api.put(`/api/judge/adjust/${teamId}`, { adj_technical: null, adj_presentation: null, adj_note: '' }); adj.technical = null; adj.presentation = null; toast('Adjustment cleared.', 'ok'); go(`#/judge/${teamId}`); } catch (e) { toast(e.message, 'bad'); }
        } }, 'Clear')));
  }
  drawTotal();

  const why = mine.conflict ? `You declared a conflict: ${mine.conflict}` : !ov.judging_open ? 'Judging is not open yet. You can review the submission.' : ov.results_published ? 'Results are published; scores are locked.' : ov.finalists_open ? (finalistAdjust ? 'Primary scorecard is locked during finalist Q&A.' : 'Primary judging closed when finalist Q&A opened. Ask the scoring lead if a card is missing.') : '';
  const scoreCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'Scorecard'), submitted ? badge('Submitted', 'ok') : card.updated_at ? badge('Draft', 'warn') : null),
    why ? h('p', { class: 'badge warn', style: { display: 'block', whiteSpace: 'normal', padding: '8px 10px', borderRadius: '8px' } }, why) : null,
    critBlocks,
    h('div', { class: 'total-box' }, h('span', null, 'Weighted total'), h('span', null, totalEl, ' / 100')),
    field('One strength', notes.strength), field('One question or risk', notes.risk), field('One recommended next step', notes.next_step),
    h('div', { class: 'row end' }, draftBtn, submitBtn),
    h('details', { style: { marginTop: '12px' } }, h('summary', { class: 'faint', style: { cursor: 'pointer' } }, 'Score anchors'), h('div', { class: 'anchors', style: { marginTop: '6px' } }, ov.anchors.map((a) => h('div', null, h('b', null, a.range), h('span', null, a.text))))));

  // Judging opened/closed, Q&A, results: reload a locked card; warn on one being filled in.
  on('event:update', async () => {
    const o = await api.get('/api/judge/overview').catch(() => null);
    if (!o || (o.judging_open === ov.judging_open && o.finalists_open === ov.finalists_open && o.results_published === ov.results_published)) return;
    if (locked) route(); else toast('Judging status changed. Save what you have, then reload this page.', '', 10000);
  });
  return h('div', null,
    h('div', { class: 'page-head' }, h('div', null, h('a', { href: '#/judge', class: 'faint' }, '← All teams'), h('h1', null, sub.team.name), h('p', null, sub.submission.project_title || 'Untitled project'))),
    h('div', { class: 'split wide-side' }, submissionView(sub.team, sub.submission, sub), h('aside', { class: 'stack sticky', style: { maxHeight: 'calc(100vh - 90px)', overflowY: 'auto' } }, adjPanel, scoreCard)));
}
