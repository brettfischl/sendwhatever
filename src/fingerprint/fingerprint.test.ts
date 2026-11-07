import { describe, expect, it } from 'vitest';
import {
  FINGERPRINT_LENGTH,
  FINGERPRINT_VERSION,
  FingerprintDepthError,
  MAX_DEPTH,
  fingerprint,
  fingerprintOfShape,
  shapeOf,
} from './index.js';

/** Fingerprints the body as `/ingest` will see it: the output of plain JSON.parse. */
function fp(json: string): string {
  return fingerprint(JSON.parse(json));
}

function shape(json: string): string {
  return shapeOf(JSON.parse(json));
}

/** `levels` arrays nested inside each other, e.g. 2 → `[[]]`. */
function nestedArrays(levels: number): unknown {
  let value: unknown[] = [];
  for (let i = 1; i < levels; i++) value = [value];
  return value;
}

describe('shapeOf', () => {
  it('matches the PRD object example', () => {
    expect(
      shape('{ "email": "a", "profile": { "first_name": "b" }, "orders": [{"sku":"c"}] }'),
    ).toBe('{"email":"string","orders":[{"sku":"string"}],"profile":{"first_name":"string"}}');
  });

  it('matches the PRD mixed-array example', () => {
    expect(shape('[{"msg":"hi"},{"msg":5}]')).toBe('[{"msg":"number"},{"msg":"string"}]');
  });

  it('names primitives by JSON type', () => {
    expect(shape('"x"')).toBe('"string"');
    expect(shape('1.5')).toBe('"number"');
    expect(shape('false')).toBe('"boolean"');
  });

  it('gives a missing or null body the shape null', () => {
    expect(shapeOf(undefined)).toBe('null');
    expect(shapeOf(null)).toBe('null');
  });

  it('keeps empty containers as they are', () => {
    expect(shape('{}')).toBe('{}');
    expect(shape('[]')).toBe('[]');
    expect(shape('{"a":null,"b":null}')).toBe('{}');
    expect(shape('[null,null]')).toBe('[]');
    // Known quirk: an empty array differs from a populated one.
    expect(shape('{"items":[]}')).not.toBe(shape('{"items":[{"id":1}]}'));
  });

  it('sorts keys by code unit, so uppercase comes before lowercase', () => {
    expect(shape('{"a":1,"B":1,"_":1}')).toBe('{"B":"number","_":"number","a":"number"}');
  });

  it('sorts integer-like keys as strings', () => {
    expect(shape('{"9":1,"10":1,"a":1}')).toBe('{"10":"number","9":"number","a":"number"}');
  });

  it('escapes keys as JSON', () => {
    expect(shape('{"say \\"hi\\"":1}')).toBe('{"say \\"hi\\"":"number"}');
  });

  it('treats __proto__ as an ordinary key', () => {
    expect(shape('{"__proto__":{"x":1}}')).toBe('{"__proto__":{"x":"number"}}');
  });

  it('skips values JSON.parse cannot produce instead of throwing', () => {
    expect(shapeOf({ a: undefined, b: 1 })).toBe('{"b":"number"}');
    expect(shapeOf([undefined, 'x'])).toBe('["string"]');
  });
});

