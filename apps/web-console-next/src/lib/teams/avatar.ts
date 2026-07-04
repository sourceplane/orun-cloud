/**
 * Deterministic team avatar (teams-foundation TF-D): initials + a stable colour
 * derived from the team's identity, rendered client-side. No stored asset — the
 * same team always gets the same initials + hue so it is recognisable at a
 * glance across the directory, the team page, and ownership surfaces.
 */

/** Two-letter initials from a display name (e.g. "Platform Eng" → "PE"). */
export function teamInitials(name: string): string {
  const words = name.trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return "?";
  const raw = words.length >= 2 ? words[0]![0]! + words[1]![0]! : words[0]!.slice(0, 2);
  return raw.toUpperCase();
}

// A calm, accessible spread of hues; the same seed always lands on the same one.
const AVATAR_HUES = [212, 262, 292, 330, 8, 28, 152, 168, 190] as const;

function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A `{ bg, fg }` colour pair for the avatar, stable per seed (handle or name). */
export function teamAvatarColor(seed: string): { bg: string; fg: string } {
  const hue = AVATAR_HUES[hash(seed) % AVATAR_HUES.length]!;
  // Soft tinted background + a saturated foreground of the same hue — reads in
  // both light and dark themes.
  return { bg: `hsl(${hue} 70% 50% / 0.16)`, fg: `hsl(${hue} 65% 55%)` };
}
