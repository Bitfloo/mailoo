import hasGroupOrOtherBits from './file-mode.js';

// Modes as fs.stat reports them: file type bits plus permissions.
describe('hasGroupOrOtherBits', () => {
  it.each([
    ['100640', 0o100640],
    ['100604', 0o100604],
    ['100644', 0o100644],
    ['40750', 0o40750],
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
