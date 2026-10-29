import { h, clear, field, toast, formData, busy } from '../ui.js';
import { api } from '../api.js';
import { state, afterLogin } from '../app.js';

const RULES = [
  'Follow University conduct, academic integrity, accessibility and acceptable-use expectations.',
  'Use only public, synthetic, de-identified, or explicitly authorized data.',
  'Do not probe, scan, exploit, overload, or try to access University or third-party systems.',
  'Build the solution during the event; disclose outside code, datasets, templates, models, APIs and AI help.',
  'Use the event-approved AI environment. Development stops at the 4:30 p.m. build freeze.',
];

export function render(route) {
  let mode = route.query.get('register') ? 'register' : 'login';
  const ERRORS = { gh_expired: 'GitHub sign-in expired. Try again.', gh_cancel: 'GitHub sign-in was cancelled.', gh_denied: 'GitHub did not approve the sign-in.', gh_profile: 'Could not read your GitHub profile.',
    gh_signin: 'Sign in first, then link GitHub.', gh_nolink: 'No HAkrathon account is linked to that GitHub account. Register with your access code, then link GitHub from your profile.',
    disabled: 'This account is disabled. Ask event staff.', gh_failed: 'GitHub sign-in failed. Try again or use your email and password.' };
  const err = ERRORS[route.query.get('error')] || (route.query.get('error') ? 'Sign-in failed. Try again.' : '');
  const box = h('div', { class: 'card' });
  const draw = () => clear(box, mode === 'login' ? loginForm() : registerForm());

  function tabs() {
    return h('div', { class: 'seg', role: 'group', 'aria-label': 'Sign in or create an account', style: { marginBottom: '16px', width: '100%' } },
      h('button', { type: 'button', class: mode === 'login' ? 'on' : '', 'aria-pressed': String(mode === 'login'), style: { flex: 1 }, onclick: () => { mode = 'login'; draw(); } }, 'Sign in'),
      h('button', { type: 'button', class: mode === 'register' ? 'on' : '', 'aria-pressed': String(mode === 'register'), style: { flex: 1 }, onclick: () => { mode = 'register'; draw(); } }, 'Create account'));
  }

  function loginForm() {
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type=submit]');
      busy(btn, true, 'Signing in…');
      try { await api.post('/api/auth/login', formData(form)); await afterLogin(); }
      catch (ex) { toast(ex.message, 'bad'); busy(btn, false); }
    } },
    tabs(),
    err ? h('p', { class: 'badge bad', style: { display: 'block', padding: '8px 10px', borderRadius: '8px', whiteSpace: 'normal' } }, err) : null,
    field('University email', h('input', { type: 'email', name: 'email', autocomplete: 'username', required: true })),
    field('Password', h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true })),
    h('button', { class: 'btn lg', type: 'submit', style: { width: '100%' } }, 'Sign in'),
    state.github ? [h('div', { class: 'faint', style: { textAlign: 'center', margin: '12px 0' } }, 'or'),
      h('a', { class: 'btn secondary', href: '/api/auth/github/start?mode=login', style: { width: '100%' } }, 'Sign in with GitHub')] : null,
    h('p', { class: 'faint', style: { marginTop: '14px' } }, 'Forgot your password? Ask at the check-in desk or tech help; staff can reset it.'));
    return form;
  }

  function registerForm() {
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      const d = formData(form);
      if (d.password !== d.password2) return toast('Passwords do not match.', 'bad');
      const btn = form.querySelector('button[type=submit]');
      busy(btn, true, 'Creating account…');
      try { await api.post('/api/auth/register', d); toast('Welcome to HAkrathon!', 'ok'); await afterLogin(); }
      catch (ex) { toast(ex.message, 'bad'); busy(btn, false); }
    } },
    tabs(),
    field('Access code', h('input', { type: 'text', name: 'invite', required: true, autocomplete: 'off', placeholder: 'From check-in, e.g. PAR-7KX2QM', style: { textTransform: 'uppercase', fontFamily: 'var(--mono)' } }),
      'Participants get this at check-in. Judges and mentors get their own code from event staff.'),
    field('Full name', h('input', { type: 'text', name: 'name', required: true, autocomplete: 'name', maxlength: 80 })),
    field('University email', h('input', { type: 'email', name: 'email', required: true, autocomplete: 'email', placeholder: 'you@uakron.edu' })),
    h('div', { class: 'grid two', style: { gap: '0 12px', gridTemplateColumns: '1fr 1fr' } },
      field('Password', h('input', { type: 'password', name: 'password', required: true, minlength: 8, autocomplete: 'new-password' })),
      field('Confirm', h('input', { type: 'password', name: 'password2', required: true, minlength: 8, autocomplete: 'new-password' }))),
    h('details', null, h('summary', { class: 'faint', style: { cursor: 'pointer', marginBottom: '10px' } }, 'Participant details (major, skills, role)'),
      h('div', { class: 'grid two', style: { gap: '0 12px', gridTemplateColumns: '1fr 1fr' } },
        field('Major', h('input', { type: 'text', name: 'major', maxlength: 80 })),
        field('Class level', h('select', { name: 'class_level' }, ['', 'Freshman', 'Sophomore', 'Junior', 'Senior', 'Graduate'].map((x) => h('option', { value: x }, x || '—'))))),
      field('Preferred role', h('select', { name: 'preferred_role' }, ['', 'Technical builder', 'Problem / business lead', 'Presentation / UX lead', 'Flexible'].map((x) => h('option', { value: x }, x || '—')))),
      field('Technical skills', h('textarea', { name: 'skills', maxlength: 500, placeholder: 'Python, React, SQL, Power BI, cybersecurity…', style: { minHeight: '60px' } }))),
    h('div', { class: 'card flat', style: { background: 'var(--panel-2)', padding: '12px', margin: '6px 0 12px' } },
      h('b', { style: { fontSize: '.88rem' } }, 'Event rules'),
      h('ul', { style: { margin: '6px 0 8px', paddingLeft: '18px', fontSize: '.84rem', color: 'var(--ink-2)' } }, RULES.map((r) => h('li', null, r))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'agree', required: true }), h('span', null, 'I agree to the event rules, code of conduct, and tool disclosure requirements.'))),
    h('button', { class: 'btn lg', type: 'submit', style: { width: '100%' } }, 'Create account'));
    return form;
  }

  draw();
  const ev = state.event || {};
  return h('div', { class: 'auth-wrap' },
    h('section', { class: 'auth-art' },
      h('div', { class: 'logo', 'aria-hidden': 'true' }, h('span', { class: 'b' }, '<'), 'H', h('span', { class: 'b' }, '>')),
      h('h1', null, 'HAkrathon ', h('span', { style: { color: 'var(--gold)' } }, '2026')),
      h('div', { class: 'tag' }, 'BUILD • SOLVE • INNOVATE'),
      h('p', { style: { marginTop: '18px', fontSize: '1.05rem', color: 'rgba(255,255,255,.85)', maxWidth: '520px' } },
        '12-hour technology innovation challenge at the University of Akron College of Business. Team up to build a solution that measurably improves the College experience.'),
      h('ul', null,
        h('li', null, 'Team chat, announcements and mentor help queue'),
        h('li', null, 'Shared code editor that runs Python, JavaScript, C, C++, Java'),
        h('li', null, 'Link your GitHub repo — judges see the exact commit at build freeze'),
        h('li', null, 'Submit your prototype, 5-minute demo, brief and disclosures in one place')),
      ev.event_name ? null : null),
    h('section', { class: 'auth-form' }, box));
}
