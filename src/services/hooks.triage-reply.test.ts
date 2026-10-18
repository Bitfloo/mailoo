import HooksService from './hooks.service.js';

describe('HooksService.parseTriageResponse', () => {
  const parse = (text: string, count = 1) => HooksService.parseTriageResponse(text, count);

  it.each([
    ['a json fence', '```json\n[{"priority":"high"}]\n```'],
    ['a plain fence', '```\n[{"priority":"high"}]\n```'],
  ])('should read a reply wrapped in %s', (_case, text) => {
    expect(parse(text)).toEqual([{ priority: 'high' }]);
  });

  it.each(['urgent', 'high', 'normal', 'low'])('should keep the priority %s', (priority) => {
    expect(parse(JSON.stringify([{ priority }]))[0]?.priority).toBe(priority);
  });

  it('should drop a priority outside the four levels', () => {
    expect(parse('[{"priority":"critical"}]')[0]?.priority).toBeUndefined();
  });

  it('should drop labels that are not strings', () => {
    expect(parse('[{"labels":["Work",7,null,"Q4"]}]')[0]?.labels).toEqual(['Work', 'Q4']);
  });

  it('should keep the first five labels', () => {
    const labels = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(parse(JSON.stringify([{ labels }]))[0]?.labels).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('should cut an action at 200 characters', () => {
    const action = `${'a'.repeat(200)}tail`;
    expect(parse(JSON.stringify([{ action }]))[0]?.action).toBe('a'.repeat(200));
  });

  it.each([
    [true, true],
    [false, false],
    ['yes', undefined],
  ])('should read flag %j as %j', (flag, expected) => {
    expect(parse(JSON.stringify([{ flag }]))[0]?.flag).toBe(expected);
  });

  it.each([
    [true, true],
    ['yes', undefined],
  ])('should read add_to_calendar %j as %j', (value, expected) => {
    expect(parse(JSON.stringify([{ add_to_calendar: value }]))[0]?.addToCalendar).toBe(expected);
  });

  it('should give a null element an empty result and keep the next one', () => {
    expect(parse('[null,{"priority":"low"}]', 2)).toEqual([{}, { priority: 'low' }]);
  });

  it('should keep one result per email when the reply holds more', () => {
    expect(parse('[{"priority":"high"},{"priority":"low"}]', 1)).toEqual([{ priority: 'high' }]);
  });

  it('should read a single object reply as the first result', () => {
    expect(parse('{"priority":"urgent"}', 2)).toEqual([{ priority: 'urgent' }]);
  });

  it('should give one empty result per email when the reply is not JSON', () => {
    expect(parse('I cannot help with that.', 2)).toEqual([{}, {}]);
  });
});
