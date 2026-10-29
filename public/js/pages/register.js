import { h, clear, field, toast, formData, busy } from '../ui.js';
import { api } from '../api.js';
import { state } from '../app.js';

// Public event registration (no account needed). Event Scope §5: name, university email, major and
// class level, team or team matching, skills, preferred role and experience, dietary needs and
// accommodations, rules, disclosure and media preference. Student status is checked at check-in.
export async function render() {
  const info = await api.get('/api/registration');
  const box = h('div', { class: 'card' });
  const signIn = h('a', { href: state.me ? '#/' : '#/login' }, state.me ? 'Back to the portal' : 'Sign in');

  if (!info.open) {
    clear(box, h('h2', null, 'Registration is closed'),
      h('p', null, `${info.event_name} registration is closed. Ask event staff about the waitlist.`), h('p', null, 'Already registered? ', signIn, '.'));
    return wrapPage(info, box);
  }

  let teamMode = 'match';
  const teamFields = h('div');
  const drawTeam = () => clear(teamFields, teamMode === 'team' ? [
    field('Team name', h('input', { type: 'text', name: 'team_name', required: true, maxlength: 60, autocomplete: 'off' })),
    field('Teammates', h('textarea', { name: 'teammates', maxlength: 1000, placeholder: 'Name and UA email of each teammate, one per line', style: { minHeight: '70px' } }),
      `Teams are ${info.team_min}–${info.team_max} students. Each teammate registers too, with the same team name.`),
    field('Solution lane (optional)', h('select', { name: 'lane' }, h('option', { value: '' }, 'Not decided yet'), info.lanes.map((l) => h('option', { value: l.id }, l.name)))),
  ] : h('p', { class: 'faint', style: { margin: '0 0 12px' } }, 'We will match you with a team at the pre-event matching session. Rosters lock at 9:15 AM on event day.'));
  const modeBtn = (v, label) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'team_mode', value: v, checked: teamMode === v, onchange: () => { teamMode = v; drawTeam(); } }), h('span', null, label));
  drawTeam();

  const form = h('form', { novalidate: false, onsubmit: async (e) => {
    e.preventDefault();
    const d = formData(form);
    d.media_ok = d.media_ok === 'yes';
    const btn = form.querySelector('button[type=submit]');
    busy(btn, true, 'Registering…');
    try {
      const r = await api.post('/api/registration', d);
      clear(box, h('div', { class: 'reg-done' },
        h('div', { class: 'big', 'aria-hidden': 'true' }, '✓'),
        h('h2', null, `You're registered, ${r.name.split(/\s+/)[0]}!`),
        h('p', null, 'Event staff review registrations in order (first qualified, first confirmed) and will let you know if your spot is confirmed.'),
        h('ul', null,
          h('li', null, 'Event day: Friday, Nov 6, 7:30 AM at the College of Business. Bring your Zip card for check-in.'),
          h('li', null, 'At check-in you get a personal access code to create your portal account.'),
          h('li', null, 'To change anything, contact event staff.')),
        h('p', null, signIn)));
      box.focus();
      window.scrollTo(0, 0);
    } catch (ex) { toast(ex.message, 'bad'); busy(btn, false); }
  } },
  h('h2', null, 'Register for the event'),
  h('p', { class: 'faint' }, 'Open to currently enrolled University of Akron students from any major. Takes about 3 minutes.'),
  h('fieldset', null, h('legend', null, 'About you'),
    h('div', { class: 'grid two' },
      field('Full name', h('input', { type: 'text', name: 'name', required: true, maxlength: 80, autocomplete: 'name' })),
      field('University email', h('input', { type: 'email', name: 'email', required: true, maxlength: 200, autocomplete: 'email', placeholder: 'you@uakron.edu' }))),
    h('div', { class: 'grid two' },
      field('Major', h('input', { type: 'text', name: 'major', required: true, maxlength: 80 })),
      field('Class level', h('select', { name: 'class_level', required: true }, h('option', { value: '' }, 'Choose…'), info.class_levels.map((x) => h('option', { value: x }, x)))))),
  h('fieldset', null, h('legend', null, 'Team'),
    h('div', { class: 'row', style: { gap: '18px', marginBottom: '10px' } }, modeBtn('match', 'Match me with a team'), modeBtn('team', 'I have a team')),
    teamFields),
  h('fieldset', null, h('legend', null, 'Skills'),
    field('Preferred role', h('select', { name: 'preferred_role' }, h('option', { value: '' }, 'No preference'), info.roles.map((x) => h('option', { value: x }, x)))),
    field('Technical skills', h('textarea', { name: 'skills', maxlength: 500, placeholder: 'Python, SQL, Power BI, React, cybersecurity…', style: { minHeight: '60px' } })),
    field('Build experience', h('textarea', { name: 'experience', maxlength: 1000, placeholder: 'Briefly: something you have built (class project, app, automation, dashboard…)', style: { minHeight: '60px' } })),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'technical' }),
      h('span', null, 'I have experience in programming, automation, cybersecurity, data, systems, or another technical area.', h('div', { class: 'faint' }, 'Every team needs at least one member who can build a working prototype.')))),
  h('fieldset', null, h('legend', null, 'Food & access'),
    h('div', { class: 'grid two' },
      field('Dietary restrictions', h('input', { type: 'text', name: 'dietary', maxlength: 300, placeholder: 'e.g. vegetarian, halal, nut allergy' })),
      field('Accommodation requests', h('input', { type: 'text', name: 'accommodations', maxlength: 500, placeholder: 'Anything that helps you take part' })))),
  h('fieldset', null, h('legend', null, 'Agreements'),
    h('div', { class: 'faint', style: { marginBottom: '6px' } }, 'Photos and video'),
    h('div', { class: 'row', style: { gap: '18px', marginBottom: '12px' } },
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'media_ok', value: 'yes', required: true }), h('span', null, 'OK to appear in event photos and video')),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'media_ok', value: 'no' }), h('span', null, 'Please leave me out'))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'agree_rules', required: true }),
      h('span', null, 'I agree to the event rules and code of conduct: University conduct and academic integrity, respectful behavior, and only public, synthetic or authorized data.')),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'agree_disclosure', required: true }),
      h('span', null, 'I will disclose outside code, datasets, templates, models, APIs and AI help, and build the solution during the event.'))),
  h('button', { class: 'btn lg', type: 'submit', style: { width: '100%' } }, 'Register'),
  h('p', { class: 'faint', style: { marginTop: '12px', textAlign: 'center' } }, 'Already have your access code? ', state.me ? null : h('a', { href: '#/login?register=1' }, 'Create your portal account'), state.me ? signIn : null));
  clear(box, form);
  box.tabIndex = -1;
  return wrapPage(info, box);
}

function wrapPage(info, box) {
  return h('div', { class: 'reg-wrap' },
    h('section', { class: 'reg-head' },
      h('div', { class: 'eyebrow' }, 'Friday, November 6 · College of Business · 7:30 AM–7:30 PM'),
      h('h1', null, info.event_name),
      h('p', null, `A one-day build challenge: up to ${info.max_teams} teams of ${info.team_min}–${info.team_max} students build a technology solution that measurably improves the College of Business.`)),
    box);
}
