// Works out what's new since the panel started watching. No DOM, so tests can run it on real responses.
//
// The first response is the baseline, because everything would otherwise flash on load. Each result
// says when an item appeared, so a redraw can carry on its highlight rather than restart it.

export const HIGHLIGHT_MS = 9000;

const rowKey = (row) => row.id ?? JSON.stringify(row.values);

/** By column name and without nulls, so adding a column doesn't count as changing every row. */
const rowContent = (row, columns) =>
  JSON.stringify([
    row.seq,
    row.deleted,
    columns.flatMap(({ name }, index) => (row.values[index] === null ? [] : [[name, row.values[index]]])),
  ]);

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
        // Only the latest rows are sent, so a row not seen before may be an old one that was just
        // merged into. Only as many as the count grew by can really be new.
        let newRows = Math.max(0, table.rowCount - (seen?.count ?? 0));
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
          const content = rowContent(row, table.columns);
          if (!known && newRows > 0) {
            newRows -= 1;
            seen.rows.set(key, { since: stamp, kind: 'new', content, deleted: row.deleted });
          } else if (!known) {
            seen.rows.set(key, { since: stamp, kind: row.deleted ? 'deleted' : 'updated', content, deleted: row.deleted });
          } else if (known.content !== content) {
            const kind = row.deleted && !known.deleted ? 'deleted' : 'updated';
            seen.rows.set(key, { since: now, kind, content, deleted: row.deleted });
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
