import type { ReactNode } from "react";
import { useSession } from "../lib/session";
import { Avatar } from "./ui";

export interface TallyRow {
  id: string;
  title: ReactNode;
  subtitle?: ReactNode;
}

/** Revealed vote: one bar per candidate (most votes first), with who voted for it underneath. */
export function VoteTally({ rows, votes, winnerId }: { rows: TallyRow[]; votes: { voterId: string; candidateId: string }[]; winnerId?: string }) {
  const { players } = useSession();
  const by = (id: string) => votes.filter((v) => v.candidateId === id);
  const sorted = [...rows].sort((a, b) => by(b.id).length - by(a.id).length);
  const max = Math.max(1, ...rows.map((r) => by(r.id).length));

  return (
    <div className="card p-4 grid gap-5">
      {sorted.map((r) => {
        const vs = by(r.id);
        const win = r.id === winnerId;
        return (
          <div key={r.id}>
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <div className="font-bold break-words">{r.title}{win && " 🤡"}</div>
                {r.subtitle && <div className="text-xs text-muted break-words">{r.subtitle}</div>}
              </div>
              <div className="font-display text-2xl tabular leading-none">{vs.length}</div>
            </div>
            <div className="h-3 rounded-full bg-surface-2 overflow-hidden mt-2" role="img" aria-label={`${vs.length} of ${votes.length} votes`}>
              <div className="h-full rounded-full transition-[width] duration-500"
                style={{ width: `${(vs.length / max) * 100}%`, background: win ? "var(--accent)" : "var(--muted)" }} />
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-2 min-h-[22px]">
              {vs.length ? vs.map((v) => (
                <span key={v.voterId} className="flex items-center gap-1.5 text-xs text-ink-2">
                  <Avatar p={players[v.voterId]} size={20} />
                  {players[v.voterId]?.displayName}
                  {v.voterId === v.candidateId && <span className="text-gold font-semibold">(self)</span>}
                </span>
              )) : <span className="text-xs text-muted">No votes</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
