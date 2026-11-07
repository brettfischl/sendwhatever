// Works out what's new since the panel started watching. No DOM, so tests can run it on real responses.
//
// The first response is the baseline, because everything would otherwise flash on load. Each result
// says when an item appeared, so a redraw can carry on its highlight rather than restart it.

export const HIGHLIGHT_MS = 9000;

const rowKey = (row) => row.id ?? JSON.stringify(row.values);

export function createTracker() {
  let database;
  let baseline = true;
  let eventsBaseline = true;
  let appeared = 0;
  const tables = new Map();
  const events = new Map();

  const fresh = (since, now) => (since !== null && now - since < HIGHLIGHT_MS ? since : null);

  return {
    /** Takes a `ready` tables response. Returns its tables, newest first, each with highlight times. */
    tables(response, now) {
      if (response.database !== database) {
        database = response.database;
        baseline = true;
        appeared = 0;
        tables.clear();
      }
      const stamp = baseline ? null : now;
      baseline = false;

      for (const table of response.tables) {
        let seen = tables.get(table.name);
        if (!seen) {
          // Tables from the baseline stay alphabetical. After that, the newest goes on top.
          seen = { order: stamp === null ? 0 : ++appeared, since: stamp, count: table.rowCount, countSince: null, columns: new Map(), rows: new Map() };
          tables.set(table.name, seen);
        } else if (seen.count !== table.rowCount) {
          seen.count = table.rowCount;
          seen.countSince = now;
        }
        table.columns.forEach(({ name }) => {
          if (!seen.columns.has(name)) seen.columns.set(name, stamp);
        });
        for (const row of table.rows) {
          const key = rowKey(row);
          const known = seen.rows.get(key);
          if (!known) seen.rows.set(key, { since: stamp, kind: 'new', seq: row.seq, deleted: row.deleted });
          else if (known.seq !== row.seq || known.deleted !== row.deleted) {
            seen.rows.set(key, {
              since: now,
              kind: row.deleted && !known.deleted ? 'deleted' : 'updated',
              seq: row.seq,
              deleted: row.deleted,
            });
          }
        }
      }

      return response.tables
        .map((table) => {
          const seen = tables.get(table.name);
          return {
            ...table,
            order: seen.order,
            since: fresh(seen.since, now),
            countSince: fresh(seen.countSince, now),
            columns: table.columns.map((column) => ({ ...column, since: fresh(seen.columns.get(column.name), now) })),
            rows: table.rows.map((row) => {
              const known = seen.rows.get(rowKey(row));
              return { ...row, since: fresh(known.since, now), kind: known.kind };
            }),
          };
        })
        .sort((a, b) => b.order - a.order || a.name.localeCompare(b.name));
    },

    /** Takes a `ready` events response. Returns its events, each with highlight times. */
    events(response, now) {
      const stamp = eventsBaseline ? null : now;
      eventsBaseline = false;
      return response.events.map((event) => {
        let seen = events.get(event.id);
        if (!seen) {
          seen = { since: stamp, status: event.status, statusSince: null };
          events.set(event.id, seen);
        } else if (seen.status !== event.status) {
          seen.status = event.status;
          seen.statusSince = now;
        }
        return { ...event, since: fresh(seen.since, now), statusSince: fresh(seen.statusSince, now) };
      });
    },
  };
}
