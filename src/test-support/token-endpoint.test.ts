import { LEAKED_SECRETS, leakedSecretsIn, valuesBesidesErrorFields } from './token-endpoint.js';

const [SECRET] = LEAKED_SECRETS;

/** Past the 50 bytes `inspect` prints of a Buffer, so only decoding the bytes can find it. */
const BURIED_BYTES = new TextEncoder().encode(`${'x'.repeat(100)}${SECRET}`);

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
      name: 'an object nested deeper than inspect goes by default',
      subject: Object.assign(new Error('refused'), { response: { a: { b: { c: SECRET } } } }),
    },
    {
      name: 'an array item past the 100 inspect prints',
      subject: { entries: Array.from({ length: 150 }, (_, i) => (i === 149 ? SECRET : 'ok')) },
    },
    {
      name: 'a string past the 10000 characters inspect prints',
      subject: { text: `${'x'.repeat(20_000)}${SECRET}` },
    },
  ])('should find a secret in $name', ({ subject }) => {
    expect(leakedSecretsIn(subject)).toEqual([SECRET]);
  });

  it('should report nothing for an error that holds no secret', () => {
    expect(leakedSecretsIn(Object.assign(new Error('refused'), { body: 'plain' }))).toEqual([]);
  });

  it('should look for the secrets it is given instead of the default ones', () => {
    expect(leakedSecretsIn(new Error(`${SECRET} trace-1`), ['trace-1', 'trace-2'])).toEqual([
      'trace-1',
    ]);
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
