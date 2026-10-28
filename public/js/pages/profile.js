import { h, field, toast, formData, busy, ROLE_LABEL } from '../ui.js';
import { api } from '../api.js';
import { state, loadMe, renderChrome } from '../app.js';

export async function render(route) {
  await loadMe();
  const u = state.me;
  if (route.query.get('linked')) toast('GitHub linked.', 'ok');
  if (route.query.get('error')) toast(route.query.get('error') === 'gh_taken' ? 'That GitHub account is linked to another user.' : 'Linking GitHub failed. Try again.', 'bad');
  const info = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const btn = info.querySelector('button[type=submit]');
    busy(btn, true);
    try { await api.patch('/api/me', formData(info)); await loadMe(); renderChrome(); toast('Profile saved.', 'ok'); } catch (ex) { toast(ex.message, 'bad'); }
    busy(btn, false);
  } },
  h('h2', null, 'Profile'),
  h('p', { class: 'faint' }, `${u.email} · ${ROLE_LABEL[u.role]}`),
  field('Name', h('input', { type: 'text', name: 'name', value: u.name, required: true, maxlength: 80 })),
  u.role === 'participant' ? [
    h('div', { class: 'grid two' }, field('Major', h('input', { type: 'text', name: 'major', value: u.major, maxlength: 80 })),
      field('Class level', h('select', { name: 'class_level' }, ['', 'Freshman', 'Sophomore', 'Junior', 'Senior', 'Graduate'].map((x) => h('option', { value: x, selected: x === u.class_level }, x || '—'))))),
    field('Preferred role', h('select', { name: 'preferred_role' }, ['', 'Technical builder', 'Problem / business lead', 'Presentation / UX lead', 'Flexible'].map((x) => h('option', { value: x, selected: x === u.preferred_role }, x || '—')))),
    field('Technical skills', h('textarea', { name: 'skills', maxlength: 500 }, u.skills || ''))] : null,
  h('button', { class: 'btn', type: 'submit' }, 'Save'));

  const pw = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const d = formData(pw);
    if (d.next !== d.next2) return toast('New passwords do not match.', 'bad');
    const btn = pw.querySelector('button');
    busy(btn, true);
    try { await api.post('/api/me/password', d); pw.reset(); toast('Password changed.', 'ok'); } catch (ex) { toast(ex.message, 'bad'); }
    busy(btn, false);
  } },
  h('h2', null, 'Change password'),
  field('Current password', h('input', { type: 'password', name: 'current', autocomplete: 'current-password' }), 'If staff reset your password, use the temporary one.'),
  field('New password', h('input', { type: 'password', name: 'next', minlength: 8, required: true, autocomplete: 'new-password' })),
  field('Confirm new password', h('input', { type: 'password', name: 'next2', minlength: 8, required: true, autocomplete: 'new-password' })),
  h('button', { class: 'btn', type: 'submit' }, 'Change password'));

  const gh = h('section', { class: 'card' }, h('h2', null, 'GitHub'),
    u.github_login ? [h('p', null, 'Linked to ', h('b', null, `@${u.github_login}`), '. You can sign in with GitHub.'),
      h('button', { class: 'btn secondary', onclick: async () => { try { await api.post('/api/me/unlink-github'); toast('Unlinked.', 'ok'); location.reload(); } catch (e) { toast(e.message, 'bad'); } } }, 'Unlink')]
      : state.github ? [h('p', { class: 'faint' }, 'Link GitHub to sign in with it next time.'), h('a', { class: 'btn secondary', href: '/api/auth/github/start?mode=link' }, 'Link GitHub account')]
        : h('p', { class: 'faint' }, 'GitHub sign-in is not set up on this server. You can still link your team’s repository on the Submit page.'));

  return h('div', null, h('div', { class: 'page-head' }, h('h1', null, 'Your account')), h('div', { class: 'grid two' }, info, h('div', { class: 'stack' }, pw, gh)));
}
