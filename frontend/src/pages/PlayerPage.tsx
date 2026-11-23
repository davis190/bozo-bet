import { useEffect } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi } from "../lib/api";
import { fmtMoney, fmtOdds, fmtPct, fmtSigned, record } from "../lib/format";
import { useSession } from "../lib/session";
import type { Player, RecordOut, Stats } from "../lib/types";
import { Avatar, ErrorBox, Section, Spinner, Stat } from "../components/ui";
import { RangePicker, useRange } from "./Stats";

const SPLIT_LABELS: Record<string, string> = {
  sport: "By sport", market: "By market", subject: "Team / player / game", oddsBucket: "By odds",
  slot: "By time slot", favDog: "Favorite vs dog", homeAway: "Home vs road", propType: "Prop type",
  position: "Position", divisional: "Divisional game", venue: "Dome vs outdoors", seasonPhase: "Season phase",
  decidedWhen: "When it was decided", dayOfWeek: "Day of week",
};

export default function PlayerPage() {
  const { id = "" } = useParams();
  const { players, setPlayers } = useSession();
  const { range, setRange, qs } = useRange();
  const cur = useApi<{ players: Player[] }>("/current");
  const { data, error, loading } = useApi<Stats>(`/stats?${qs}`);
  useEffect(() => { if (cur.data) setPlayers(cur.data.players); }, [cur.data, setPlayers]);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <ErrorBox error={error} />;
  const p = players[id];
  const s = data.players.find((x) => x.playerId === id);

  return (
    <div>
      <Link to="/stats" className="text-sm text-muted">← Stats</Link>
      <div className="flex items-center gap-4 mt-3">
        <Avatar p={p} size={64} />
        <div className="min-w-0">
          <h1 className="font-display text-2xl leading-tight break-words">{p?.displayName}</h1>
          {p?.pseudonym && p.name && <div className="text-sm text-ink-2">a.k.a. “{p.pseudonym}”</div>}
          {s?.streaks.current && <div className="text-xs mt-1 font-bold" style={{ color: s.streaks.current.startsWith("W") ? "var(--good)" : "var(--critical)" }}>{s.streaks.current.startsWith("W") ? "🔥" : "🧊"} {s.streaks.current} streak</div>}
        </div>
      </div>
      <div className="mt-3"><RangePicker range={range} setRange={setRange} /></div>
      {!s ? (
        <div className="card p-6 mt-4 text-center text-ink-2">No bets in this range. Suspicious.</div>
      ) : (
        <>
          <div className="flex gap-1 mt-4" aria-label="Last 20 legs">
            {s.recent.map((r, i) => (
              <div key={i} className="flex-1 h-6 rounded-[3px] grid place-items-center text-[9px] font-bold text-white"
                style={{ background: r === "W" ? "var(--good)" : r === "L" ? "var(--critical)" : "var(--muted)" }}>{r}</div>
            ))}
          </div>
          <div className="text-[11px] text-muted mt-1">last {s.recent.length} legs, oldest → newest</div>

          <div className="grid grid-cols-2 gap-2 mt-4">
            <Stat label="Record" value={record(s)} sub={`${fmtPct(s.pct)} · odds said ${fmtPct(s.xPct)}`} />
            <Stat label="Luck" value={fmtSigned(s.luck)} sub="wins vs. what the odds predicted" />
            <Stat label="Flat-bet units" value={fmtSigned(s.units)} sub="$1 on every leg, straight up" />
            <Stat label="Avg odds" value={fmtOdds(s.avgOdds)} sub={`avg winner ${fmtOdds(s.avgWinOdds)} · best ${fmtOdds(s.bestWin)}`} />
            <Stat label="Times bozo" value={s.bozoCount} sub={`${s.votedBozo} voted · ${s.autoBozo} solo · ${s.reloadBozo} reload`} />
            <Stat label="Bozo curse" value={record(s.bozoCurse)} sub="own leg while being the bozo" />
            <Stat label="Sole assassin" value={s.soleKiller} sub={`${fmtMoney(s.leftOnTable)} left on the table`} />
            <Stat label="Net $" value={fmtMoney(s.net)} sub={`${fmtMoney(s.spent)} spent · ${fmtMoney(s.won)} won`} />
          </div>

          {Object.entries(s.splits).map(([key, vals]) => (
            <Splits key={key} title={SPLIT_LABELS[key] ?? key} vals={vals} />
          ))}
          {!("slot" in s.splits) && (
            <div className="card p-4 mt-6 text-sm text-ink-2">🧪 Time-slot, home/road, favorite/dog, prop-type and bad-beat splits appear once the historical legs are enriched.</div>
          )}
        </>
      )}
    </div>
  );
}

function Splits({ title, vals }: { title: string; vals: Record<string, RecordOut> }) {
  const rows = Object.entries(vals).filter(([, r]) => r.w + r.l + r.p > 0);
  if (!rows.length) return null;
  return (
    <Section title={title}>
      <div className="card divide-y divide-[var(--border)]">
        {rows.map(([k, r]) => (
          <div key={k} className="p-3 flex items-center gap-3 text-sm">
            <div className="flex-1 min-w-0 font-semibold truncate">{k}</div>
            <div className="w-16 h-2 rounded-full bg-surface-2 overflow-hidden shrink-0" aria-hidden>
              <div className="h-full rounded-full" style={{ width: `${(r.pct ?? 0) * 100}%`, background: (r.pct ?? 0) >= 0.5 ? "var(--good)" : "var(--critical)" }} />
            </div>
            <div className="w-20 text-right font-mono tabular whitespace-nowrap">{record(r)}</div>
            <div className="w-12 text-right tabular text-ink-2">{fmtPct(r.pct)}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}
