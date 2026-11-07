import type { Context } from 'hono';
import type { FC, PropsWithChildren } from 'hono/jsx';

/** Sent by the refresh script. The route answers with only the live region's HTML. */
export const FRAGMENT_HEADER = 'x-admin-fragment';

export const isFragmentRequest = (c: Context) => c.req.header(FRAGMENT_HEADER) === '1';

// Refetches this page every 5s and swaps the region's contents. It pauses while the tab is hidden
// and stops for good on anything but a 200, so an expired session (a redirect) doesn't loop.
const SCRIPT = `(function () {
  var el = document.currentScript.previousElementSibling;
  var busy = false;
  var timer = setInterval(async function () {
    if (document.hidden || busy) return;
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
  }, 5000);
})();`;

/** Wraps the part of a page that refreshes itself. Use at most once per page. */
export const LiveRegion: FC<PropsWithChildren> = ({ children }) => (
  <>
    <div data-live-region>{children}</div>
    <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />
  </>
);
