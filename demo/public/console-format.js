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

/**
 * Browsers word this differently, and V8 often gives no position at all, so the wording is theirs
 * and the location is ours.
 */
function describeParseError(error, text) {
  const message = error.message
    .replace(/^JSON\.parse: /, '')
    .replace(/, (\.\.\.)?".*$/s, '')
    .replace(/ (in JSON )?at (position|line) .*$/, '')
    .replace(/ of the JSON data$/, '');
  const offset = firstErrorOffset(text);
  const before = text.slice(0, offset).split('\n');
  return { message, offset, line: before.length, column: before.at(-1).length + 1 };
}

const JSON_STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const JSON_SCALAR = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/** Where JSON.parse's complaint is, found by walking the text. Only called on text that failed to parse. */
function firstErrorOffset(text) {
  let i = 0;
  const skipSpace = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i += 1;
  };
  const consume = (pattern) => {
    pattern.lastIndex = i;
    const match = pattern.exec(text);
    if (!match) throw i;
    i += match[0].length;
  };
  const expect = (character) => {
    if (text[i] !== character) throw i;
    i += 1;
  };
  const list = (close, item) => {
    i += 1;
    skipSpace();
    if (text[i] === close) {
      i += 1;
      return;
    }
    for (;;) {
      item();
      skipSpace();
      if (text[i] !== ',') break;
      i += 1;
      skipSpace();
    }
    expect(close);
  };
  const value = () => {
    skipSpace();
    if (text[i] === '{') {
      list('}', () => {
        consume(JSON_STRING);
        skipSpace();
        expect(':');
        value();
      });
    } else if (text[i] === '[') list(']', value);
    else if (text[i] === '"') consume(JSON_STRING);
    else consume(JSON_SCALAR);
  };
  try {
    value();
    skipSpace();
    return i;
  } catch (stoppedAt) {
    // Anything but an offset means the walk itself gave out, as on extremely deep nesting.
    return typeof stoppedAt === 'number' ? stoppedAt : text.length;
  }
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
