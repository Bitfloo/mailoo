import type SchedulerService from '../services/scheduler.service.js';
import registerSchedulerTools from './scheduler.tool.js';

describe('schedule_email', () => {
  it('describes send_at as an ISO 8601 date-time with a UTC offset', () => {
    let sendAtDescription = '';
    const server = {
      tool: (
        name: string,
        _description: string,
        schema: { send_at?: { description?: string } },
      ) => {
        if (name === 'schedule_email') {
          sendAtDescription = schema.send_at?.description ?? '';
        }
      },
    };
    registerSchedulerTools(server as never, {} as SchedulerService);
    expect(sendAtDescription).toContain(
      'ISO 8601 date-time with UTC offset, e.g. 2026-10-01T09:00:00+02:00',
    );
  });
});
