import { api, guarded, h, onSessionChange, showError, startPage, statusBadge } from '/assets/common.js';

const stream = startPage();
const sessionId = location.pathname.split('/')[2];
const registrationId = new URLSearchParams(location.search).get('registration');
const sessionUrl = `/sessions/${sessionId}`;

// Watching needs a registration, and the session page is where to get one.
if (!registrationId) location.replace(sessionUrl);

let joined = false;
let current = null;

const leave = () => {
  if (!joined) return;
  joined = false;
  api('POST', `/api/registrations/${registrationId}/leave`).catch(showError);
};

/** Keeps attendance in step with the session: watching while live, and left once it ends. */
async function syncAttendance(session, registration) {
  if (session.status === 'live' && registration?.status === 'registered' && !joined) {
    joined = true;
    await api('POST', `/api/registrations/${registrationId}/join`);
  } else if (session.status !== 'live') {
    leave();
  }
}

function currentAgendaItem(session) {
  if (!session.started_at) return session.agenda[0];
  let remaining = (Date.now() - Date.parse(session.started_at)) / 60_000;
  for (const item of session.agenda) {
    if (remaining < item.duration_minutes) return item;
    remaining -= item.duration_minutes;
  }
  return session.agenda.at(-1);
}

const STAGE_TEXT = {
  scheduled: 'Starting soon',
  ended: 'This session has ended',
  cancelled: 'This session was cancelled',
};

function renderStage(session, viewerCount) {
  const live = session.status === 'live';
  const item = currentAgendaItem(session);
  const speaker = session.speakers.find((candidate) => candidate.id === item?.speaker_id);

  document.querySelector('#stage').className = live ? 'stage stage-live' : 'stage';
  document.querySelector('#stage-title').textContent = live ? (item?.title ?? session.title) : STAGE_TEXT[session.status];
  document.querySelector('#stage-speaker').textContent = live ? (speaker?.name ?? session.title) : session.title;
  document.querySelector('#stage-viewers').textContent = `${viewerCount} watching`;
  document.querySelector('#go-live').hidden = session.status !== 'scheduled';
}

function tickTimecode() {
  const startedAt = current?.status === 'live' && current.started_at ? Date.parse(current.started_at) : null;
  const seconds = startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;
  const pad = (number) => String(number).padStart(2, '0');
  document.querySelector('#stage-timecode').textContent =
    `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

function renderComments(comments) {
  const list = document.querySelector('#comments');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  document.querySelector('#comments-empty').hidden = comments.length > 0;
  list.replaceChildren(
    ...comments.map((comment) =>
      h(
        'li',
        { className: comment.deleted ? 'comment comment-deleted' : 'comment' },
        h('strong', {}, comment.author.name),
        h('time', {}, new Date(comment.posted_at).toLocaleTimeString()),
        comment.deleted
          ? h('p', {}, 'Removed by a moderator')
          : h('p', {}, comment.body),
        comment.deleted
          ? null
          : h(
              'button',
              {
                type: 'button',
                className: 'link',
                onclick: guarded(() => api('POST', `/api/comments/${comment.id}/remove`)),
              },
              'Remove',
            ),
      ),
    ),
  );
  if (atBottom) list.scrollTop = list.scrollHeight;
}

async function render() {
  const { session, registrations, comments } = await api('GET', `/api/sessions/${sessionId}`);
  current = session;
  const registration = registrations.find((candidate) => candidate.id === registrationId);

  document.title = `${session.title} · Beacon Live`;
  document.querySelector('#session-title').replaceChildren(
    h('a', { href: sessionUrl }, session.title),
    ' ',
    statusBadge(session.status),
  );
  tickTimecode();
  renderStage(session, registrations.filter((r) => r.attendance_status === 'watching' && r.status === 'registered').length);
  renderComments(comments);

  const cancelled = registration?.status !== 'registered';
  document.querySelector('#viewer-name').textContent = registration
    ? `${cancelled ? 'Cancelled: ' : 'Watching as '}${registration.first_name} ${registration.last_name}`
    : 'Registration not found';
  const fields = document.querySelector('#comment-form').elements;
  fields.body.disabled = cancelled;
  fields.send.disabled = cancelled;
  document.querySelector('#cancel-registration').hidden = cancelled;

  await syncAttendance(session, registration);
}

document.querySelector('#go-live').addEventListener(
  'click',
  guarded(() => api('POST', `/api/sessions/${sessionId}/status`, { status: 'live' })),
);

document.querySelector('#cancel-registration').addEventListener(
  'click',
  guarded(async () => {
    await api('POST', `/api/registrations/${registrationId}/cancel`);
    joined = false;
  }),
);

const commentForm = document.querySelector('#comment-form');
commentForm.addEventListener(
  'submit',
  guarded(async (event) => {
    event.preventDefault();
    const body = commentForm.elements.body;
    await api('POST', `/api/sessions/${sessionId}/comments`, {
      registration_id: registrationId,
      body: body.value,
    });
    body.value = '';
    body.focus();
  }),
);

// Leaving the page ends the watch. A page restored from the back/forward cache starts it again.
addEventListener('pagehide', leave);
addEventListener('pageshow', (event) => {
  if (event.persisted) guarded(render)();
});

if (registrationId) {
  onSessionChange(stream, guarded(render));
  guarded(render)();
  setInterval(tickTimecode, 1000);
}
