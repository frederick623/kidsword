/**
 * Deterministic Mulberry32 PRNG seeded via FNV-1a 32-bit string hash.
 */
export class SeededRNG {
  private state: number;

  constructor(seedText: string) {
    const h = fnv1a32(seedText);
    this.state = h === 0 ? 1 : h;
  }

  nextFloat(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ ((t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0)) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.nextFloat() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }
}

/** FNV-1a 32-bit over Unicode code points (matches Python `ord(ch)` iteration). */
export function fnv1a32(text: string): number {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function fnv1aHex(text: string): string {
  return fnv1a32(text).toString(16).padStart(8, "0");
}
