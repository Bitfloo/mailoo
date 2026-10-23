import toIsoDate from './iso-date.js';

describe('toIsoDate', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2028-01-15T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should give the ISO form of a valid Date', () => {
    expect(toIsoDate(new Date('2026-03-02T09:00:00Z'))).toBe('2026-03-02T09:00:00.000Z');
  });

  it('should give the ISO form of a string that parses to a valid date', () => {
    expect(toIsoDate('Mon, 02 Mar 2026 09:00:00 +0000')).toBe('2026-03-02T09:00:00.000Z');
  });

  it.each([
    ['an unparseable string', 'Thursday, sometime last week'],
    ['an empty string', ''],
    ['undefined', undefined],
    ['null', null],
    ['an invalid Date', new Date(Number.NaN)],
  ])('should date %s when it was seen', (_label, value) => {
    expect(toIsoDate(value)).toBe('2028-01-15T00:00:00.000Z');
  });
});
