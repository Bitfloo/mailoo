import seededRandom from './seeded-random.js';

const MODULUS = 2_147_483_647;

describe('seededRandom', () => {
  // Park and Miller (CACM 1988) publish these states from seed 1, ending
  // with 1043618065 after 10,000 steps, as the check for a correct build.
  it('should replay the published Park–Miller states when the seed is 1', () => {
    const random = seededRandom(1);
    const draws = Array.from({ length: 10_000 }, () => random());

    expect([...draws.slice(0, 3), draws[9_999]]).toEqual([
      16_807 / MODULUS,
      282_475_249 / MODULUS,
      1_622_650_073 / MODULUS,
      1_043_618_065 / MODULUS,
    ]);
  });

  it('should stay in [0, 1) and spread over the range when the suites seed it', () => {
    const random = seededRandom(20_261_017);
    const draws = Array.from({ length: 10_000 }, () => random());
    const mean = draws.reduce((sum, value) => sum + value, 0) / draws.length;

    expect({
      inRange: draws.every((value) => value >= 0 && value < 1),
      reachesLow: Math.min(...draws) < 0.01,
      reachesHigh: Math.max(...draws) > 0.99,
      centred: Math.abs(mean - 0.5) < 0.02,
    }).toEqual({ inRange: true, reachesLow: true, reachesHigh: true, centred: true });
  });
});
