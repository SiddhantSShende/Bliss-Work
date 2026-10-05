/** Pure colour maths for the meeting skin (kept free of React Native imports so it is unit-testable). */
/** Blend two `#rrggbb` colours: t=0 -> a, t=1 -> b. */
export function mix(a: string, b: string, t: number): string {
  const p = (h: string) => {
    const m = /^#([0-9a-f]{6})$/i.exec(h.trim());
    const n = parseInt(m ? m[1]! : '000000', 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
  };
  const [ar, ag, ab] = p(a);
  const [br, bg, bb] = p(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
}
