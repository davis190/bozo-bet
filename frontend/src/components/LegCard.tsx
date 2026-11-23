import { Link } from "react-router-dom";
import { fmtOdds, timeAgo } from "../lib/format";
import { useSession } from "../lib/session";
import type { Leg, Player } from "../lib/types";
import { Avatar, Odds, StatusChip, legAccent } from "./ui";

export function LegCard({ leg, player, isBozo, isMe, onClick }: { leg: Leg; player?: Player; isBozo?: boolean; isMe?: boolean; onClick?: () => void }) {
  const accent = legAccent(leg);
  const progress = leg.live?.progress;
  const { atLeast } = useSession();
  // Avatar + name go to the player's page; the rest of the card keeps its own action (e.g. edit your leg)
  const href = player && atLeast("viewer") ? `/stats/${player.id}` : null;
  const stop = (e: React.MouseEvent) => e.stopPropagation();
  return (
    <div
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={`card w-full text-left p-3.5 flex gap-3 items-start relative overflow-hidden ${onClick ? "cursor-pointer" : ""}`}
      style={{ boxShadow: `inset 4px 0 0 ${accent}` }}
    >
      {href ? <Link to={href} onClick={stop} aria-label={`${player?.displayName}'s page`}><Avatar p={player} size={40} crown={isBozo} /></Link> : <Avatar p={player} size={40} crown={isBozo} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-bold truncate">
              {href ? <Link to={href} onClick={stop} className="hover:underline">{player?.displayName}</Link> : player?.displayName}
              {isMe && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-accent">you</span>}
            </div>
            {/* Logged-in viewers see real names; keep the weekly fake name underneath, quieter */}
            {player?.name && player.pseudonym && <div className="text-[11px] text-muted truncate">({player.pseudonym})</div>}
          </div>
          <StatusChip leg={leg} />
        </div>
        <div className="mt-1 font-semibold leading-snug break-words">
          {leg.text} <Odds o={leg.odds} className="text-sm" />
          {(leg.sgp || leg.sgpOdds != null) && <span className="chip ml-1 bg-surface-2 text-muted">SGP{leg.sgpOdds != null && ` ${fmtOdds(leg.sgpOdds)}`}</span>}
        </div>
        {leg.live?.detail && <div className="text-xs text-ink-2 mt-1">{leg.live.detail}</div>}
        {leg.crowd && <CrowdChips c={leg.crowd} />}
        {progress != null && (
          <div className="mt-2 h-1.5 rounded-full bg-surface-2 overflow-hidden" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, progress * 100)}%`, background: accent }} />
          </div>
        )}
        {leg.live?.updatedAt && <div className="text-[10px] text-muted mt-1">checked {timeAgo(leg.live.updatedAt)}</div>}
      </div>
    </div>
  );
}

/** Slack reactions on the leg's post: approvals, disapprovals, and the ones nobody can decode. */
function CrowdChips({ c }: { c: NonNullable<Leg["crowd"]> }) {
  const parts = [
    { n: c.up, icon: "👍", label: "approve" },
    { n: c.down, icon: "👎", label: "disapprove" },
    { n: c.neutral, icon: "😐", label: "shrug" },
    { n: c.unknown, icon: "🤷", label: "no idea what that means" },
  ].filter((x) => x.n > 0);
  if (!parts.length) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1.5" title={c.emojis.map(([e, n]) => `:${e}: ×${n}`).join("  ")}>
      {parts.map((x) => (
        <span key={x.label} className="chip !py-0.5 bg-surface-2 text-ink-2 text-xs" aria-label={`${x.n} ${x.label}`}>{x.icon} {x.n}</span>
      ))}
    </div>
  );
}
