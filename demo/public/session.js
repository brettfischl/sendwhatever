import { api, formatDateTime, guarded, h, onSessionChange, showError, startPage, statusBadge } from '/assets/common.js';

const stream = startPage();
const sessionId = location.pathname.split('/')[2];

const STATUS_ACTIONS = {
  scheduled: [['live', 'Go live', 'primary'], ['cancelled', 'Cancel session', '']],
  live: [['ended', 'End session', '']],
  ended: [],
  cancelled: [],
};

function renderHeader(session) {
  document.title = `${session.title} · Beacon Live`;
  document.querySelector('#session-header').replaceChildren(
    h('div', { className: 'title-row' }, h('h1', {}, session.title), statusBadge(session.status)),
    h('p', { className: 'muted' }, `${formatDateTime(session.starts_at, session.timezone)} (${session.timezone}) · capacity ${session.capacity}`),
    h('p', {}, session.description),
    h('p', { className: 'tags' }, session.tags.map((tag) => h('span', { className: 'tag' }, tag))),
    h(
      'div',
      { className: 'actions' },
      STATUS_ACTIONS[session.status].map(([status, label, kind]) =>
        h(
          'button',
          {
            type: 'button',
            className: kind,
            onclick: guarded(() => api('POST', `/api/sessions/${sessionId}/status`, { status })),
          },
          label,
        ),
      ),
    ),
  );
}

function renderProgram(session, sponsors) {
  const nameOf = (id) => session.speakers.find((speaker) => speaker.id === id)?.name;
  document.querySelector('#speakers').replaceChildren(
    ...session.speakers.map((speaker) =>
      h('li', {}, h('strong', {}, speaker.name), [speaker.title, speaker.company].filter(Boolean).length ? ` · ${[speaker.title, speaker.company].filter(Boolean).join(', ')}` : ''),
    ),
  );
  document.querySelector('#sponsors').replaceChildren(...sponsors.map((sponsor) => h('li', {}, sponsor.name)));
  document.querySelector('#agenda').replaceChildren(
    ...session.agenda.map((item) =>
      h('li', {}, h('strong', {}, item.title), ` · ${item.duration_minutes} min`, item.speaker_id ? ` · ${nameOf(item.speaker_id)}` : ''),
    ),
  );
}

function renderRegistrations(session, registrations) {
  const active = registrations.filter((r) => r.status === 'registered').length;
  document.querySelector('#registrant-count').textContent = `${active} of ${session.capacity}`;
  document.querySelector('#registrants-empty').hidden = registrations.length > 0;
  document.querySelector('#registrants').replaceChildren(
    ...[...registrations].reverse().map((registration) => {
      const cancelled = registration.status === 'cancelled';
      return h(
        'tr',
        { className: cancelled ? 'row-cancelled' : '' },
        h('td', {}, `${registration.first_name} ${registration.last_name}`),
        h('td', {}, registration.email),
        h('td', {}, cancelled ? 'cancelled' : registration.attendance_status.replace('_', ' ')),
        h(
          'td',
          { className: 'row-actions' },
          cancelled ? null : h('a', { href: `/sessions/${sessionId}/watch?registration=${registration.id}` }, 'Watch'),
          cancelled
            ? null
            : h(
                'button',
                {
                  type: 'button',
                  className: 'link',
                  onclick: guarded(() => api('POST', `/api/registrations/${registration.id}/cancel`)),
                },
                'Cancel',
              ),
        ),
      );
    }),
  );
}

async function render() {
  const { session, sponsors, registrations, comments } = await api('GET', `/api/sessions/${sessionId}`);
  renderHeader(session);
  renderProgram(session, sponsors);
  renderRegistrations(session, registrations);
  document.querySelector('#comment-count').textContent = String(comments.filter((c) => !c.deleted).length);
}

const registerForm = document.querySelector('#register-form');
registerForm.addEventListener(
  'submit',
  guarded(async (event) => {
    event.preventDefault();
    const fields = registerForm.elements;
    const registration = await api('POST', `/api/sessions/${sessionId}/registrations`, {
      email: fields.email.value,
      first_name: fields.first_name.value,
      last_name: fields.last_name.value,
      company: fields.company.value,
      job_title: fields.job_title.value,
      marketing_consent: fields.marketing_consent.checked,
    });
    location.assign(`/sessions/${sessionId}/watch?registration=${registration.id}`);
  }),
);

const simulateForm = document.querySelector('#simulate-form');
simulateForm.addEventListener(
  'submit',
  guarded(async (event) => {
    event.preventDefault();
    await api('POST', `/api/sessions/${sessionId}/simulate`, {
      viewers: Number(simulateForm.elements.viewers.value),
    });
  }),
);

const lookalikeForm = document.querySelector('#lookalike-form');
lookalikeForm.addEventListener(
  'submit',
  guarded(async (event) => {
    event.preventDefault();
    const fields = lookalikeForm.elements;
    await api('POST', `/api/sessions/${sessionId}/lookalikes`, {
      kind: event.submitter.value,
      name: fields.name.value,
      use_path: fields.use_path.checked,
    });
    fields.name.value = '';
  }),
);

onSessionChange(stream, guarded(render));
render().catch((error) => {
  showError(error);
  document.querySelector('#session-header').replaceChildren(
    h('h1', {}, 'Session not found'),
    h('p', {}, 'Sessions live in memory, so they are gone after a restart. ', h('a', { href: '/' }, 'Create a new one.')),
  );
});
