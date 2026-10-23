import { LEAKED_SECRETS, leakedSecretsIn, valuesBesidesErrorFields } from './token-endpoint.js';

const [SECRET] = LEAKED_SECRETS;

/** Past the 50 bytes `inspect` prints of a Buffer, so only decoding the bytes can find it. */
const BURIED_BYTES = new TextEncoder().encode(`${'x'.repeat(100)}${SECRET}`);

/** `inspect` hides non-enumerable properties, so only walking the own properties finds the secret. */
function hiddenSecret<T extends object>(holder: T, key: PropertyKey = 'body'): T {
  return Object.defineProperty(holder, key, { value: SECRET });
}

/** `innermost` wrapped in `links` errors, so it sits `links` causes down. */
function causeChainDown(links: number, innermost: Error): Error {
  let outer = innermost;
  for (let link = 0; link < links; link += 1) outer = new Error('wrapper', { cause: outer });
  return outer;
}

function errorThatIsItsOwnCause(): Error {
  const error = hiddenSecret(new Error('refused'));
  error.cause = error;
  return error;
}

function objectThatHoldsItself(): Record<string, unknown> {
  const holder: Record<string, unknown> = hiddenSecret({});
  holder.self = holder;
  return holder;
}

describe('leakedSecretsIn', () => {
  it.each([
    { name: 'the message', subject: new Error(`refused: ${SECRET}`) },
    { name: 'an own property', subject: Object.assign(new Error('refused'), { body: SECRET }) },
    {
      name: 'a non-enumerable own property',
      subject: Object.defineProperty(new Error('refused'), 'body', { value: SECRET }),
    },
    {
      name: 'a non-enumerable property of a cause two links down',
      subject: new Error('refused', {
        cause: new Error('middle', {
          cause: Object.defineProperty(new Error('deepest'), 'body', { value: SECRET }),
        }),
      }),
    },
    {
      name: 'a Buffer property',
      subject: Object.assign(new Error('refused'), { body: Buffer.from(BURIED_BYTES) }),
    },
    {
      name: 'a non-enumerable Buffer property',
      subject: Object.defineProperty(new Error('refused'), 'body', {
        value: Buffer.from(BURIED_BYTES),
      }),
    },
    {
      name: 'a Buffer nested in an object property',
      subject: Object.assign(new Error('refused'), {
        response: { status: 502, body: Buffer.from(BURIED_BYTES) },
      }),
    },
    {
      name: 'a Buffer in a cause that is a plain object',
      subject: new Error('refused', { cause: { status: 502, body: Buffer.from(BURIED_BYTES) } }),
    },
    {
      name: 'a Buffer inside plain data',
      subject: { entries: [{ params: { body: Buffer.from(BURIED_BYTES) } }] },
    },
    {
      name: 'a Uint8Array property',
      subject: Object.assign(new Error('refused'), { body: BURIED_BYTES }),
    },
    {
      name: 'an ArrayBuffer property',
      subject: Object.assign(new Error('refused'), { body: BURIED_BYTES.buffer }),
    },
    {
      name: 'an object nested four levels below the error',
      subject: Object.assign(new Error('refused'), { response: { a: { b: { c: SECRET } } } }),
    },
    {
      name: 'the 150th item of an array',
      subject: { entries: Array.from({ length: 150 }, (_, i) => (i === 149 ? SECRET : 'ok')) },
    },
    {
      name: 'a string of 20 000 characters',
      subject: { text: `${'x'.repeat(20_000)}${SECRET}` },
    },
    {
      name: 'a non-enumerable property that holds an object',
      subject: Object.defineProperty(new Error('refused'), 'response', {
        value: { body: SECRET },
      }),
    },
    {
      name: 'a non-enumerable Symbol-keyed property',
      subject: Object.defineProperty(new Error('refused'), Symbol('raw'), { value: SECRET }),
    },
    {
      name: 'an object held as a Map value',
      subject: Object.defineProperty(new Error('refused'), 'response', {
        value: new Map([['body', { text: SECRET }]]),
      }),
    },
    {
      name: 'an object held as a Map key',
      subject: Object.defineProperty(new Error('refused'), 'response', {
        value: new Map([[{ text: SECRET }, 'body']]),
      }),
    },
    {
      name: 'an object held as a Set item',
      subject: Object.defineProperty(new Error('refused'), 'response', {
        value: new Set([{ text: SECRET }]),
      }),
    },
    {
      name: 'a non-enumerable property of a Buffer',
      subject: hiddenSecret(Buffer.from('plain')),
    },
    {
      name: 'a non-enumerable property of a cause 12 links down',
      subject: causeChainDown(12, hiddenSecret(new Error('innermost'))),
    },
    {
      name: 'an error that is its own cause, next to a non-cyclic property',
      subject: errorThatIsItsOwnCause(),
    },
    {
      name: 'an object that holds itself, next to a non-cyclic property',
      subject: objectThatHoldsItself(),
    },
    {
      name: 'a Headers object property',
      subject: Object.assign(new Error('refused'), {
        headers: new Headers({ authorization: SECRET }),
      }),
    },
    {
      name: 'a Headers object in a non-enumerable property',
      subject: Object.defineProperty(new Error('refused'), 'headers', {
        value: new Headers({ authorization: SECRET }),
      }),
    },
    {
      name: 'a URL object property',
      subject: Object.assign(new Error('refused'), {
        url: new URL(`https://auth.example.test/token?code=${SECRET}`),
      }),
    },
  ])('should find a secret in $name', ({ subject }) => {
    expect(leakedSecretsIn(subject)).toEqual([SECRET]);
  });

  it('should find a secret that only the stack of an edited error still holds', () => {
    const error = new Error(`refused: ${SECRET}`);
    // V8 builds the stack text on first read, so it keeps the message as it was then.
    const stackHeld = error.stack?.includes(SECRET);
    error.message = 'redacted';
    expect({ stackHeld, found: leakedSecretsIn(error) }).toEqual({
      stackHeld: true,
      found: [SECRET],
    });
  });

  it('should skip an accessor without invoking it and still find the secret beside it', () => {
    const accessor = vi.fn(() => {
      throw new Error('accessor invoked');
    });
    const subject = Object.defineProperty(new Error(`refused: ${SECRET}`), 'body', {
      get: accessor,
    });
    expect({ found: leakedSecretsIn(subject), invoked: accessor.mock.calls.length }).toEqual({
      found: [SECRET],
      invoked: 0,
    });
  });

  it('should report nothing for an error that holds no secret', () => {
    expect(leakedSecretsIn(Object.assign(new Error('refused'), { body: 'plain' }))).toEqual([]);
  });

  // Node packs small Buffers into one shared ArrayBuffer, so the bytes around a view are not its own.
  it.each([
    { name: 'a pooled Buffer', subject: Buffer.from(`${SECRET}plain`).subarray(SECRET.length) },
    {
      name: 'a byte view that starts right after the secret',
      subject: new TextEncoder()
        .encode(`${SECRET}${'x'.repeat(SECRET.length)}`)
        .subarray(SECRET.length),
    },
    {
      name: 'a byte view that ends right before the secret',
      subject: new TextEncoder()
        .encode(`${'x'.repeat(SECRET.length)}${SECRET}`)
        .subarray(0, SECRET.length),
    },
  ])('should report nothing for $name when the secret sits outside the view', ({ subject }) => {
    expect(leakedSecretsIn(subject)).toEqual([]);
  });

  it('should not report a secret split across two strings', () => {
    const [first, second] = [SECRET.slice(0, 10), SECRET.slice(10)];
    // The first half on both sides, so the halves meet whichever order the walk visits them.
    expect(leakedSecretsIn({ a: first, b: second, c: first })).toEqual([]);
  });

  it('should look for the secrets it is given instead of the default ones', () => {
    expect(leakedSecretsIn(new Error(`${SECRET} trace-1`), ['trace-1', 'trace-2'])).toEqual([
      'trace-1',
    ]);
  });
});

