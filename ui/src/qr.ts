/**
 * qr.ts — minimal, dependency-free QR encoder (T-48).
 *
 * Scope: byte mode, error-correction level M, versions 1–9 (auto-selected).
 * Version 9 is a hard cap because the byte-mode character-count field grows
 * from 8 to 16 bits at version 10; v9-M holds ~180 bytes — triple the LAN
 * onboarding link this exists for (http://<ip>:5173/mobile?project=<name> ≈
 * 50–70 chars). Implements the full ISO/IEC 18004 pipeline: data codewords →
 * Reed-Solomon EC over GF(256) → block interleave → matrix (finder/timing/
 * alignment/format/version) → zigzag placement → 8-mask penalty evaluation.
 *
 * Written from the spec to keep ui/package.json dependency-free (it is
 * architect-reviewed territory). Correctness is verified in the T-48 e2e by
 * DECODING the rendered matrix with an independent decoder (jsQR).
 */

interface BlockSpec {
  /** total codewords in the version */
  total: number;
  /** EC codewords per block */
  ecPerBlock: number;
  /** data-codeword length of each block, in interleave order */
  dataBlocks: number[];
}

/** EC level M block structure, versions 1..10 (ISO 18004 table 9). */
const BLOCKS_M: BlockSpec[] = [
  { total: 26, ecPerBlock: 10, dataBlocks: [16] },
  { total: 44, ecPerBlock: 16, dataBlocks: [28] },
  { total: 70, ecPerBlock: 26, dataBlocks: [44] },
  { total: 100, ecPerBlock: 18, dataBlocks: [32, 32] },
  { total: 134, ecPerBlock: 24, dataBlocks: [43, 43] },
  { total: 172, ecPerBlock: 16, dataBlocks: [27, 27, 27, 27] },
  { total: 196, ecPerBlock: 18, dataBlocks: [31, 31, 31, 31] },
  { total: 242, ecPerBlock: 22, dataBlocks: [38, 38, 39, 39] },
  { total: 292, ecPerBlock: 22, dataBlocks: [36, 36, 36, 37, 37] },
];

/** Alignment pattern center coordinates per version (1..9). */
const ALIGNMENT: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
];

// ---------------------------------------------------------------- GF(256)

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Reed-Solomon EC codewords for one block. */
function rsEncode(data: number[], ecLen: number): number[] {
  // generator polynomial (x-α^0)(x-α^1)...(x-α^(ecLen-1))
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gfMul(gen[j], GF_EXP[i]);
      next[j + 1] ^= gen[j];
    }
    gen = next;
  }
  // polynomial division remainder
  const rem = new Array(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ rem[0];
    rem.shift();
    rem.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecLen; i++) rem[i] ^= gfMul(gen[gen.length - 2 - i], factor);
    }
  }
  return rem;
}

// ----------------------------------------------------------- data encoding

function buildCodewords(bytes: number[], version: number): number[] {
  const spec = BLOCKS_M[version - 1];
  const dataCwCount = spec.dataBlocks.reduce((a, b) => a + b, 0);

  // bit stream: mode 0100, 8-bit char count (versions 1-9), data, terminator
  const bits: number[] = [];
  const push = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const capacityBits = dataCwCount * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    data.push(v);
  }
  const PAD = [0xec, 0x11];
  for (let i = 0; data.length < dataCwCount; i++) data.push(PAD[i % 2]);

  // split into blocks, compute EC per block
  const blocks: number[][] = [];
  const ecs: number[][] = [];
  let off = 0;
  for (const len of spec.dataBlocks) {
    const block = data.slice(off, off + len);
    off += len;
    blocks.push(block);
    ecs.push(rsEncode(block, spec.ecPerBlock));
  }

  // interleave data then EC
  const out: number[] = [];
  const maxData = Math.max(...spec.dataBlocks);
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < spec.ecPerBlock; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

// -------------------------------------------------------------- the matrix

/** matrix cells: 0/1 = data module, 2/3 = reserved function module (0/1) */
function placeFunctionPatterns(size: number, version: number): Uint8Array {
  const m = new Uint8Array(size * size); // 0 initially; function cells become 2|bit
  const set = (x: number, y: number, v: number) => {
    m[y * size + x] = 2 | v;
  };

  const finder = (cx: number, cy: number) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const inRing =
          dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        set(x, y, inRing ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);

  // timing
  for (let i = 8; i < size - 8; i++) {
    set(i, 6, i % 2 === 0 ? 1 : 0);
    set(6, i, i % 2 === 0 ? 1 : 0);
  }

  // alignment patterns
  const centers = ALIGNMENT[version - 1];
  for (const cy of centers) {
    for (const cx of centers) {
      // skip those overlapping finder corners
      if ((cx <= 8 && cy <= 8) || (cx >= size - 9 && cy <= 8) || (cx <= 8 && cy >= size - 9)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const on = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
          set(cx + dx, cy + dy, on ? 1 : 0);
        }
      }
    }
  }

  // format info areas (reserved; filled later) + dark module. Reservation
  // must EXACTLY match the cells writeFormat touches — one extra reserved
  // cell shifts all data placement and breaks decoding.
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      set(8, i, 0);
      set(i, 8, 0);
    }
    if (i < 8) {
      set(size - 1 - i, 8, 0);
      set(8, size - 1 - i, 0);
    }
  }
  set(8, 8, 0);
  set(8, size - 8, 1); // dark module

  // version info (v >= 7)
  if (version >= 7) {
    const info = bchVersion(version);
    for (let i = 0; i < 18; i++) {
      const bit = (info >> i) & 1;
      set(Math.floor(i / 3), size - 11 + (i % 3), bit);
      set(size - 11 + (i % 3), Math.floor(i / 3), bit);
    }
  }
  return m;
}