describe('fingerprint', () => {
  it('is 16 lowercase hex characters', () => {
    expect(FINGERPRINT_LENGTH).toBe(16);
    expect(FINGERPRINT_VERSION).toBe(1);
    expect(fp('{"a":1}')).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint(undefined)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic and equals the hash of the shape', () => {
    const body = '{"email":"a","orders":[{"sku":"c"}]}';
    expect(fp(body)).toBe(fp(body));
    expect(fp(body)).toBe(fingerprintOfShape(shape(body)));
  });

  it('is the first 16 hex characters of SHA-256 of the shape', () => {
    // SHA-256("{}") = 44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a
    expect(fp('{}')).toBe('44136fa355b3678a');
  });

  it('ignores values', () => {
    expect(fp('{"email":"a@b.c","age":30,"ok":true}')).toBe(
      fp('{"email":"","age":-1.5,"ok":false}'),
    );
  });

  it('ignores key order', () => {
    expect(fp('{"a":1,"b":{"c":"x","d":true}}')).toBe(fp('{"b":{"d":false,"c":"y"},"a":2}'));
  });

  it('distinguishes field types', () => {
    expect(fp('{"id":1}')).not.toBe(fp('{"id":"1"}'));
    expect(fp('{"id":true}')).not.toBe(fp('{"id":1}'));
    expect(fp('{"id":{}}')).not.toBe(fp('{"id":[]}'));
  });

  it('distinguishes added and missing fields', () => {
    expect(fp('{"a":1}')).not.toBe(fp('{"a":1,"b":1}'));
  });

  it('treats a huge integer as a plain number', () => {
    expect(fp('{"id": 12345678901234567890}')).toBe(fp('{"id": 1}'));
  });

  describe('nulls', () => {
    it('skips null-valued keys', () => {
      expect(fp('{"a":null,"b":1}')).toBe(fp('{"b":1}'));
    });

    it('skips null array elements', () => {
      expect(fp('[null,{"a":1},null]')).toBe(fp('[{"a":1}]'));
    });

    it('gives a missing body the same fingerprint as null', () => {
      expect(fingerprint(undefined)).toBe(fingerprint(null));
      expect(fingerprint(null)).toBe(fingerprintOfShape('null'));
    });
  });

  describe('arrays', () => {
    it('ignores length', () => {
      expect(fp('[{"msg":"hi"},{"msg":"hello!"}]')).toBe(fp('[{"msg":"hi"}]'));
    });

    it('ignores order', () => {
      expect(fp('[1,"a",true]')).toBe(fp('[true,1,"a"]'));
      expect(fp('[{"msg":5},{"msg":"hi"}]')).toBe(fp('[{"msg":"hi"},{"msg":5}]'));
    });

    it('collapses duplicate shapes', () => {
      expect(shape('[1,2,3,"a","b"]')).toBe('["number","string"]');
    });

    it('lists each distinct shape of a mixed array in sorted order', () => {
      expect(shape('[true,{"a":1},"s",[1],2]')).toBe(
        '["boolean","number","string",["number"],{"a":"number"}]',
      );
      expect(fp('[{"msg":"hi"},{"msg":5}]')).not.toBe(fp('[{"msg":"hi"}]'));
    });

    it('handles nested arrays', () => {
      expect(shape('[[1,2],[3],["a"]]')).toBe('[["number"],["string"]]');
      expect(shape('{"m":[[{"a":1}],[{"a":2},{"b":"x"}]]}')).toBe(
        '{"m":[[{"a":"number"},{"b":"string"}],[{"a":"number"}]]}',
      );
    });
  });

  describe('depth', () => {
    it(`accepts nesting of exactly MAX_DEPTH (${MAX_DEPTH})`, () => {
      expect(() => fingerprint(nestedArrays(MAX_DEPTH))).not.toThrow();
      expect(shapeOf(nestedArrays(MAX_DEPTH))).toBe('['.repeat(MAX_DEPTH) + ']'.repeat(MAX_DEPTH));
    });

    it('throws FingerprintDepthError beyond MAX_DEPTH', () => {
      expect(() => fingerprint(nestedArrays(MAX_DEPTH + 1))).toThrow(FingerprintDepthError);
      let deepObject: unknown = {};
      for (let i = 0; i < MAX_DEPTH; i++) deepObject = { a: deepObject };
      expect(() => shapeOf(deepObject)).toThrow(FingerprintDepthError);
    });

    it('throws a FingerprintDepthError rather than overflowing on very deep input', () => {
      const error = (() => {
        try {
          shapeOf(JSON.parse('['.repeat(100_000) + ']'.repeat(100_000)));
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(FingerprintDepthError);
      expect(error).toBeInstanceOf(Error);
    });

    it('handles wide input', () => {
      const wide = Array.from({ length: 100_000 }, (_, i) => ({ [`k${i % 50}`]: i }));
      expect(shapeOf(wide).startsWith('[{"k0":"number"},{"k1":"number"},{"k10":"number"}')).toBe(
        true,
      );
    });
  });
});
