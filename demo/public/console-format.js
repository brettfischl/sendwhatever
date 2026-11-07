// JSON helpers for the console: checking, formatting, and coloring. No DOM beyond text nodes and spans.

/** Above this size, redrawing colors on every keystroke would lag, so the editor goes plain. */
export const MAX_HIGHLIGHT_CHARS = 200_000;

const TOKENS = /("(?:[^"\\\n]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

/** Colors whatever JSON-like text it's given. Broken JSON is still colored as far as it matches. */
export function highlightJson(text) {
  const fragment = document.createDocumentFragment();
  const span = (className, content) => {
    const element = document.createElement('span');
    element.className = className;
    element.textContent = content;
    fragment.append(element);
  };
  let last = 0;
  for (const match of text.matchAll(TOKENS)) {
    fragment.append(text.slice(last, match.index));
    const [whole, string, colon, number, literal] = match;
    if (string && colon) {
      span('tok-key', string);
      fragment.append(colon);
    } else if (string) span('tok-string', string);
    else if (number) span('tok-number', number);
    else if (literal) span('tok-literal', literal);
    last = match.index + whole.length;
  }
  fragment.append(text.slice(last));
  return fragment;
}

/**
 * What ingest will make of this text. `empty` is the only state that depends on the method,
 * since only a DELETE may have no body (PRD §13.1).
 */
export function checkBody(text, method) {
  if (!text.trim()) {
    return method === 'DELETE'
      ? { state: 'empty', message: 'No body, which is fine for a DELETE' }
      : { state: 'invalid', message: `A ${method} needs a body: empty isn't valid JSON` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { state: 'invalid', ...describeParseError(error, text) };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { state: 'scalar', message: 'Valid JSON, but not an object or array: ingest will call it malformed' };
  }
  return { state: 'valid', message: Array.isArray(parsed) ? 'Valid JSON array' : 'Valid JSON object' };
}

/** Browsers word this differently, and only some give a line and column. */
function describeParseError(error, text) {
  const message = error.message
    .replace(/^JSON\.parse: /, '')
    .replace(/ (in JSON )?at (position|line) .*$/, '')
    .replace(/ of the JSON data$/, '');
  const lineColumn = /line (\d+) column (\d+)/.exec(error.message);
  const position = /position (\d+)/.exec(error.message);
  let offset = text.length;
  if (position) offset = Number(position[1]);
  else if (lineColumn) offset = offsetOf(text, Number(lineColumn[1]), Number(lineColumn[2]));
  const before = text.slice(0, offset).split('\n');
  return {
    message,
    offset,
    line: before.length,
    column: before.at(-1).length + 1,
  };
}

function offsetOf(text, line, column) {
  const lines = text.split('\n').slice(0, line - 1);
  return lines.reduce((sum, current) => sum + current.length + 1, 0) + column - 1;
}

/**
 * Re-indents valid JSON by its tokens, not by parsing and printing: that would quietly change what's
 * sent, by rounding big numbers, rewriting 1.10 as 1.1, and dropping duplicate keys.
 */
export function formatJson(text) {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:,]|[^\s{}[\]:,"]+/g) ?? [];
  const pad = (depth) => '\n' + '  '.repeat(depth);
  let out = '';
  let depth = 0;
  tokens.forEach((token, i) => {
    if (token === '{' || token === '[') {
      const next = tokens[i + 1];
      out += token;
      if (next !== '}' && next !== ']') out += pad(depth + 1);
      depth += 1;
    } else if (token === '}' || token === ']') {
      const previous = tokens[i - 1];
      depth -= 1;
      if (previous !== '{' && previous !== '[') out += pad(depth);
      out += token;
    } else if (token === ',') out += ',' + pad(depth);
    else if (token === ':') out += ': ';
    else out += token;
  });
  return out;
}
