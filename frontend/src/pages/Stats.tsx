import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from "recharts";
import { useApi } from "../lib/api";
import { fmtDate, fmtMoney, fmtOdds, fmtPct, fmtSigned, record } from "../lib/format";
import { useSession } from "../lib/session";
import type { Drought, Player, PlayerStats, Stats as StatsT } from "../lib/types";
import { Avatar, ErrorBox, Glossary, Section, Spinner, Stat, slotColor } from "../components/ui";
import { GLOSSARY, type TermKey } from "../lib/glossary";

export const RANGES = [
  { id: "all", label: "All time" },
  { id: "nfl26", label: "2026 NFL", from: "2026-09-01", to: "2027-02-15" },
  { id: "off26", label: "2026 offseason", from: "2026-02-11", to: "2026-08-31" },
  { id: "nfl25", label: "2025 NFL", from: "2025-09-01", to: "2026-02-10" },
  { id: "off25", label: "2025 offseason", from: "2025-02-10", to: "2025-08-31" },
  { id: "nfl24", label: "2024 NFL", from: "2024-09-01", to: "2025-02-09" },
] as const;

export function useRange() {
  const [range, setRange] = useState<string>(() => {
    try { return localStorage.getItem("bozo.range") || "all"; } catch { return "all"; }
  });
  useEffect(() => { try { localStorage.setItem("bozo.range", range); } catch { /* ignore */ } }, [range]);
  const r = RANGES.find((x) => x.id === range) ?? RANGES[0];
  const qs = new URLSearchParams({ ...("from" in r ? { from: r.from, to: r.to } : {}) }).toString();
  return { range, setRange, qs };
}

export function RangePicker({ range, setRange }: { range: string; setRange: (r: string) => void }) {
  return (
    <div className="flex gap-1.5 overflow-x-auto -mx-4 px-4 pb-1 no-scrollbar" role="tablist" aria-label="Date range">
      {RANGES.map((r) => (
        <button key={r.id} role="tab" aria-selected={range === r.id} onClick={() => setRange(r.id)}
          className={`chip !py-1.5 !px-3 whitespace-nowrap ${range === r.id ? "bg-ink text-bg" : "bg-surface-2 text-ink-2"}`}>
          {r.label}
        </button>
      ))}
    </div>
  );
}

type SortKey = "pct" | "luck" | "units" | "bozoCount" | "net" | "streak";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "pct", label: "Win %" }, { key: "luck", label: "Luck" }, { key: "units", label: "Units" },
  { key: "bozoCount", label: "Bozos" }, { key: "net", label: "Net $" }, { key: "streak", label: "Streak" },
];

/** "W3" -> 3, "L2" -> -2: hottest first when sorted. */
const streakVal = (r: PlayerStats) => {
  const c = r.streaks.current;
  return c ? (c.startsWith("W") ? 1 : -1) * Number(c.slice(1)) : 0;
};

