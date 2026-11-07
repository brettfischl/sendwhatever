import type { Context } from 'hono';
import type { FC, PropsWithChildren } from 'hono/jsx';

/** Sent by the refresh script. The route answers with only the live region's HTML. */
export const FRAGMENT_HEADER = 'x-admin-fragment';

export const isFragmentRequest = (c: Context) => c.req.header(FRAGMENT_HEADER) === '1';

export const DEFAULT_REFRESH_MS = 5000;

// Refetches this page (query string included, so filters stay) every few seconds and swaps the
// region's contents. It pauses while the tab is hidden or someone is using a form field inside the
// region, and stops for good on anything but a 200, so an expired session (a redirect) doesn't loop.
const script = (intervalMs: number) => `(function () {
  var el = document.currentScript.previousElementSibling;
  var busy = false;
  var timer = setInterval(async function () {
    if (document.hidden || busy) return;
    var focused = document.activeElement;
    if (focused && focused !== el && el.contains(focused) && /^(INPUT|SELECT|TEXTAREA)$/.test(focused.tagName)) return;
    busy = true;
    try {
      var res = await fetch(location.href, { headers: { 'X-Admin-Fragment': '1' }, redirect: 'manual', credentials: 'same-origin' });
      if (res.status !== 200) return clearInterval(timer);
      el.innerHTML = await res.text();
    } catch (e) {
      /* offline: try again next tick */
    } finally {
      busy = false;
    }
  }, ${intervalMs});
})();`;

/** Wraps the part of a page that refreshes itself. Use at most once per page. */
export const LiveRegion: FC<PropsWithChildren<{ interval?: number }>> = ({ children, interval }) => {
  const ms = interval !== undefined && Number.isInteger(interval) && interval > 0 ? interval : DEFAULT_REFRESH_MS;
  return (
    <>
      <div data-live-region data-live-interval={String(ms)}>
        {children}
      </div>
      <script dangerouslySetInnerHTML={{ __html: script(ms) }} />
    </>
  );
};
