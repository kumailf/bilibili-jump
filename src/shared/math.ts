/** 向量/标量工具 */

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function mean(xs: number[]): number {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function linspace(start: number, end: number, count: number): number[] {
  if (count <= 1) return [start];
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(start + ((end - start) * i) / (count - 1));
  }
  return out;
}

/** 将分数压到 0–1（以 mid 为 0.5 的软 logistic） */
export function softScore(value: number, mid: number, scale: number): number {
  return 1 / (1 + Math.exp(-(value - mid) * scale));
}