describe('leakedSecretsIn with fragments', () => {
  it.each([
    { name: 'its first 8 characters', piece: SECRET.slice(0, 8) },
    { name: 'its last 8 characters', piece: SECRET.slice(-8) },
    { name: '8 characters from its middle', piece: SECRET.slice(6, 14) },
  ])('should report a secret when only $name appear', ({ piece }) => {
    expect(leakedSecretsIn(new Error(`refused: ${piece}`), [SECRET], { fragments: true })).toEqual([
      SECRET,
    ]);
  });

  it('should not report a secret when only 7 of its characters appear', () => {
    const piece = SECRET.slice(0, 7);
    expect(leakedSecretsIn(new Error(`refused: ${piece}`), [SECRET], { fragments: true })).toEqual(
      [],
    );
  });

  it('should report only whole secrets when fragments are not asked for', () => {
    expect(leakedSecretsIn(new Error(`refused: ${SECRET.slice(0, 12)}`), [SECRET])).toEqual([]);
  });

  it('should report a secret shorter than 8 characters when it appears whole', () => {
    expect(
      leakedSecretsIn(new Error('refused: trace-1'), ['trace-1'], { fragments: true }),
    ).toEqual(['trace-1']);
  });
});

describe('valuesBesidesErrorFields', () => {
  it('should list every value outside error and error_description, numbers as text', () => {
    expect(
      valuesBesidesErrorFields({
        error: 'invalid_grant',
        error_description: 'expired',
        error_uri: 'https://example.test/e',
        error_codes: [70_000, 70_001],
        nested: { trace: 'abc', list: [{ id: 'def' }] },
      }),
    ).toEqual(['https://example.test/e', '70000', '70001', 'abc', 'def']);
  });
});