/** BCH(18,6) version information. */
function bchVersion(version: number): number {
  let v = version << 12;
  const G = 0x1f25;
  while (highestBit(v) >= 12) v ^= G << (highestBit(v) - 12);
  return (version << 12) | v;
}

/** BCH(15,5) format information for EC level M + mask, pre-masked. */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // M = 00
  let v = data << 10;
  const G = 0x537;
  while (highestBit(v) >= 10) v ^= G << (highestBit(v) - 10);
  return (((data << 10) | v) ^ 0x5412) & 0x7fff;
}

function highestBit(v: number): number {
  return 31 - Math.clz32(v);
}

function placeData(m: Uint8Array, size: number, codewords: number[]): void {
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5; // skip timing column
    for (let i = 0; i < size; i++) {
      const y = upward ? size - 1 - i : i;
      for (const x of [col, col - 1]) {
        const idx = y * size + x;
        if (m[idx] & 2) continue; // function module
        let bit = 0;
        if (bitIdx < totalBits) {
          bit = (codewords[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
        }
        m[idx] = bit;
        bitIdx++;
      }
    }
    upward = !upward;
  }
}

function applyMask(m: Uint8Array, size: number, mask: number): Uint8Array {
  const out = new Uint8Array(m);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      if (out[idx] & 2) continue;
      let flip = false;
      switch (mask) {
        case 0: flip = (y + x) % 2 === 0; break;
        case 1: flip = y % 2 === 0; break;
        case 2: flip = x % 3 === 0; break;
        case 3: flip = (y + x) % 3 === 0; break;
        case 4: flip = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break;
        case 5: flip = ((y * x) % 2) + ((y * x) % 3) === 0; break;
        case 6: flip = (((y * x) % 2) + ((y * x) % 3)) % 2 === 0; break;
        case 7: flip = (((y + x) % 2) + ((y * x) % 3)) % 2 === 0; break;
      }
      if (flip) out[idx] ^= 1;
    }
  }
  return out;
}

function writeFormat(m: Uint8Array, size: number, mask: number): void {
  const f = formatBits(mask);
  const bit = (i: number) => (f >> i) & 1;
  const set = (x: number, y: number, v: number) => {
    m[y * size + x] = 2 | v;
  };
  // around top-left finder
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  // split copy: under top-right + right of bottom-left
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
}

function penalty(m: Uint8Array, size: number): number {
  const at = (x: number, y: number) => m[y * size + x] & 1;
  let score = 0;

  // N1: runs of same color >= 5 (rows and columns)
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      let prev = pass === 0 ? at(0, a) : at(a, 0);
      for (let b = 1; b < size; b++) {
        const cur = pass === 0 ? at(b, a) : at(a, b);
        if (cur === prev) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
          prev = cur;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // N2: 2x2 blocks of same color
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = at(x, y);
      if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
    }
  }

  // N3: finder-like pattern 1011101 with 4 light modules on either side
  const PAT = [1, 0, 1, 1, 1, 0, 1];
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b < size - 6; b++) {
        let match = true;
        for (let k = 0; k < 7; k++) {
          const v = pass === 0 ? at(b + k, a) : at(a, b + k);
          if (v !== PAT[k]) {
            match = false;
            break;
          }
        }
        if (!match) continue;
        const lightRun = (start: number, len: number) => {
          for (let k = 0; k < len; k++) {
            const p = start + k;
            if (p < 0 || p >= size) return false;
            if ((pass === 0 ? at(p, a) : at(a, p)) !== 0) return false;
          }
          return true;
        };
        if (lightRun(b - 4, 4) || lightRun(b + 7, 4)) score += 40;
      }
    }
  }

  // N4: dark-module proportion
  let dark = 0;
  for (let i = 0; i < size * size; i++) dark += m[i] & 1;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

// ------------------------------------------------------------------ public

export interface QrResult {
  /** modules per side */
  size: number;
  /** row-major booleans, true = dark */
  modules: boolean[];
  version: number;
}

/** Encode text (UTF-8, byte mode, EC-M). Throws if it exceeds v9-M capacity. */
export function encodeQr(text: string): QrResult {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 0;
  for (let v = 1; v <= BLOCKS_M.length; v++) {
    const dataCw = BLOCKS_M[v - 1].dataBlocks.reduce((a, b) => a + b, 0);
    if (bytes.length <= dataCw - 2) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error(`qr: payload too long (${bytes.length} bytes > v9-M capacity)`);

  const size = 17 + version * 4;
  const codewords = buildCodewords(bytes, version);
  const base = placeFunctionPatterns(size, version);
  placeData(base, size, codewords);

  let best: Uint8Array | null = null;
  let bestScore = Infinity;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(base, size, mask);
    writeFormat(candidate, size, mask);
    const s = penalty(candidate, size);
    if (s < bestScore) {
      bestScore = s;
      best = candidate;
      bestMask = mask;
    }
  }
  writeFormat(best!, size, bestMask);

  return { size, modules: [...best!].map((v) => (v & 1) === 1), version };
}

/** Render a QrResult as a crisp SVG string (dark-on-light, quiet zone included). */
export function qrToSvg(qr: QrResult, modulePx = 4): string {
  const quiet = 4;
  const dim = (qr.size + quiet * 2) * modulePx;
  let rects = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y * qr.size + x]) {
        rects += `<rect x="${(x + quiet) * modulePx}" y="${(y + quiet) * modulePx}" width="${modulePx}" height="${modulePx}"/>`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}"><rect width="${dim}" height="${dim}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
