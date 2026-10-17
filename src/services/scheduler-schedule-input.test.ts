import {
  createService,
  daysFromNow,
  jsonNames,
  scheduledDir,
} from '../test-support/scheduler-fixtures.js';

/** Two days ahead, minute precision. A numeric offset is still in the future. */
function futureMinute(offset: 'Z' | '+02:00'): string {
  const when = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const year = when.getUTCFullYear();
  const month = String(when.getUTCMonth() + 1).padStart(2, '0');
  const day = String(when.getUTCDate()).padStart(2, '0');
  const hour = String(when.getUTCHours()).padStart(2, '0');
  const minute = String(when.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}${offset}`;
}

describe('SchedulerService queue files', () => {
  it('accepts a send_at value with minute precision and a Z offset', async () => {
    const { service } = createService();
    const sendAt = futureMinute('Z');
    const scheduled = await service.schedule('personal', {
      to: ['user@example.com'],
      subject: 'Hello',
      body: 'Body',
      sendAt,
    });
    expect(scheduled.sendAt).toBe(new Date(sendAt).toISOString());
  });

  it('accepts a send_at value with minute precision and a numeric UTC offset', async () => {
    const { service } = createService();
    const sendAt = futureMinute('+02:00');
    const scheduled = await service.schedule('personal', {
      to: ['user@example.com'],
      subject: 'Hello',
      body: 'Body',
      sendAt,
    });
    expect(scheduled.sendAt).toBe(new Date(sendAt).toISOString());
  });

  it('rejects a send_at value that has no UTC offset', async () => {
    const { service } = createService();
    await expect(
      service.schedule('personal', {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: '2026-10-01T09:00:00',
      }),
    ).rejects.toThrow('ISO 8601 date-time with UTC offset, e.g. 2026-10-01T09:00:00+02:00');
  });

  it('rejects a send_at value that is not an ISO-8601 timestamp', async () => {
    const { service } = createService();
    const before = await jsonNames(scheduledDir);
    await expect(
      service.schedule('personal', {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: '01/01/2099',
      }),
    ).rejects.toThrow(/send_at/);
    expect(await jsonNames(scheduledDir)).toEqual(before);
  });

  it('rejects a send_at value more than 366 days ahead', async () => {
    const { service } = createService();
    await expect(
      service.schedule('personal', {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: daysFromNow(400),
      }),
    ).rejects.toThrow(/366/);
  });

  it('rejects more recipients than the schedule limit', async () => {
    const { service } = createService();
    const to = Array.from({ length: 51 }, (_unused, index) => `user${index}@example.com`);
    await expect(
      service.schedule('personal', {
        to,
        subject: 'Hello',
        body: 'Body',
        sendAt: daysFromNow(2),
      }),
    ).rejects.toThrow(/recipient/i);
  });

  it('rejects a subject that contains a line break', async () => {
    const { service } = createService();
    await expect(
      service.schedule('personal', {
        to: ['user@example.com'],
        subject: 'Hello\r\nBcc: other@example.com',
        body: 'Body',
        sendAt: daysFromNow(2),
      }),
    ).rejects.toThrow(/[Ss]ubject/);
  });

  it('rejects a subject longer than 998 characters', async () => {
    const { service } = createService();
    await expect(
      service.schedule('personal', {
        to: ['user@example.com'],
        subject: 's'.repeat(999),
        body: 'Body',
        sendAt: daysFromNow(2),
      }),
    ).rejects.toThrow(/[Ss]ubject/);
  });

  it('rejects an In-Reply-To value that contains a line break', async () => {
    const { service } = createService();
    await expect(
      service.schedule('personal', {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: daysFromNow(2),
        inReplyTo: 'x\r\nBcc: y@example.com',
      }),
    ).rejects.toThrow(/In-Reply-To/);
  });

  it('rejects a References item that contains a newline', async () => {
    const { service } = createService();
    await expect(
      service.schedule('personal', {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: daysFromNow(2),
        references: ['<id@example.com>\n'],
      }),
    ).rejects.toThrow(/References/);
  });

  it('accepts an account name of exactly 128 characters', async () => {
    const { service } = createService();
    const account = 'a'.repeat(128);
    const scheduled = await service.schedule(account, {
      to: ['user@example.com'],
      subject: 'Hello',
      body: 'Body',
      sendAt: daysFromNow(2),
    });
    expect(scheduled.account).toBe(account);
  });

  it('rejects an account name one character over 128', async () => {
    const { service } = createService();
    await expect(
      service.schedule('a'.repeat(129), {
        to: ['user@example.com'],
        subject: 'Hello',
        body: 'Body',
        sendAt: daysFromNow(2),
      }),
    ).rejects.toThrow(/Account name/);
  });

  it('rejects an address that is not an email', async () => {
    const { service } = createService();
    await expect(
      service.schedule('personal', {
        to: ['not-an-email'],
        subject: 'Hello',
        body: 'Body',
        sendAt: daysFromNow(2),
      }),
    ).rejects.toThrow(/recipient/i);
  });
});
