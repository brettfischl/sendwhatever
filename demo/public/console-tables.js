// The console's live tables view. The panel reads its own state from the server, so it needs nothing
// from the console's context.
import '/assets/tables-panel.js';

export function mount(slot) {
  const panel = document.createElement('sw-live-tables');
  slot.append(panel);
  return () => panel.remove();
}
