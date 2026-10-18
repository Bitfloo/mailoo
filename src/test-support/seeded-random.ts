/** Park–Miller generator: one seed replays the same sequence on every run. */
export default function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return state / 2_147_483_647;
  };
}
