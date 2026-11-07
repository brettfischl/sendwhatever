// Runs inside the isolate, before any adapter code. It hardens the context and returns the function
// that child.mjs calls. Adapter code is hostile and can change every builtin it can reach, so `run`
// and `encode` only use the functions captured below, and never for-of, spread, array methods, or a
// property that could be inherited from a tampered prototype. This code must stay strict, so a stack
// trace's CallSite.getFunction() can't hand these functions to an adapter.
(function () {
  'use strict';

  const global = globalThis;
  const { construct, defineProperty, deleteProperty, getOwnPropertyDescriptor, getPrototypeOf, ownKeys } = Reflect;
  const { parse, stringify } = JSON;
  const { isArray } = Array;
  const { hasOwn } = Object;
  const { isSafeInteger } = Number;
  const toStr = String;
  const ObjectPrototype = Object.prototype;
  const ArrayPrototype = Array.prototype;
  const RealDate = Date;
  // Calling eval under another name evaluates in global scope, away from this closure.
  const globalEval = eval;

  const MAX_DEPTH = 256;

  // An allowlist, so a builtin added by a future V8 stays out until someone looks at it. Left out on
  // purpose: WebAssembly (its memory isn't counted by the memory limit), SharedArrayBuffer and Atomics,
  // WeakRef and FinalizationRegistry (their results depend on the GC), Intl (formats the current time
  // when called with no argument), Proxy (so encode can't run adapter code), and console.
  const ALLOWED_GLOBALS = new Set([
    'Object', 'Function', 'Array', 'Number', 'Boolean', 'String', 'Symbol', 'BigInt',
    'Date', 'Promise', 'RegExp', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Iterator',
    'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
    'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array',
    'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
    'JSON', 'Math', 'Reflect',
    'parseFloat', 'parseInt', 'isNaN', 'isFinite', 'eval',
    'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent', 'escape', 'unescape',
    'globalThis', 'Infinity', 'NaN', 'undefined',
  ]);
  for (const name of ownKeys(global)) {
    if (!ALLOWED_GLOBALS.has(name)) deleteProperty(global, name);
  }

  // Replays must produce identical output (PRD §12), so nothing here can read the clock or randomness.
  deleteProperty(Math, 'random');

  const clockError = 'The clock is not available in an adapter: pass a value, such as a date from the payload.';
  const SafeDate = function Date(...args) {
    if (new.target === undefined || args.length === 0) throw new TypeError(clockError);
    return construct(RealDate, args, new.target);
  };
  defineProperty(SafeDate, 'length', { value: 7, configurable: true });
  defineProperty(SafeDate, 'prototype', { value: RealDate.prototype, writable: false });
  defineProperty(SafeDate, 'UTC', { value: RealDate.UTC, writable: true, configurable: true });
  defineProperty(SafeDate, 'parse', { value: RealDate.parse, writable: true, configurable: true });
  defineProperty(RealDate.prototype, 'constructor', { value: SafeDate, writable: true, configurable: true });
  defineProperty(global, 'Date', { value: SafeDate, writable: true, configurable: true });

  /** Integers a double can't hold exactly become strings, so a long numeric ID isn't rounded. */
  function keepLargeIntegers(_key, value, context) {
    if (typeof value === 'number' && !isSafeInteger(value) && /^-?\d+$/.test(context.source)) {
      return context.source;
    }
    return value;
  }

  /** Reads a data property without running a getter. Inherited `get` and `value` keys don't count. */
  function readData(object, key, path) {
    const descriptor = getOwnPropertyDescriptor(object, key);
    if (descriptor === undefined) return undefined;
    if (!hasOwn(descriptor, 'value')) throw path + ': getters and setters cannot leave the sandbox';
    return descriptor.value;
  }

  /**
   * Encodes a value as JSON that tells `undefined` from a missing key and keeps every number. Strings,
   * finite numbers, booleans and null stand for themselves. Everything else is an array with a tag:
   * ["u"] undefined, ["n"] NaN, ["i"] Infinity, ["-i"] -Infinity, ["a", ...items],
   * ["o", key, value, ...]. Nothing here can run adapter code: getters aren't called and proxies
   * can't exist.
   */
  function encode(value, path, depth) {
    switch (typeof value) {
      case 'string':
        return stringify(value);
      case 'boolean':
        return value ? 'true' : 'false';
      case 'undefined':
        return '["u"]';
      case 'number':
        if (value !== value) return '["n"]';
        if (value === Infinity) return '["i"]';
        if (value === -Infinity) return '["-i"]';
        if (value === 0 && 1 / value < 0) return '-0';
        return stringify(value);
      case 'object':
        if (value === null) return 'null';
        break;
      default:
        throw path + ': a ' + typeof value + ' cannot leave the sandbox';
    }
    if (depth >= MAX_DEPTH) throw path + ': output is circular or nested more than ' + MAX_DEPTH + ' levels deep';

    const prototype = getPrototypeOf(value);
    const keys = ownKeys(value);
    if (isArray(value)) {
      if (prototype !== ArrayPrototype) throw path + ': only plain arrays can leave the sandbox';
      const length = readData(value, 'length', path);
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i];
        if (key === 'length') continue;
        if (typeof key !== 'string' || key !== '' + (key >>> 0) || key >>> 0 >= length) {
          throw path + ': an array cannot have named properties';
        }
      }
      let out = '["a"';
      for (let i = 0; i < length; i += 1) {
        out += ',' + encode(readData(value, i, path + '[' + i + ']'), path + '[' + i + ']', depth + 1);
      }
      return out + ']';
    }

    if (prototype !== ObjectPrototype && prototype !== null) {
      throw path + ': only plain objects and arrays can leave the sandbox, so convert a Date with toISOString() ' +
        'and return a value rather than a promise';
    }
    let out = '["o"';
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (typeof key !== 'string') throw path + ': symbol keys cannot leave the sandbox';
      const childPath = path + '.' + key;
      const descriptor = getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable) throw childPath + ': non-enumerable properties cannot leave the sandbox';
      out += ',' + stringify(key) + ',' + encode(readData(value, key, childPath), childPath, depth + 1);
    }
    return out + ']';
  }

  /** Finds a string property on the object or its prototypes, without running a getter. */
  function findString(object, key) {
    for (let current = object; current !== null; current = getPrototypeOf(current)) {
      const descriptor = getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined) {
        return hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' ? descriptor.value : undefined;
      }
    }
    return undefined;
  }

  function describeThrown(thrown) {
    if ((typeof thrown !== 'object' && typeof thrown !== 'function') || thrown === null) return toStr(thrown);
    const message = findString(thrown, 'message');
    const name = findString(thrown, 'name');
    if (message === undefined) return name === undefined ? 'threw a value that is not an Error' : name;
    return name === undefined ? message : name + ': ' + message;
  }

  function failure(tag, detail) {
    return '[' + stringify(tag) + ',' + stringify(detail) + ']';
  }

  /** Returns the result as a string, the only thing that crosses back to the host. */
  return function run(code, body, requestJson) {
    let payload;
    try {
      payload = { data: body === '' ? null : parse(body, keepLargeIntegers), request: parse(requestJson) };
    } catch (error) {
      return failure('invalid_body', describeThrown(error));
    }

    let adapt;
    let output;
    try {
      // The appended line also finds an `adapt` declared with const or let, which eval keeps to itself.
      // The newline ends any trailing comment. child.mjs has already checked that the code parses.
      adapt = globalEval(code + '\n;typeof adapt === "function" ? adapt : undefined');
      if (typeof adapt !== 'function') return failure('no_adapter', 'The code does not define a function named adapt.');
      output = adapt(payload);
    } catch (error) {
      return failure('threw', describeThrown(error));
    }

    try {
      return '["ok",' + encode(output, '$', 0) + ']';
    } catch (error) {
      return failure('invalid_output', typeof error === 'string' ? error : describeThrown(error));
    }
  };
})();
