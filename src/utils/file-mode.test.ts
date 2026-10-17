import hasGroupOrOtherBits from './file-mode.js';

// Modes as fs.stat reports them: file type bits plus permissions.
describe('hasGroupOrOtherBits', () => {
  it.each([
    ['100640', 0o100640],
    ['100604', 0o100604],
    ['100644', 0o100644],
    ['40750', 0o40750],
    // Write-only and execute-only bits count too: a group-writable config can
    // be replaced by another user.
    ['100620', 0o100620],
    ['100602', 0o100602],
    ['100610', 0o100610],
    ['100601', 0o100601],
  ])('should return true for mode %s', (_octal, mode) => {
    expect(hasGroupOrOtherBits(mode)).toBe(true);
  });

  it.each([
    ['100600', 0o100600],
    ['100400', 0o100400],
    ['40700', 0o40700],
  ])('should return false for mode %s', (_octal, mode) => {
    expect(hasGroupOrOtherBits(mode)).toBe(false);
  });
});
