import { api, formatDateTime, guarded, h, onSessionChange, startPage, statusBadge } from '/assets/common.js';

const stream = startPage();
const form = document.querySelector('#create-form');

form.elements.timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
form.elements.starts_at.value = defaultStart();

form.addEventListener(
  'submit',
  guarded(async (event) => {
    event.preventDefault();
    const fields = form.elements;
    const session = await api('POST', '/api/sessions', {
      title: fields.title.value,
      description: fields.description.value,
      starts_at: new Date(fields.starts_at.value).toISOString(),
      timezone: fields.timezone.value,
      capacity: Number(fields.capacity.value),
      tags: fields.tags.value.split(',').map((tag) => tag.trim()).filter(Boolean),
      speakers: lines(fields.speakers.value).map(([name, title, company]) => ({ name, title, company })),
      agenda: lines(fields.agenda.value).map(([minutes, title, speaker]) => ({
        duration_minutes: Number(minutes),
        title,
        speaker,
      })),
    });
    location.assign(`/sessions/${session.id}`);
  }),
);

/** Splits "a | b | c" lines into their fields. */
function lines(value) {
  return value
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => line.split('|').map((part) => part.trim()));
}

/** The next whole hour, tomorrow, in the format a datetime-local input expects. */
function defaultStart() {
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  start.setHours(start.getHours() + 1, 0, 0, 0);
  const pad = (number) => String(number).padStart(2, '0');
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}T${pad(start.getHours())}:00`;
}

async function renderSessions() {
  const sessions = await api('GET', '/api/sessions');
  document.querySelector('#sessions-empty').hidden = sessions.length > 0;
  document.querySelector('#sessions').replaceChildren(
    ...sessions.map(({ session, registrations }) =>
      h(
        'li',
        {},
        h('a', { href: `/sessions/${session.id}` }, session.title),
        statusBadge(session.status),
        h(
          'p',
          { className: 'muted' },
          `${formatDateTime(session.starts_at, session.timezone)} · ${registrations.filter((r) => r.status === 'registered').length} registered`,
        ),
      ),
    ),
  );
}

onSessionChange(stream, guarded(renderSessions));
guarded(renderSessions)();
