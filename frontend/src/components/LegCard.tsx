import type { Leg, Player } from "../lib/types";
import { timeAgo } from "../lib/format";
import { Avatar, Odds, StatusChip, legAccent } from "./ui";

export function LegCard({ leg, player, isBozo, isMe, onClick }: { leg: Leg; player?: Player; isBozo?: boolean; isMe?: boolean; onClick?: () => void }) {
  const accent = legAccent(leg);
  const progress = leg.live?.progress;
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className="card w-full text-left p-3.5 flex gap-3 items-start relative overflow-hidden"
      style={{ boxShadow: `inset 4px 0 0 ${accent}` }}
    >
      <Avatar p={player} size={40} crown={isBozo} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-bold truncate">
            {player?.displayName}
            {isMe && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-accent">you</span>}
          </div>
          <StatusChip leg={leg} />
        </div>
        <div className="mt-1 font-semibold leading-snug break-words">
          {leg.text} <Odds o={leg.odds} className="text-sm" />
          {leg.sgp && <span className="chip ml-1 bg-surface-2 text-muted">SGP</span>}
        </div>
        {leg.live?.detail && <div className="text-xs text-ink-2 mt-1">{leg.live.detail}</div>}
        {progress != null && (
          <div className="mt-2 h-1.5 rounded-full bg-surface-2 overflow-hidden" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full" style={{ width: `${Math.min(100, progress * 100)}%`, background: accent }} />
          </div>
        )}
        {leg.live?.updatedAt && <div className="text-[10px] text-muted mt-1">checked {timeAgo(leg.live.updatedAt)}</div>}
      </div>
    </Tag>
  );
}
