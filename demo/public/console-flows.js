// What a guided flow does, apart from drawing it, so the tests can run it. console-webhooks.js draws it.

/** Long enough to say something about the last result, and for a room to read the next step. */
export const AUTOPLAY_PAUSE_MS = 5000;

/**
 * What each topic means for the real pipeline, which the fixtures' fingerprints back up (see "the
 * shapes" in shopify.test.ts). The stub does none of this, so the panel labels these accordingly.
 */
export const SHAPE_NOTES = {
  'products/create': 'A shape not seen before gets quarantined until the LLM has written an adapter for it.',
  'products/update':
    'The keys are the same, but fields that were null now hold values. That changes the fingerprint, so this is a new shape with its own adapter.',
  'orders/create': 'Nothing like the products, so the first order gets an adapter of its own.',
  'orders/paid': "Only values change, so the fingerprint matches orders/create and that adapter is reused. The LLM isn't called.",
  'refunds/create': 'The real new shape: a different structure from the order, so it needs a new adapter.',
};

/** What to give ctx.send for a step. The body is exact text, so Content-Type has to be set here. */
export function stepRequest(step, { resend = false } = {}) {
  const hasType = Object.keys(step.headers).some((name) => name.toLowerCase() === 'content-type');
  return {
    method: step.method,
    path: step.path.replace(/^\/ingest\/?/, ''),
    headers: hasType ? step.headers : { ...step.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(step.body),
    auth: 'key',
    label: `Shopify ${step.topic}${resend ? ' (same delivery again)' : ''}`,
  };
}

/** Sends, and turns every way that can go wrong into something to show. It never rejects. */
async function attempt(send, request) {
  let entry;
  try {
    entry = await send(request);
  } catch (error) {
    return { ok: false, summary: `Not sent. ${error.message}` };
  }
  const { response } = entry;
  if (!response) return { ok: false, summary: `No response from ingest. ${entry.error ?? ''}`.trim() };
  const { status, body } = response;
  if (status < 200 || status >= 300) {
    return { ok: false, summary: `Ingest answered ${status}.${body?.error ? ` ${body.error}` : ''}` };
  }
  return { ok: true, status, ingestStatus: body?.status, eventId: body?.event_id };
}

/** Says what actually came back, because a repeat only counts if ingest gave the original ID. */
function readResend(original, outcome, count) {
  if (!outcome.ok) return { kind: 'fail', count, summary: outcome.summary };
  const same = outcome.eventId !== undefined && outcome.eventId === original.eventId;
  return same
    ? { kind: 'same', count, eventId: outcome.eventId }
    : { kind: 'different', count, eventId: outcome.eventId };
}

/**
 * One flow's progress. Only `next` moves it forward, and only a delivered step moves `next`, so a
 * failed step stays next and sending it again repeats the same delivery, as Shopify's retries do.
 *
 * `send` is ctx.send. `reload` gets the flow again with new delivery IDs. `onChange` runs after every
 * change to `state`. `canContinue` is asked before each automatic send, so auto-play can stop itself.
 */
export function createFlowRun({ flow, send, reload, onChange = () => {}, pauseMs = AUTOPLAY_PAUSE_MS, canContinue = () => true }) {
  const state = {
    flow,
    next: 0,
    outcomes: [],
    resends: [],
    /** 'sending', 'resending', or 'resetting': one thing at a time, so results can't land out of order. */
    busy: null,
    playing: false,
    /** While auto-play is between steps, when the next send happens. */
    resumesAt: null,
    problem: null,
  };
  let endPause = () => {};

  const isDone = () => state.next >= state.flow.steps.length;

  /** Resolves to whether the step was delivered. */
  async function deliverNext() {
    const index = state.next;
    state.busy = 'sending';
    state.problem = null;
    onChange();
    const outcome = await attempt(send, stepRequest(state.flow.steps[index]));
    state.outcomes[index] = outcome;
    if (outcome.ok) state.next = index + 1;
    state.busy = null;
    onChange();
    return outcome.ok;
  }

  async function pause() {
    state.resumesAt = Date.now() + pauseMs;
    const ended = new Promise((resolve) => {
      const timer = setTimeout(resolve, pauseMs);
      endPause = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    onChange();
    await ended;
    state.resumesAt = null;
  }

  return {
    state,
    isDone,

    /** The status of step `index`: delivered, failed, sending, next, or later. */
    stepStatus(index) {
      if (index < state.next) return 'delivered';
      if (index > state.next) return 'later';
      if (state.busy === 'sending') return 'sending';
      return state.outcomes[index]?.ok === false ? 'failed' : 'next';
    },

    async sendNext() {
      if (state.busy || state.playing || isDone()) return;
      await deliverNext();
    },

    /** Sends from the next step to the end with a pause between each, stopping at a failure. */
    async play() {
      if (state.busy || state.playing || isDone()) return;
      state.playing = true;
      while (state.playing && canContinue() && (await deliverNext()) && !isDone() && state.playing) {
        await pause();
      }
      state.playing = false;
      onChange();
    },

    /** Lets a send in progress finish, and sends nothing more. */
    stop() {
      state.playing = false;
      endPause();
      onChange();
    },

    /** The last delivered step, which is what the resend button repeats. */
    lastDelivered() {
      return state.next === 0 ? null : state.flow.steps[state.next - 1];
    },

    /** Sends the last delivered step again, exactly as it was. This doesn't move the flow on. */
    async resend() {
      if (state.busy || state.playing || state.next === 0) return;
      const index = state.next - 1;
      state.busy = 'resending';
      state.problem = null;
      onChange();
      const outcome = await attempt(send, stepRequest(state.flow.steps[index], { resend: true }));
      const count = (state.resends[index]?.count ?? 0) + 1;
      state.resends[index] = readResend(state.outcomes[index], outcome, count);
      state.busy = null;
      onChange();
    },

    /** Starts over with new delivery IDs. If they can't be fetched, the run stays as it was. */
    async reset() {
      if (state.busy) return;
      this.stop();
      state.busy = 'resetting';
      state.problem = null;
      onChange();
      try {
        state.flow = await reload(state.flow.id);
        state.next = 0;
        state.outcomes = [];
        state.resends = [];
      } catch (error) {
        state.problem = `Couldn't start over. ${error.message}`;
      }
      state.busy = null;
      onChange();
    },
  };
}
