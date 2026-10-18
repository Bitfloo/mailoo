import { TOKEN } from '../test-support/http-transport-harness.js';
import {
  DEFAULT_HTTP_BODY_LIMIT_BYTES,
  readHttpLaunchOptions,
  resolveHttpListen,
  resolveHttpRoute,
} from './http-transport.js';

describe('resolveHttpListen', () => {
  it('listens on 127.0.0.1 and ::1 when no host is configured', () => {
    const policy = resolveHttpListen({ port: 8080 });
    expect(policy.hosts).toEqual(['127.0.0.1', '::1']);
    expect(policy.token).toBeUndefined();
    expect(policy.allowedHostnames).toEqual(['127.0.0.1', 'localhost', '[::1]']);
  });

  it('accepts an explicit ::1 bind without a bearer token', () => {
    const policy = resolveHttpListen({ port: 8080, host: '::1' });
    expect(policy.hosts).toEqual(['::1']);
    expect(policy.token).toBeUndefined();
  });

  it('treats 127.0.0.2 as loopback and does not require a bearer token', () => {
    const policy = resolveHttpListen({ port: 8080, host: '127.0.0.2' });
    expect(policy.hosts).toEqual(['127.0.0.2']);
    expect(policy.token).toBeUndefined();
  });

  it('treats app.localhost as loopback and does not require a bearer token', () => {
    const policy = resolveHttpListen({ port: 8080, host: 'app.localhost' });
    expect(policy.hosts).toEqual(['app.localhost']);
    expect(policy.token).toBeUndefined();
  });

  it('refuses to listen on 0.0.0.0 when no bearer token is configured', () => {
    expect(() => resolveHttpListen({ port: 8080, host: '0.0.0.0' })).toThrow(
      /MCP_EMAIL_HTTP_TOKEN/,
    );
  });

  it('refuses to listen on :: when the bearer token is blank', () => {
    expect(() => resolveHttpListen({ port: 8080, host: '::', token: '   ' })).toThrow(
      /MCP_EMAIL_HTTP_TOKEN/,
    );
  });

  it('refuses to listen on 192.0.2.10 when no bearer token is configured', () => {
    expect(() => resolveHttpListen({ port: 8080, host: '192.0.2.10' })).toThrow(
      /MCP_EMAIL_HTTP_TOKEN/,
    );
  });

  // Neighbours of 127/8, a private range, and a name that ends in "localhost"
  // without the dot: none of them stays on this machine.
  it.each(['10.0.0.5', '126.255.255.255', '128.0.0.1', 'evillocalhost'])(
    'refuses to listen on %s when no bearer token is configured',
    (host) => {
      expect(() => resolveHttpListen({ port: 8080, host })).toThrow(/MCP_EMAIL_HTTP_TOKEN/);
    },
  );

  it('accepts 192.0.2.10 when a bearer token is configured', () => {
    const policy = resolveHttpListen({ port: 8080, host: '192.0.2.10', token: TOKEN });
    expect(policy.hosts).toEqual(['192.0.2.10']);
    expect(policy.token).toBe(TOKEN);
    expect(policy.allowedHostnames).toEqual(['192.0.2.10']);
  });

  it('refuses a non-loopback allowlist name when no bearer token is configured', () => {
    expect(() => resolveHttpListen({ port: 8080, allowedHosts: ['mail.example'] })).toThrow(
      'MCP_EMAIL_HTTP_ALLOWED_HOSTS lists mail.example; set MCP_EMAIL_HTTP_TOKEN',
    );
  });

  it.each(['localhost:3000', '[::1]:3000', '127.0.0.2', 'app.localhost'])(
    'starts without a bearer token when the allowlist is only %s',
    (entry) => {
      const policy = resolveHttpListen({ port: 8080, allowedHosts: [entry] });
      expect(policy.token).toBeUndefined();
    },
  );

  it.each(['user@mail.example', 'mail.example/x'])('refuses allowlist entry %s', (entry) => {
    expect(() => resolveHttpListen({ port: 8080, token: TOKEN, allowedHosts: [entry] })).toThrow(
      `Invalid HTTP host: ${entry}`,
    );
  });

  it.each(['0.0.0.0', '::'])(
    'refuses a wildcard bind on %s when no allowed hosts are configured',
    (host) => {
      expect(() => resolveHttpListen({ port: 8080, host, token: TOKEN })).toThrow(
        /MCP_EMAIL_HTTP_ALLOWED_HOSTS/,
      );
    },
  );

  it('accepts a wildcard bind when a token and allowed hosts are configured', () => {
    const policy = resolveHttpListen({
      port: 8080,
      host: '0.0.0.0',
      token: TOKEN,
      allowedHosts: ['mail.example'],
    });
    expect(policy.hosts).toEqual(['0.0.0.0']);
    expect(policy.allowedHostnames).toEqual(['mail.example']);
  });

  it('caps the default request body at 8 MiB', () => {
    expect(DEFAULT_HTTP_BODY_LIMIT_BYTES).toBe(8 * 1024 * 1024);
    expect(resolveHttpListen({ port: 8080 }).bodyLimitBytes).toBe(DEFAULT_HTTP_BODY_LIMIT_BYTES);
  });

  // Port 0 asks the OS for a free port, so 0 to 65535 are all valid here.
  it.each([0, 65535])('should accept port %i', (port) => {
    expect(resolveHttpListen({ port }).port).toBe(port);
  });

  it.each([-1, 65536, 1.5])('should refuse port %s', (port) => {
    expect(() => resolveHttpListen({ port })).toThrow(`Invalid port: ${port}`);
  });

  it('should accept a body limit of one byte', () => {
    expect(resolveHttpListen({ port: 8080, bodyLimitBytes: 1 }).bodyLimitBytes).toBe(1);
  });

  it.each([0, 1.5])('should refuse a body limit of %s', (bodyLimitBytes) => {
    expect(() => resolveHttpListen({ port: 8080, bodyLimitBytes })).toThrow(
      `Invalid HTTP body limit: ${bodyLimitBytes}`,
    );
  });

  // A token pasted from a secrets file often ends in a newline.
  it('should trim whitespace around the bearer token', () => {
    expect(resolveHttpListen({ port: 8080, token: `  ${TOKEN}\n` }).token).toBe(TOKEN);
  });

  it('should treat a blank bearer token on loopback as no token', () => {
    expect(resolveHttpListen({ port: 8080, token: '   ' }).token).toBeUndefined();
  });

  it('should listen on 127.0.0.1 and ::1 when the host is blank', () => {
    expect(resolveHttpListen({ port: 8080, host: '   ' }).hosts).toEqual(['127.0.0.1', '::1']);
  });
});

