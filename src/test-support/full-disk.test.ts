import withFullDisk from './full-disk.js';

describe('full disk helper', () => {
  it('should fail when no write matched, so a test cannot pass on a disk that never filled', async () => {
    await expect(
      withFullDisk(
        () => false,
        async () => {},
      ),
    ).rejects.toThrow('no write matched the full-disk predicate');
  });
});
