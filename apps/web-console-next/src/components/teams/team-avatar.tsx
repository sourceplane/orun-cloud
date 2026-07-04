import { teamAvatarColor, teamInitials } from "@/lib/teams/avatar";

/** A recognisable team avatar: initials on a deterministic tinted disc (TF-D). */
export function TeamAvatar({
  name,
  seed,
  size = 34,
  className,
}: {
  name: string;
  /** Colour seed — prefer the handle so a rename keeps the same colour; falls back to name. */
  seed?: string | null;
  size?: number;
  className?: string;
}) {
  const { bg, fg } = teamAvatarColor(seed || name);
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-[9px] font-semibold ${className ?? ""}`}
      style={{ width: size, height: size, background: bg, color: fg, fontSize: Math.round(size * 0.4) }}
    >
      {teamInitials(name)}
    </span>
  );
}