describe('readHttpLaunchOptions', () => {
  it('prefers the host argument over MCP_EMAIL_HTTP_HOST', () => {
    const policy = readHttpLaunchOptions(
      { portArg: '9090', hostArg: '192.0.2.10' },
      {
        MCP_EMAIL_HTTP_HOST: '198.51.100.20',
        MCP_EMAIL_HTTP_TOKEN: TOKEN,
      },
    );
    expect(policy.port).toBe(9090);
    expect(policy.hosts).toEqual(['192.0.2.10']);
  });

  it('uses MCP_EMAIL_HTTP_HOST when the command has no host argument', () => {
    const policy = readHttpLaunchOptions(
      { portArg: '8080' },
      { MCP_EMAIL_HTTP_HOST: '192.0.2.10', MCP_EMAIL_HTTP_TOKEN: TOKEN },
    );
    expect(policy.hosts).toEqual(['192.0.2.10']);
  });

  it('reads the bearer token from MCP_EMAIL_HTTP_TOKEN', () => {
    const policy = readHttpLaunchOptions(
      { portArg: '8080', hostArg: '192.0.2.10' },
      { MCP_EMAIL_HTTP_TOKEN: TOKEN },
    );
    expect(policy.token).toBe(TOKEN);
  });

  it('rejects MCP_EMAIL_HTTP_TOKEN containing a space', () => {
    expect(() =>
      readHttpLaunchOptions(
        { portArg: '8080', hostArg: '192.0.2.10' },
        { MCP_EMAIL_HTTP_TOKEN: 'test token value' },
      ),
    ).toThrow('MCP_EMAIL_HTTP_TOKEN must be a single visible ASCII token');
  });

  it('rejects a port that is not an integer in range', () => {
    expect(() => readHttpLaunchOptions({ portArg: '8080abc' }, {})).toThrow(/Invalid port/);
    expect(() => readHttpLaunchOptions({ portArg: '0' }, {})).toThrow(/Invalid port/);
    expect(() => readHttpLaunchOptions({ portArg: '65536' }, {})).toThrow(/Invalid port/);
  });

  it('defaults the port to 8080', () => {
    expect(readHttpLaunchOptions({}, {}).port).toBe(8080);
  });

  it.each(['1', '65535'])('should accept port argument %s', (portArg) => {
    expect(readHttpLaunchOptions({ portArg }, {}).port).toBe(Number(portArg));
  });

  // Number() reads all three as a port; only plain digits are one.
  it.each(['8e3', '80.5', '+80'])('should refuse port argument %s', (portArg) => {
    expect(() => readHttpLaunchOptions({ portArg }, {})).toThrow(`Invalid port: ${portArg}`);
  });

  it('should use MCP_EMAIL_HTTP_HOST when the host argument is blank', () => {
    const env = { MCP_EMAIL_HTTP_HOST: '127.0.0.2' };
    expect(readHttpLaunchOptions({ portArg: '8080', hostArg: '  ' }, env).hosts).toEqual([
      '127.0.0.2',
    ]);
  });
});

describe('resolveHttpRoute', () => {
  it('accepts GET /health', () => {
    expect(resolveHttpRoute('GET', '/health')).toBe('health');
  });

  it('rejects DELETE /health', () => {
    expect(resolveHttpRoute('DELETE', '/health')).toBe('method');
  });

  it('accepts POST /mcp', () => {
    expect(resolveHttpRoute('POST', '/mcp')).toBe('mcp');
  });

  it('rejects an unknown path', () => {
    expect(resolveHttpRoute('GET', '/other')).toBe('missing');
  });

  it.each(['/mcp?x=1', '/mcp/', '/health?x'])('should route %s as missing', (url) => {
    expect(resolveHttpRoute('GET', url)).toBe('missing');
  });

  it.each(['PUT', undefined])('should refuse method %s on /mcp', (method) => {
    expect(resolveHttpRoute(method, '/mcp')).toBe('method');
  });
});
