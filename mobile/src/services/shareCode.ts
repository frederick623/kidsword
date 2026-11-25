/**
 * Offline classroom sharing: a teacher's word list is packed into a portable
 * text code ("KW1.<base64url>") that can be sent via any channel (message,
 * printed sheet, QR) and imported on a child's device without a server.
 *
 * Imported codes are untrusted input, so they are size-limited and every word
 * and clue is re-validated by the same child-safety rules on import.
 */
import type { Difficulty, GradeBandCode } from "../core/models";

export const SHARE_PREFIX = "KW1.";
export const MAX_SHARE_CODE_LENGTH = 6000;
export const MAX_ASSIGNMENT_WORDS = 20;
export const MAX_CLUE_LENGTH = 160;

export interface SharedAssignment {
  code: string;
  title: string;
  teacher_label: string;
  grade_band: GradeBandCode;
  difficulty: Difficulty;
  words: { word: string; clue: string }[];
}

interface Packed {
  c: string;
  t: string;
  n: string;
  g: string;
  d: string;
  w: [string, string][];
}

const BANDS: readonly string[] = ["G1_2", "G3_4", "G5_6"];
const DIFFS: readonly string[] = ["easy", "medium", "hard"];

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(b64: string): string {
  const norm = b64.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(norm + "=".repeat((4 - (norm.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function isShareCode(text: string): boolean {
  return text.trim().startsWith(SHARE_PREFIX);
}

export function encodeShareCode(a: SharedAssignment): string {
  const packed: Packed = {
    c: a.code,
    t: a.title,
    n: a.teacher_label,
    g: a.grade_band,
    d: a.difficulty,
    w: a.words.map((w) => [w.word, w.clue])
  };
  return SHARE_PREFIX + toBase64Url(JSON.stringify(packed));
}

/** Decode and structurally validate a share code. Throws a kid/teacher-friendly Error. */
export function decodeShareCode(text: string): SharedAssignment {
  const raw = text.trim();
  if (!raw.startsWith(SHARE_PREFIX)) throw new Error("That is not a KidsWord share code.");
  if (raw.length > MAX_SHARE_CODE_LENGTH) throw new Error("Share code is too long.");

  let data: unknown;
  try {
    data = JSON.parse(fromBase64Url(raw.slice(SHARE_PREFIX.length)));
  } catch {
    throw new Error("Share code is damaged. Please copy it again.");
  }

  const p = data as Partial<Packed>;
  const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const code = str(p.c, 12).toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) throw new Error("Share code has an invalid class code.");
  if (!BANDS.includes(String(p.g))) throw new Error("Share code has an invalid grade band.");
  if (!DIFFS.includes(String(p.d))) throw new Error("Share code has an invalid difficulty.");
  if (!Array.isArray(p.w) || p.w.length < 3 || p.w.length > MAX_ASSIGNMENT_WORDS) {
    throw new Error(`Share code must contain 3-${MAX_ASSIGNMENT_WORDS} words.`);
  }

  const words = p.w.map((pair) => {
    if (!Array.isArray(pair)) throw new Error("Share code word list is damaged.");
    return { word: str(pair[0], 12).toUpperCase(), clue: str(pair[1], MAX_CLUE_LENGTH) };
  });

  return {
    code,
    title: str(p.t, 60) || "Class Word Challenge",
    teacher_label: str(p.n, 40) || "Teacher",
    grade_band: p.g as GradeBandCode,
    difficulty: p.d as Difficulty,
    words
  };
}
