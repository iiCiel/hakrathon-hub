import { h, clear, toast, fmtTime, fmtDur, badge, modal } from '../ui.js';
import { api } from '../api.js';
import { on, role, go } from '../app.js';
import { submissionView } from '../components.js';

export async function render(route) {
  const teamId = Number(route.params[0]);
  if (!teamId) { go('#/teams'); return h('div'); }
  const root = h('div');
  const draw = async () => {
    const d = await api.get(`/api/submissions/${teamId}`);
    const main = submissionView(d.team, d.submission, d);
    const side = h('aside', { class: 'stack sticky' });
    if (role() === 'admin') side.append(await validationCard(teamId, d.submission));
    if (role() === 'judge') side.append(h('section', { class: 'card' }, h('a', { class: 'btn', href: `#/judge/${teamId}`, style: { width: '100%' } }, 'Open scorecard')));
    side.append(h('section', { class: 'card' }, h('div', { class: 'row' }, h('a', { class: 'btn secondary sm', href: `#/workspace/${teamId}` }, 'Team workspace code'))));
    const log = await api.get(`/api/submissions/${teamId}/log`).catch(() => ({ log: [] }));
    side.append(h('section', { class: 'card' }, h('h3', null, 'Timestamped activity'), h('div', { class: 'faint', style: { fontSize: '.82rem', maxHeight: '260px', overflowY: 'auto' } },
      log.log.length ? log.log.map((l) => h('div', { style: { padding: '3px 0', borderBottom: '1px dashed var(--line)' } }, `${fmtTime(l.created_at)} · ${l.name || 'system'} · ${l.action}${l.detail ? ` · ${l.detail}` : ''}`)) : 'No activity.')));
    clear(root, h('div', { class: 'page-head' }, h('div', null, h('h1', null, d.team.name), h('p', null, 'Submission package'))), h('div', { class: 'split' }, main, side));
  };
  await draw();
  // Don't yank the page out from under a judge who is watching the video, reading a file or has run
  // the code: offer a refresh instead.
  const inUse = () => [...root.querySelectorAll('video')].some((v) => v.currentTime > 0)
    || root.querySelector('pre.output[data-ran], textarea:focus, input:focus') || root.querySelector('.tree .node.on:not([data-readme])');
  let banner = null;
  const update = () => {
    if (!inUse()) { banner = null; return draw(); }
    if (banner && banner.isConnected) return;
    banner = h('div', { class: 'card row', role: 'status', style: { borderColor: 'var(--gold)', marginBottom: '12px', position: 'sticky', top: '8px', zIndex: 6 } },
      h('b', null, 'This package was just updated.'), h('span', { class: 'spacer' }), h('button', { class: 'btn sm', onclick: () => { banner = null; draw(); } }, 'Show the update'));
    root.prepend(banner);
  };
  on('submission:update', update);
  // Staff aren't in the team's room; they hear about this team's changes on the staff channel.
  on('staff:update', (ev) => { if (ev && ev.kind === 'submission' && ev.teamId === teamId) update(); });
  return root;
}

async function validationCard(teamId, s) {
  const ov = await api.get('/api/admin/overview');
  const t = ov.teams.find((x) => x.id === teamId) || {};
  const v = t.validation || {};
  const checks = [
    ['links_ok', 'Links and repository open from a non-team account'],
    ['video_ok', `Video is 5:00 or less${s.video_seconds ? ` (${fmtDur(s.video_seconds)})` : ''} and viewable`],
    ['brief_ok', 'One-page brief present'],
    ['disclosure_ok', 'Disclosures complete; no unauthorized data'],
    ['eligibility_ok', 'Roster eligible; no prohibited outside work'],
  ];
  const boxes = Object.fromEntries(checks.map(([k]) => [k, h('input', { type: 'checkbox', checked: !!v[k] })]));
  const notes = h('textarea', { 'aria-label': 'Validation notes (internal)', placeholder: 'Validation notes (internal)', maxlength: 1000 }, v.notes || '');
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Staff validation'), checks.every(([k]) => v[k]) ? badge('Validated', 'ok') : badge('Pending', 'warn')),
    checks.map(([k, label]) => h('label', { class: 'check', style: { marginBottom: '8px' } }, boxes[k], h('span', null, label))),
    notes,
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('button', { class: 'btn', onclick: async () => {
        try {
          await api.put(`/api/admin/validation/${teamId}`, { ...Object.fromEntries(Object.entries(boxes).map(([k, el]) => [k, el.checked])), notes: notes.value });
          toast('Validation saved.', 'ok');
        } catch (e) { toast(e.message, 'bad'); }
      } }, 'Save'),
      s.repo_url ? h('button', { class: 'btn secondary', onclick: async (e) => {
        const btn = e.currentTarget;
        const useTok = h('input', { type: 'checkbox' });
        const go = await modal('Re-snapshot repository?', h('div', null,
          h('p', null, 'Clone ', h('code', null, s.repo_url), ' again', s.frozen ? ' (last commit before this team’s build freeze).' : '.'),
          h('label', { class: 'check' }, useTok, h('span', null, 'Use the server’s GitHub token (only if this is the team’s own private repo and you checked the owner)'))),
          [{ label: 'Cancel', value: false, class: 'ghost' }, { label: 'Re-snapshot', value: true }]);
        if (!go) return;
        btn.disabled = true;
        try { await api.post(`/api/admin/snapshot/${teamId}`, { use_token: useTok.checked }); toast('Repository re-snapshotted.', 'ok'); } catch (ex) { toast(ex.message, 'bad'); }
        btn.disabled = false;
      } }, 'Re-snapshot repo') : null),
    h('p', { class: 'faint', style: { marginTop: '8px' } }, 'Broken links may be fixed only by changing access permissions, not the underlying work.'));
}
