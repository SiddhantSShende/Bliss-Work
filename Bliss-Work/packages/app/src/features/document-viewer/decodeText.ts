/**
 * Bytes → text for the document viewer, for files the browser would otherwise
 * guess an encoding for.
 *
 * Used for a `.txt` whose mime is not text/plain (see attachmentCapability), where
 * there is no `Content-Type` charset to lean on: honour a byte-order mark,
 * recognise BOM-less UTF-16 by its NUL pattern, and otherwise decode as UTF-8
 * (replacing invalid bytes rather than failing).
 */

export type TextEncodingName = "utf-8" | "utf-16le" | "utf-16be";

export function detectEncoding(bytes: Uint8Array): { encoding: TextEncodingName; bomLength: number } {
  const [a, b, c] = bytes;
  if (a === 0xef && b === 0xbb && c === 0xbf) return { encoding: "utf-8", bomLength: 3 };
  if (a === 0xff && b === 0xfe) return { encoding: "utf-16le", bomLength: 2 };
  if (a === 0xfe && b === 0xff) return { encoding: "utf-16be", bomLength: 2 };

  // No BOM: UTF-16 of mostly-ASCII text has a NUL in every other byte.
  const sample = Math.min(bytes.length, 4096) & ~1;
  if (sample >= 8) {
    let evenNuls = 0;
    let oddNuls = 0;
    for (let i = 0; i < sample; i += 2) {
      if (bytes[i] === 0) evenNuls++;
      if (bytes[i + 1] === 0) oddNuls++;
    }
    const half = sample / 2;
    if (oddNuls > half * 0.3 && evenNuls < half * 0.05) return { encoding: "utf-16le", bomLength: 0 };
    if (evenNuls > half * 0.3 && oddNuls < half * 0.05) return { encoding: "utf-16be", bomLength: 0 };
  }
  return { encoding: "utf-8", bomLength: 0 };
}

export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncodingName } {
  const { encoding, bomLength } = detectEncoding(bytes);
  const text = new TextDecoder(encoding, { fatal: false }).decode(bomLength ? bytes.subarray(bomLength) : bytes);
  return { text, encoding };
}
