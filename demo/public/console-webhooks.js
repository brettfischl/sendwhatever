// The guided Shopify flows. See console.js for mount(), and console-flows.js for what a run does.

import { api, h } from './common.js';
import { createFlowRun, SHAPE_NOTES } from './console-flows.js';

const STATUS_LABELS = { delivered: 'Delivered', failed: 'Failed', sending: 'Sending…', next: 'Next', later: 'Later' };

const MODE_NOTES = {
  stub: {
    title: 'Stub mode: no tables are created. ',
    text: 'It answers like /ingest and recognizes repeated deliveries, but writes no adapters. “Full pipeline” notes describe the real service.',
  },
  real: {
    title: 'Live ingest. ',
    text: 'A 202 means the event is logged and queued, and adapters are written after that. Only a shape seen for the first time gets a new one, so a rerun reuses them.',
  },
};

function resendLine({ kind, count, eventId, summary }) {
  const times = count > 1 ? ` (${count} times)` : '';
  if (kind === 'fail') return h('p', { className: 'flow-result flow-result-fail' }, `Sent again${times}: failed. ${summary}`);
  if (kind === 'same') {
    return h(
      'p',
      { className: 'flow-result flow-result-ok' },
      `Sent again${times}: same event_id, so ingest treated it as a duplicate.`,
    );
  }
  return h(
    'p',
    { className: 'flow-result flow-result-fail' },
    `Sent again${times}: a different event_id came back, so ingest did not treat it as a duplicate. `,
    h('code', {}, eventId ?? 'none'),
  );
}

function stepRow(run, step, index, noteLabel) {
  const status = run.stepStatus(index);
  const outcome = run.state.outcomes[index];
  const resend = run.state.resends[index];
  return h(
    'li',
    { className: `flow-step flow-step-${status}`, ...(status === 'next' || status === 'sending' ? { 'aria-current': 'step' } : {}) },
    h(
      'div',
      { className: 'flow-step-head' },
      h('span', { className: 'flow-step-number' }, String(index + 1)),
      h('strong', {}, step.label),
      h('code', {}, step.topic),
      h('span', { className: `flow-pill flow-pill-${status}` }, STATUS_LABELS[status]),
    ),
    h('p', { className: 'flow-step-text' }, step.description),
    h('p', { className: 'flow-step-note' }, h('strong', {}, `${noteLabel}: `), SHAPE_NOTES[step.topic] ?? ''),
    outcome?.ok
      ? h(
          'p',
          { className: 'flow-result flow-result-ok' },
          `${outcome.status}${outcome.ingestStatus ? ` ${outcome.ingestStatus}` : ''}, event_id `,
          h('code', {}, outcome.eventId ?? 'none'),
        )
      : null,
    outcome && !outcome.ok ? h('p', { className: 'flow-result flow-result-fail' }, outcome.summary) : null,
    resend ? resendLine(resend) : null,
  );
}