export default function Stats() {
  const { players, setPlayers } = useSession();
  const { range, setRange, qs } = useRange();
  const cur = useApi<{ players: Player[]; droughts: Record<string, Drought>; currentBozoId?: string }>("/current");
  const { data: raw, error, loading } = useApi<StatsT>(`/stats?${qs}`);
  const [sort, setSort] = useState<SortKey>("pct");
  const [showRetired, setShowRetired] = useState(() => {
    try { return localStorage.getItem("bozo.showRetired") === "1"; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem("bozo.showRetired", showRetired ? "1" : "0"); } catch { /* ignore */ } }, [showRetired]);

  // Retired players drop out of per-player views only; group numbers always include everyone who bet
  const data = useMemo(() => {
    if (!raw || showRetired) return raw;
    const visible = (id: string) => players[id]?.active !== false;
    return {
      ...raw,
      players: raw.players.filter((p) => visible(p.playerId)),
      group: { ...raw.group, heartbreaks: (raw.group.heartbreaks ?? []).filter((h) => visible(h.playerId)) },
      votes: Object.fromEntries(Object.entries(raw.votes).filter(([v]) => visible(v))
        .map(([v, c]) => [v, Object.fromEntries(Object.entries(c).filter(([cand]) => visible(cand)))])),
    };
  }, [raw, showRetired, players]);
  const retiredCount = (raw?.players ?? []).filter((p) => players[p.playerId]?.active === false).length;

  useEffect(() => { if (cur.data) setPlayers(cur.data.players); }, [cur.data, setPlayers]);

  const rows = useMemo(() => [...(data?.players ?? [])].sort((a, b) =>
    sort === "streak" ? streakVal(b) - streakVal(a) : (b[sort] ?? -999) - (a[sort] ?? -999)), [data, sort]);

  if (loading && !data) return <Spinner label="Crunching the shame…" />;
  if (error || !data) return <ErrorBox error={error} />;
  const g = data.group;
  const cursed = g.hitRate != null && g.expectedHitRate != null ? g.hitRate - g.expectedHitRate : null;

  return (
    <div>
      <h1 className="font-display text-3xl">Stats</h1>
      <p className="text-ink-2 text-sm mb-3">Numbers don't lie. Bozos do.</p>
      <RangePicker range={range} setRange={setRange} />

      <div className="grid grid-cols-2 gap-2 mt-3">
        <Stat info="parlaysHit" label="Parlays hit" value={`${g.hits}/${g.parlays}`} sub={`${fmtPct(g.hitRate, 1)} · odds said ${fmtPct(g.expectedHitRate, 1)}`} />
        <Stat info="curseMeter" label="Curse meter" value={cursed == null ? "—" : cursed < 0 ? "CURSED" : "Blessed"} sub={cursed == null ? "" : `${fmtSigned(cursed * 100)} pts vs expected`} />
        <Stat info="oneLegAway" label="One leg away" value={g.nearMisses} sub="parlays killed by a single leg" />
        <Stat info="groupPnl" label="Group P&L" value={fmtMoney(g.paidOut - g.spent)} sub={`${fmtMoney(g.spent)} in · ${fmtMoney(g.paidOut)} out`} />
      </div>

      {cur.data && <DroughtStrip droughts={cur.data.droughts ?? {}} currentBozoId={cur.data.currentBozoId} />}

      <Awards rows={data.players} players={players} />

      <Section title="Leaderboard">
        <div className="flex gap-1.5 overflow-x-auto pb-2 no-scrollbar">
          {SORTS.map((s) => (
            <button key={s.key} onClick={() => setSort(s.key)} className={`chip !py-1.5 !px-3 whitespace-nowrap shrink-0 ${sort === s.key ? "bg-accent text-white" : "bg-surface-2 text-ink-2"}`}>{s.label}</button>
          ))}
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm tabular">
            <thead className="text-[11px] uppercase text-muted">
              <tr className="text-left">
                <th className="p-3 font-semibold">Bozo</th>
                <th className="p-3 font-semibold text-right">Record</th>
                <th className="p-3 font-semibold text-right">Win%</th>
                <th className="p-3 font-semibold text-right" title="Current win or loss streak">Streak</th>
                <th className="p-3 font-semibold text-right" title="Wins above what the odds predicted">Luck</th>
                <th className="p-3 font-semibold text-right" title="Profit if every leg were a 1-unit straight bet">Units</th>
                <th className="p-3 font-semibold text-right">🤡</th>
                <th className="p-3 font-semibold text-right">Net</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const p = players[r.playerId];
                return (
                  <tr key={r.playerId} className="border-t border-[var(--border)]">
                    <td className="p-3">
                      <Link to={`/stats/${r.playerId}`} className="flex items-center gap-2 font-bold whitespace-nowrap">
                        <Avatar p={p} size={26} /> <span className="truncate max-w-[9rem]">{p?.displayName}</span>
                      </Link>
                    </td>
                    <td className="p-3 text-right font-mono whitespace-nowrap">{record(r)}</td>
                    <td className="p-3 text-right">{fmtPct(r.pct)}</td>
                    <td className="p-3 text-right font-bold whitespace-nowrap" style={{ color: !r.streaks.current ? "var(--muted)" : r.streaks.current.startsWith("W") ? "var(--good)" : "var(--critical)" }}>
                      {r.streaks.current ? `${r.streaks.current.startsWith("W") ? "🔥" : "🧊"} ${r.streaks.current}` : "—"}
                    </td>
                    <td className="p-3 text-right" style={{ color: (r.luck ?? 0) < 0 ? "var(--serious)" : "var(--good)" }}>{fmtSigned(r.luck)}</td>
                    <td className="p-3 text-right">{fmtSigned(r.units)}</td>
                    <td className="p-3 text-right">{r.bozoCount}</td>
                    <td className="p-3 text-right whitespace-nowrap">{fmtMoney(r.net)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Glossary keys={["record", "winPct", "streak", "luck", "units", "bozos", "net"]} />
      </Section>

      <SoleAssassins rows={data.players} players={players} />
      <Heartbreak data={data} players={players} />
      <SlotSplits data={data} />
      <AboveFiveHundred data={data} players={players} />
      <WallOfShame data={data} players={players} />
      <VoteMatrix data={data} players={players} />

      <Section title="Glossary">
        <Glossary title="Every stat, explained" keys={Object.keys(GLOSSARY) as TermKey[]} />
      </Section>

      {retiredCount > 0 && (
        <label className="flex items-center justify-center gap-2 text-xs text-muted mt-10 mb-2">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
          Show retired bozos ({retiredCount})
        </label>
      )}
    </div>
  );
}

function Awards({ rows, players }: { rows: PlayerStats[]; players: Record<string, Player> }) {
  const decided = rows.filter((r) => r.w + r.l >= 5);
  if (!decided.length) return null;
  const by = <K extends keyof PlayerStats>(k: K, dir: 1 | -1 = 1) =>
    [...decided].filter((r) => r[k] != null).sort((a, b) => dir * ((b[k] as number) - (a[k] as number)))[0];
  const dec = (o: number | null) => (o == null ? 0 : o > 0 ? 1 + o / 100 : 1 + 100 / -o);
  const chalk = [...decided].filter((r) => r.avgOdds != null).sort((a, b) => dec(a.avgOdds) - dec(b.avgOdds))[0];
  const moon = [...decided].filter((r) => r.bestWin != null).sort((a, b) => dec(b.bestWin) - dec(a.bestWin))[0];
  const curse = [...decided].filter((r) => r.bozoCurse.w + r.bozoCurse.l >= 3).sort((a, b) => (a.bozoCurse.pct ?? 1) - (b.bozoCurse.pct ?? 1))[0];
  const cold = [...decided].sort((a, b) => b.streaks.longestL - a.streaks.longestL)[0];
  const judged = rows.filter((r) => r.crowd && r.crowd.up + r.crowd.down >= 3);
  const loved = [...judged].sort((a, b) => b.crowd.up - b.crowd.down - (a.crowd.up - a.crowd.down))[0];
  const hated = [...judged].sort((a, b) => b.crowd.down - b.crowd.up - (a.crowd.down - a.crowd.up))[0];
  const awards = [
    by("soleKiller") && { emoji: "🔪", title: "Sole Assassin", r: by("soleKiller"), v: `${by("soleKiller").soleKiller} parlays killed alone` },
    by("luck", -1) && { emoji: "🪦", title: "Born Unlucky", r: by("luck", -1), v: `${fmtSigned(by("luck", -1).luck)} wins vs the odds` },
    by("luck") && { emoji: "🍀", title: "Horseshoe Award", r: by("luck"), v: `${fmtSigned(by("luck").luck)} wins vs the odds` },
    chalk && { emoji: "🧱", title: "Chalk Merchant", r: chalk, v: `avg odds ${fmtOdds(chalk.avgOdds)}` },
    moon && { emoji: "🚀", title: "Moonshot", r: moon, v: `best hit ${fmtOdds(moon.bestWin)}` },
    by("bozoCount") && { emoji: "🎰", title: "Casino Regular", r: by("bozoCount"), v: `bozo ${by("bozoCount").bozoCount} times` },
    curse && { emoji: "🧿", title: "Bozo Curse", r: curse, v: `${record(curse.bozoCurse)} while bozo` },
    cold && { emoji: "🥶", title: "Ice Cold", r: cold, v: `${cold.streaks.longestL} straight Ls` },
    loved && loved.crowd.up > loved.crowd.down && { emoji: "🥰", title: "Crowd Favorite", r: loved, v: `👍 ${loved.crowd.up} · 👎 ${loved.crowd.down} in Slack` },
    hated && hated.crowd.down > hated.crowd.up && hated !== loved && { emoji: "🍅", title: "Group Chat Pariah", r: hated, v: `👎 ${hated.crowd.down} · 👍 ${hated.crowd.up} in Slack` },
  ].filter(Boolean) as { emoji: string; title: string; r: PlayerStats; v: string }[];
  return (
    <Section title="Awards">
      <div className="grid grid-cols-2 gap-2">
        {awards.map((a) => (
          <Link to={`/stats/${a.r.playerId}`} key={a.title} className="card p-3 flex gap-2.5 items-center">
            <div className="text-3xl" aria-hidden>{a.emoji}</div>
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider text-muted font-bold">{a.title}</div>
              <div className="font-bold text-sm truncate">{players[a.r.playerId]?.displayName}</div>
              <div className="text-xs text-ink-2">{a.v}</div>
            </div>
          </Link>
        ))}
      </div>
    </Section>
  );
}

/** Running wins-minus-losses per player, over time. Tap a name to spotlight it. */
function AboveFiveHundred({ data, players }: { data: StatsT; players: Record<string, Player> }) {
  const [focus, setFocus] = useState<string | null>(null);
  const ids = data.players.map((p) => p.playerId);
  const series = useMemo(() => {
    const run: Record<string, number> = Object.fromEntries(ids.map((i) => [i, 0]));
    return data.timeline.map((t) => {
      for (const [pid, r] of Object.entries(t.legs)) {
        if (pid in run && r) run[pid] += r === "W" ? 1 : r === "L" ? -1 : 0;
      }
      return { date: t.date, ...run };
    });
  }, [data, ids]);
  if (series.length < 3) return null;
  return (
    <Section title="Games Above .500">
      <div className="card p-3">
        <div className="h-64">
          <ResponsiveContainer>
            <LineChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="date" tickFormatter={(d) => fmtDate(d, { month: "short", year: "2-digit" })} tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={{ stroke: "var(--grid)" }} tickLine={false} minTickGap={40} />
              <YAxis tick={{ fill: "var(--muted)", fontSize: 11 }} axisLine={false} tickLine={false} />
              <ReferenceLine y={0} stroke="var(--muted)" strokeDasharray="3 3" />
              <Tooltip
                contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, fontSize: 12 }}
                labelFormatter={(d) => fmtDate(String(d), { month: "short", day: "numeric", year: "numeric" })}
                formatter={(v, k) => [fmtSigned(Number(v), 0), players[String(k)]?.displayName ?? k]}
                itemSorter={(i) => -Number(i.value)}
              />
              {ids.map((id) => (
                <Line key={id} dataKey={id} type="monotone" dot={false} strokeWidth={focus === id ? 3 : 2}
                  stroke={slotColor(players[id])} strokeOpacity={focus && focus !== id ? 0.15 : 1} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1.5 mt-2" role="group" aria-label="Legend: tap to spotlight">
          {ids.map((id) => (
            <button key={id} onClick={() => setFocus(focus === id ? null : id)} aria-pressed={focus === id}
              className="flex items-center gap-1.5 text-xs" style={{ opacity: focus && focus !== id ? 0.5 : 1 }}>
              <span className="w-3 h-[3px] rounded" style={{ background: slotColor(players[id]) }} />
              {players[id]?.displayName}
            </button>
          ))}
        </div>
      </div>
    </Section>
  );
}

/** Every bet × every player. Green won, red lost, gray push. */
function WallOfShame({ data, players }: { data: StatsT; players: Record<string, Player> }) {
  const ids = data.players.map((p) => p.playerId);
  const cols = data.timeline.slice(-40);
  const color = { W: "var(--good)", L: "var(--critical)", P: "var(--muted)" } as const;
  return (
    <Section title="Wall of Shame" right={<span className="text-xs text-muted">last {cols.length} bets</span>}>
      <div className="card p-3 overflow-x-auto">
        <div className="grid gap-[2px]" style={{ gridTemplateColumns: `minmax(64px,auto) repeat(${cols.length}, minmax(12px,1fr))` }}>
          {ids.map((id) => (
            <div key={id} className="contents">
              <div className="text-[11px] font-semibold truncate pr-2 flex items-center">{players[id]?.displayName}</div>
              {cols.map((t) => {
                const r = t.legs[id];
                const killer = r === "L" && Object.values(t.legs).filter((x) => x === "L").length === 1;
                return (
                  <div key={t.betId} title={`${fmtDate(t.date)}: ${r ?? "no leg"}${killer ? " (sole killer)" : ""}${t.nextBozoId === id ? " · became bozo" : ""}`}
                    className="h-4 rounded-[3px] grid place-items-center"
                    style={{ background: r ? color[r] : "var(--surface-2)", opacity: r ? 1 : 0.5, boxShadow: t.nextBozoId === id ? "0 0 0 2px var(--gold)" : undefined }}>
                    {killer && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex gap-3 text-[11px] text-muted mt-3 flex-wrap">
          <span><span className="inline-block w-2.5 h-2.5 rounded-sm align-middle mr-1" style={{ background: "var(--good)" }} />Won</span>
          <span><span className="inline-block w-2.5 h-2.5 rounded-sm align-middle mr-1" style={{ background: "var(--critical)" }} />Lost</span>
          <span><span className="inline-block w-2.5 h-2.5 rounded-sm align-middle mr-1" style={{ background: "var(--muted)" }} />Push</span>
          <span><span className="inline-block w-2.5 h-2.5 rounded-sm align-middle mr-1" style={{ boxShadow: "0 0 0 2px var(--gold)" }} />Became bozo</span>
          <span><span className="inline-block w-1.5 h-1.5 rounded-full align-middle mr-1 bg-ink" />Only loser</span>
        </div>
      </div>
    </Section>
  );
}

function VoteMatrix({ data, players }: { data: StatsT; players: Record<string, Player> }) {
  const voters = Object.keys(data.votes);
  if (!voters.length)
    return (
      <Section title="Vote Grudges">
        <div className="card p-4 text-sm text-ink-2">Votes cast in the app show up here — who always votes for whom. The spreadsheet never tracked it, so the grudges start now. 😈</div>
      </Section>
    );
  const cands = [...new Set(voters.flatMap((v) => Object.keys(data.votes[v])))];
  const max = Math.max(1, ...voters.flatMap((v) => Object.values(data.votes[v])));
  return (
    <Section title="Vote Grudges">
      <div className="card p-3 overflow-x-auto">
        <table className="text-xs tabular">
          <thead><tr><th className="p-1.5 text-left text-muted">voter ↓ / for →</th>{cands.map((c) => <th key={c} className="p-1.5"><Avatar p={players[c]} size={22} /></th>)}</tr></thead>
          <tbody>
            {voters.map((v) => (
              <tr key={v}>
                <td className="p-1.5 font-semibold whitespace-nowrap">{players[v]?.displayName}</td>
                {cands.map((c) => {
                  const n = data.votes[v][c] ?? 0;
                  return <td key={c} className="p-0.5"><div className="w-8 h-8 rounded grid place-items-center font-bold" style={{ background: n ? `color-mix(in srgb, var(--accent) ${20 + (n / max) * 80}%, var(--surface-2))` : "var(--surface-2)" }} title={`${players[v]?.displayName} → ${players[c]?.displayName}: ${n}`}>{n || ""}</div></td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** Who killed a parlay all by themselves: ranked, with the latest kill and the full rap sheet on tap. */
function SoleAssassins({ rows, players }: { rows: PlayerStats[]; players: Record<string, Player> }) {
  const killers = rows.filter((r) => r.soleKiller > 0)
    .sort((a, b) => b.soleKiller - a.soleKiller || (b.soleKills[0]?.date ?? "").localeCompare(a.soleKills[0]?.date ?? ""));
  if (!killers.length) return null;
  const clean = rows.filter((r) => !r.soleKiller && r.w + r.l > 0);
  const max = killers[0].soleKiller;
  const total = killers.reduce((t, r) => t + r.leftOnTable, 0);
  const day = (d: string) => fmtDate(d, { month: "short", day: "numeric", year: "numeric" });
  return (
    <Section title="Sole Assassins 🔪" right={<span className="text-xs text-muted">one leg, whole parlay dead</span>}>
      <div className="card p-4">
        <div className="text-sm text-ink-2">
          <b className="text-ink">{fmtMoney(total)}</b> left on the table by lone wolves.
        </div>
        <div className="grid gap-4 mt-4">
          {killers.map((r) => {
            const last = r.soleKills[0];
            return (
              <details key={r.playerId} className="group">
                <summary className="list-none cursor-pointer">
                  <div className="flex items-center gap-3">
                    <Avatar p={players[r.playerId]} size={32} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-bold truncate">{players[r.playerId]?.displayName}</span>
                        <span className="font-display text-2xl tabular leading-none">{r.soleKiller}</span>
                      </div>
                      <div className="h-2.5 rounded-full bg-surface-2 overflow-hidden mt-1.5" aria-hidden>
                        <div className="h-full rounded-full" style={{ width: `${(r.soleKiller / max) * 100}%`, background: "var(--critical)" }} />
                      </div>
                    </div>
                  </div>
                  {last && (
                    <div className="text-xs text-ink-2 mt-1.5 pl-11">
                      Last: <b>{day(last.date)}</b> · {last.text} {last.odds != null && <span className="font-mono">{fmtOdds(last.odds)}</span>}
                      {last.toWin ? <> · cost {fmtMoney(last.toWin)}</> : null}
                      <span className="text-muted"> · {fmtMoney(r.leftOnTable)} total{r.soleKiller > 1 && <span className="group-open:hidden"> · tap for all</span>}</span>
                    </div>
                  )}
                </summary>
                {r.soleKiller > 1 && (
                  <div className="pl-11 mt-2 grid gap-1">
                    {r.soleKills.map((k) => (
                      <Link key={k.betId} to={`/bets/${k.betId}`} className="text-xs flex justify-between gap-2 py-1 border-t border-[var(--border)]">
                        <span className="min-w-0 truncate"><span className="text-muted">{day(k.date)}</span> · {k.text}</span>
                        <span className="tabular whitespace-nowrap text-ink-2">{k.toWin ? fmtMoney(k.toWin) : ""}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </details>
            );
          })}
        </div>
        {!!clean.length && (
          <div className="text-xs text-muted mt-4 pt-3 border-t border-[var(--border)]">
            😇 Clean hands: {clean.map((r) => players[r.playerId]?.displayName).join(", ")}
          </div>
        )}
      </div>
      <Glossary keys={["soleAssassins"]} title="What counts?" />
    </Section>
  );
}

function Heartbreak({ data, players }: { data: StatsT; players: Record<string, Player> }) {
  const hb = data.group.heartbreaks ?? [];
  if (!hb.length) return null;
  return (
    <Section title="Hall of Heartbreak" right={<span className="text-xs text-muted">closest losses ever</span>}>
      <div className="card divide-y divide-[var(--border)]">
        {hb.slice(0, 8).map((h, i) => (
          <Link key={`${h.betId}-${h.playerId}`} to={`/bets/${h.betId}`} className="flex items-center gap-3 p-3">
            <div className="w-6 text-center font-display text-muted">{i + 1}</div>
            <Avatar p={players[h.playerId]} size={30} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold truncate">{h.text}</div>
              <div className="text-xs text-muted">{players[h.playerId]?.displayName} · {fmtDate(h.date, { month: "short", day: "numeric", year: "numeric" })}</div>
            </div>
            <div className="text-sm font-bold tabular whitespace-nowrap" style={{ color: "var(--serious)" }}>{h.margin === 0 ? "by a hair" : `by ${Math.abs(h.margin)}`} 💔</div>
          </Link>
        ))}
      </div>
    </Section>
  );
}

function SlotSplits({ data }: { data: StatsT }) {
  const rows = Object.entries(data.group.bySlot ?? {}).filter(([, r]) => r.w + r.l >= 5);
  if (!rows.length) return null;
  return (
    <Section title="When We Bet" right={<span className="text-xs text-muted">group record by time slot</span>}>
      <div className="card divide-y divide-[var(--border)]">
        {rows.map(([slot, r]) => (
          <div key={slot} className="p-3 flex items-center gap-3 text-sm">
            <div className="flex-1 min-w-0 font-semibold truncate">{slot}</div>
            <div className="w-20 h-2 rounded-full bg-surface-2 overflow-hidden shrink-0" aria-hidden>
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

/** How long since each player was last crowned. Longest drought first: they're "due". */
function DroughtStrip({ droughts, currentBozoId }: { droughts: Record<string, Drought>; currentBozoId?: string }) {
  const { players } = useSession();
  const rows = Object.values(players)
    .filter((p) => p.active)
    .map((p) => ({ p, d: droughts[p.id] }))
    .sort((a, b) => (b.d?.betsSince ?? 9999) - (a.d?.betsSince ?? 9999));
  if (!rows.length) return null;
  return (
    <Section title="Bozo Drought" right={<span className="text-xs text-muted">bets since last crowned</span>}>
      <div className="flex gap-2 overflow-x-auto -mx-4 px-4 pb-1 no-scrollbar">
        {rows.map(({ p, d }, i) => {
          const now = p.id === currentBozoId;
          return (
            <div key={p.id} className="card shrink-0 w-[104px] p-3 flex flex-col items-center text-center"
              style={now ? { boxShadow: "inset 0 0 0 2px var(--gold)" } : undefined}>
              <Avatar p={p} size={40} crown={now} />
              <div className="text-[11px] font-semibold mt-1.5 leading-tight line-clamp-2 min-h-[2.2em]">{p.displayName}</div>
              <div className="font-display text-2xl tabular leading-none mt-1">{now ? "👑" : d ? d.betsSince : "∞"}</div>
              <div className="text-[10px] text-muted mt-1">
                {now ? "bozo now" : d ? (d.betsSince === 1 ? "bet ago" : "bets ago") : "never bozo 😇"}
              </div>
              {d && !now && <div className="text-[10px] text-muted">{fmtDate(d.lastDate, { month: "short", day: "numeric", year: "2-digit" })}</div>}
              {i === 0 && !now && <span className="chip mt-1.5 bg-accent text-white !text-[10px]">due 👀</span>}
            </div>
          );
        })}
      </div>
    </Section>
  );
}