function startPanel(slot, flows, loadFlows, ctx) {
  const noteLabel = ctx.target.mode === 'stub' ? 'Full pipeline' : 'Pipeline';
  const modeNote = MODE_NOTES[ctx.target.mode];

  // Controls are kept and updated rather than redrawn, so they hold focus through a run.
  const pickers = new Map();
  const description = h('p', { className: 'flow-description' });
  const sendButton = h('button', { type: 'button', className: 'primary', onclick: () => active.sendNext() });
  const playButton = h('button', { type: 'button', onclick: () => (active.state.playing ? active.stop() : active.play()) });
  const resendButton = h('button', { type: 'button', onclick: () => active.resend() }, 'Resend same delivery');
  const resetButton = h('button', { type: 'button', onclick: () => active.reset() }, 'Reset');
  const status = h('div', { className: 'flow-status', role: 'status' });
  const stepList = h('ol', { className: 'flow-steps' });

  let countdownTimer;
  let drawnPauseEnd = null;

  function drawStatus(run) {
    const { flow, next, busy, resumesAt, problem, outcomes } = run.state;
    const step = flow.steps[next];
    const failed = outcomes[next]?.ok === false;
    clearInterval(countdownTimer);
    drawnPauseEnd = resumesAt;

    if (resumesAt !== null) {
      const seconds = h('span', { 'aria-hidden': 'true' });
      const tick = () => {
        seconds.textContent = ` in ${Math.max(1, Math.ceil((resumesAt - Date.now()) / 1000))}s`;
      };
      tick();
      countdownTimer = setInterval(tick, 200);
      status.className = 'flow-status';
      status.replaceChildren(
        h('span', {}, 'Next: ', h('code', {}, step.topic), seconds),
        h(
          'span',
          { className: 'flow-pause-track' },
          h('span', { className: 'flow-pause-bar', style: `animation-duration:${resumesAt - Date.now()}ms` }),
        ),
      );
      return;
    }

    const kind = problem || (failed && !busy) ? 'fail' : '';
    status.className = `flow-status${kind ? ' flow-status-fail' : ''}`;
    if (problem) status.replaceChildren(problem);
    else if (busy === 'resetting') status.replaceChildren('Starting over with new deliveries…');
    else if (busy === 'resending') status.replaceChildren('Sending the same delivery again…');
    else if (busy === 'sending') status.replaceChildren('Sending ', h('code', {}, step.topic), '…');
    else if (failed) status.replaceChildren(`Step ${next + 1} failed, so the flow stopped there. Retry it, or reset to start over.`);
    else if (run.isDone()) status.replaceChildren('Flow complete. Reset to run it again as new deliveries.');
    else status.replaceChildren('Next: step ', String(next + 1), ', ', h('code', {}, step.topic));
  }

  function draw(run) {
    if (run !== active) return;
    const { flow, next, busy, playing, outcomes } = run.state;
    const step = flow.steps[next];
    const locked = Boolean(busy) || playing;

    for (const [id, button] of pickers) {
      button.setAttribute('aria-pressed', String(id === flow.id));
      button.disabled = locked;
    }
    description.textContent = flow.description;

    sendButton.disabled = locked || run.isDone();
    sendButton.textContent = run.isDone()
      ? 'All steps sent'
      : `${outcomes[next]?.ok === false ? 'Retry' : 'Send'} step ${next + 1}: ${step.topic}`;
    playButton.textContent = playing ? 'Stop auto-play' : 'Auto-play';
    playButton.disabled = playing ? false : Boolean(busy) || run.isDone();
    const last = run.lastDelivered();
    resendButton.title = last ? `Sends ${last.topic} again, with the same X-Shopify-Webhook-Id` : '';
    resendButton.disabled = locked || !last;
    resetButton.disabled = Boolean(busy) || (next === 0 && outcomes.length === 0);

    // Redrawing the status during a pause would restart its bar.
    if (run.state.resumesAt === null || run.state.resumesAt !== drawnPauseEnd) drawStatus(run);
    stepList.replaceChildren(...flow.steps.map((item, index) => stepRow(run, item, index, noteLabel)));
    // Only when the list scrolls by itself: when the page stacks, this would pull the page away.
    if (stepList.scrollHeight > stepList.clientHeight) {
      stepList.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest' });
    }
  }

  async function reload(id) {
    const flow = (await loadFlows()).find((candidate) => candidate.id === id);
    if (!flow) throw new Error(`The demo server has no flow called ${id}.`);
    return flow;
  }

  const runs = flows.map((flow) => {
    const run = createFlowRun({
      flow,
      send: ctx.send,
      reload,
      onChange: () => draw(run),
      // A view in a hidden tab shouldn't overwrite the shared panel while someone uses the other mode.
      canContinue: () => slot.getClientRects().length > 0,
    });
    return run;
  });
  let active = runs[0];

  const picker = h(
    'div',
    { className: 'flow-picker', role: 'group', 'aria-label': 'Flow' },
    runs.map((run) => {
      const { id, label } = run.state.flow;
      const button = h('button', {
        type: 'button',
        textContent: label,
        onclick: () => {
          active = run;
          draw(run);
        },
      });
      pickers.set(id, button);
      return button;
    }),
  );

  slot.replaceChildren(
    h(
      'div',
      { className: 'flows' },
      picker,
      modeNote ? h('p', { className: `flow-mode flow-mode-${ctx.target.mode}` }, h('strong', {}, modeNote.title), modeNote.text) : null,
      description,
      h('div', { className: 'flow-controls' }, sendButton, playButton, resendButton, resetButton),
      status,
      stepList,
    ),
  );
  draw(active);
}

export function mount(slot, ctx) {
  const loadFlows = () => api('GET', '/api/console/flows');

  async function start() {
    slot.replaceChildren(h('p', { className: 'flow-loading' }, 'Loading the flows…'));
    try {
      startPanel(slot, await loadFlows(), loadFlows, ctx);
    } catch (error) {
      console.error(error);
      slot.replaceChildren(
        h(
          'div',
          { className: 'flow-loading' },
          h('p', { className: 'flow-result-fail' }, `Couldn't load the flows. ${error.message}`),
          h('button', { type: 'button', onclick: start }, 'Try again'),
        ),
      );
    }
  }

  start();
}
