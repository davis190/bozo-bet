import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useApi } from "../lib/api";
import { FILTER_KEYS, RESULTS, SORTS, losers, normRecord, rundown, search, sportsOf, type ArchiveFilter } from "../lib/archive";
import { fmtDate, fmtMoney, fmtOdds } from "../lib/format";
import { useSession } from "../lib/session";
import type { Bet, Player } from "../lib/types";
import { LegCard } from "../components/LegCard";
import { VoteTally } from "../components/VoteTally";
import { Avatar, Empty, ErrorBox, Section, Spinner } from "../components/ui";

const METHOD: Record<string, string> = { voted: "🗳️ voted", auto: "🎯 only loser", reload: "🔁 reload", stays: "💰 hit, goes again", kept: "🎲 side bet, no vote" };

const EMPTY: ArchiveFilter = { q: "", bozo: "", by: "", sank: "", leg: "", res: "", how: "", sport: "", rec: "", from: "", to: "", sort: "new" };

export default function History() {
  const { setPlayers, players } = useSession();
  const [params, setParams] = useSearchParams();
  const kind = params.get("kind") === "side" ? "side" : "bozo";
  const f: ArchiveFilter = { ...EMPTY, ...Object.fromEntries(FILTER_KEYS.filter((k) => params.get(k)).map((k) => [k, params.get(k)!])) };
  const [open, setOpen] = useState(() => FILTER_KEYS.some((k) => k !== "q" && params.get(k)));
  const [shown, setShown] = useState(25);
  const { data, error, loading } = useApi<{ bets: Bet[]; players: Player[] }>("/bets");

  useEffect(() => {
    if (data) setPlayers(data.players);
  }, [data, setPlayers]);

  const set = (patch: Partial<ArchiveFilter> & { kind?: string }) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v && !(k === "sort" && v === "new") && !(k === "kind" && v === "bozo") ? next.set(k, v) : next.delete(k)));
    setParams(next, { replace: true });
    setShown(25);
  };
  const clear = () => setParams(kind === "side" ? { kind } : {}, { replace: true });

  const ofKind = useMemo(() => (data?.bets ?? []).filter((b) => b.kind === kind), [data, kind]);
  const rows = useMemo(() => search(ofKind, f, players), [ofKind, params, players]); // eslint-disable-line react-hooks/exhaustive-deps
  const sum = rundown(rows);
  // Only offer choices that exist in this kind of bet
  const people = (data?.players ?? []).slice().sort((a, b) => a.displayName.localeCompare(b.displayName));
  const sports = [...new Set(ofKind.flatMap((b) => [...sportsOf(b)]))].sort();
  const records = [...new Set(ofKind.map(normRecord).filter(Boolean))].sort((a, b) => Number(b.split("-")[0]) - Number(a.split("-")[0]) || a.localeCompare(b));
  const years = [...new Set(ofKind.map((b) => b.date.slice(0, 4)))].sort().reverse();
  const name = (id: string) => players[id]?.displayName ?? id;

  const active: [keyof ArchiveFilter, string][] = [
    ["bozo", f.bozo && `🤡 ${name(f.bozo)}`], ["by", f.by && `placed by ${name(f.by)}`], ["sank", f.sank && `💀 ${name(f.sank)} missed`],
    ["leg", f.leg && `${name(f.leg)}'s legs`], ["res", f.res && RESULTS[f.res]], ["how", f.how && METHOD[f.how]], ["sport", f.sport],
    ["rec", f.rec && `went ${f.rec}`], ["from", f.from && `from ${fmtDate(f.from, { month: "short", day: "numeric", year: "numeric" })}`],
    ["to", f.to && `to ${fmtDate(f.to, { month: "short", day: "numeric", year: "numeric" })}`],
  ].filter(([, v]) => v) as [keyof ArchiveFilter, string][];

  if (loading && !data) return <Spinner label="Digging through the wreckage…" />;
  if (error) return <ErrorBox error={error} />;

  const select = (k: keyof ArchiveFilter, label: string, opts: [string, string][], all = "Anyone") => (
    <label className="grid gap-1 min-w-0">
      <span className="text-[11px] uppercase font-bold text-muted">{label}</span>
      <select className="input !min-h-10" value={f[k]} onChange={(e) => set({ [k]: e.target.value })}>
        <option value="">{all}</option>
        {opts.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </label>
  );
  const who = people.map((p) => [p.id, p.displayName] as [string, string]);
  const year = f.from.slice(0, 4) === f.to.slice(0, 4) && f.from.endsWith("-01-01") && f.to.endsWith("-12-31") ? f.from.slice(0, 4) : "";

  return (
    <div>
      <h1 className="font-display text-3xl">The Archive</h1>
      <p className="text-ink-2 text-sm">Every bet, every bozo, every bad beat.</p>
      <div className="flex gap-2 mt-4">
        {(["bozo", "side"] as const).map((k) => (
          <button key={k} className={`btn !min-h-9 flex-1 ${kind === k ? "btn-primary" : "btn-ghost"}`} onClick={() => set({ kind: k })}>
            {k === "bozo" ? "Bozo Bets" : "Side Bets"}
          </button>
        ))}
      </div>
      <div className="flex gap-2 mt-2">
        <input className="input flex-1 min-w-0" type="search" placeholder="Search… Packers, ATD, Devan, Nov 2025, 5-1" value={f.q} onChange={(e) => set({ q: e.target.value })} aria-label="Search the archive" />
        <button className={`btn !min-h-10 shrink-0 ${open || active.length ? "btn-primary" : "btn-ghost"}`} onClick={() => setOpen(!open)} aria-expanded={open}>
          Filters{active.length ? ` · ${active.length}` : ""}
        </button>
      </div>
      <div className="flex gap-1.5 mt-2 overflow-x-auto no-scrollbar -mx-4 px-4">
        {(Object.keys(RESULTS) as (keyof typeof RESULTS)[]).map((r) => (
          <button key={r} className={`chip shrink-0 ${f.res === r ? "bg-accent text-white" : "bg-surface-2"}`} onClick={() => set({ res: f.res === r ? "" : r })} aria-pressed={f.res === r}>
            {RESULTS[r]}
          </button>
        ))}
      </div>
      {open && (
        <div className="card p-3 mt-2 grid grid-cols-2 gap-2.5 [&_.input]:w-full [&_.input]:min-w-0">
          {select("bozo", "Made bozo", who)}
          {select("sank", "Missed a leg", who)}
          {select("by", "Placed by", who)}
          {select("leg", "Had a leg", who)}
          {select("how", "Bozo picked by", Object.entries(METHOD), "Any way")}
          {select("sport", "Sport", sports.map((s) => [s, s]), "Any sport")}
          {select("rec", "Record", records.map((r) => [r, r]), "Any record")}
          <label className="grid gap-1 min-w-0">
            <span className="text-[11px] uppercase font-bold text-muted">Year</span>
            <select className="input !min-h-10" value={year} onChange={(e) => set(e.target.value ? { from: `${e.target.value}-01-01`, to: `${e.target.value}-12-31` } : { from: "", to: "" })}>
              <option value="">{f.from || f.to ? "Custom" : "All time"}</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label className="grid gap-1 min-w-0">
            <span className="text-[11px] uppercase font-bold text-muted">From</span>
            <input className="input !min-h-10" type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} />
          </label>
          <label className="grid gap-1 min-w-0">
            <span className="text-[11px] uppercase font-bold text-muted">To</span>
            <input className="input !min-h-10" type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} />
          </label>
          <label className="grid gap-1 min-w-0 col-span-2">
            <span className="text-[11px] uppercase font-bold text-muted">Sort</span>
            <select className="input !min-h-10" value={f.sort} onChange={(e) => set({ sort: e.target.value as ArchiveFilter["sort"] })}>
              {Object.entries(SORTS).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </select>
          </label>
          {f.leg && <p className="col-span-2 text-xs text-muted">Search only looks at {name(f.leg)}'s legs.</p>}
        </div>
      )}
      {(active.length > 0 || f.q) && (
        <div className="flex flex-wrap gap-1.5 mt-2 items-center">
          {active.filter(([k]) => k !== "res").map(([k, label]) => (
            <button key={k} className="chip bg-surface-2" onClick={() => set({ [k]: "" })} aria-label={`Remove filter: ${label}`}>{label} ✕</button>
          ))}
          <button className="text-xs text-accent font-bold ml-auto" onClick={clear}>Clear all</button>
        </div>
      )}
      <p className="text-xs text-muted mt-3" aria-live="polite">
        {rows.length} {rows.length === 1 ? "bet" : "bets"}
        {rows.length > 0 && ` · ${sum.hits} ${sum.hits === 1 ? "hit" : "hits"}`}
        {sum.bozo && !f.bozo && ` · most bozo'd: ${name(sum.bozo.id)} ×${sum.bozo.n}${sum.bozo.tied ? " (tied)" : ""}`}
        {sum.sank && !f.sank && ` · most misses: ${name(sum.sank.id)} ×${sum.sank.n}${sum.sank.tied ? " (tied)" : ""}`}
      </p>
      <div className="grid grid-cols-1 gap-2 mt-2">
        {rows.slice(0, shown).map(({ bet: b, hits }) => {
          const lost = losers(b);
          return (
            <Link key={b.id} to={`/bets/${b.id}`} className="card p-3.5 flex items-center gap-3 min-w-0">
              <div className="w-12 text-center shrink-0 self-start">
                <div className="text-[10px] uppercase text-muted font-bold">{fmtDate(b.date, { month: "short" })}</div>
                <div className="font-display text-xl leading-none">{fmtDate(b.date, { day: "numeric" })}</div>
                <div className="text-[10px] text-muted">{b.date.slice(0, 4)}</div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-sm">
                  {b.title ?? (b.result === "W" ? "HIT 💰" : b.status !== "CLOSED" ? "In progress" : `${normRecord(b)} ${b.outcome === "reload" ? "· reloaded" : b.noVote ? "· side bet" : ""}`)}
                </div>
                <div className="text-xs text-ink-2 truncate">
                  {lost.length ? `💀 ${lost.map((l) => name(l.playerId)).join(", ")}` : b.result === "W" ? `${fmtMoney(b.payout)} paid out` : ""}
                </div>
                {b.nextBozoId && <div className="text-xs text-muted mt-0.5">🤡 {name(b.nextBozoId)} · {METHOD[b.nextBozoMethod ?? ""] ?? ""}</div>}
                {hits.slice(0, 3).map((l) => (
                  <div key={l.playerId} className="text-xs mt-1 line-clamp-2">
                    <span aria-label={l.result === "W" ? "hit" : l.result === "L" ? "missed" : l.result === "P" ? "push" : "pending"}>{l.result === "W" ? "✅" : l.result === "L" ? "❌" : l.result === "P" ? "➖" : "⏳"}</span>{" "}
                    <span className="font-bold">{name(l.playerId)}:</span> <span className="text-ink-2">{l.text}</span>
                  </div>
                ))}
              </div>
              <span className="font-mono text-sm tabular shrink-0">{fmtOdds(b.totalOdds ?? b.computedOdds)}</span>
            </Link>
          );
        })}
        {!rows.length && (
          <Empty title="Nothing here">
            {active.length || f.q ? <button className="text-accent font-bold" onClick={clear}>Clear the filters</button> : "No bets yet."}
          </Empty>
        )}
        {rows.length > shown && <button className="btn btn-ghost" onClick={() => setShown(shown + 25)}>Show more ({rows.length - shown} left)</button>}
      </div>
    </div>
  );
}

export function BetDetail() {
  const { id } = useParams();
  const { players, setPlayers } = useSession();
  const { data: bet, error, loading } = useApi<Bet>(`/bets/${id}`);
  // Opened from a shared link: nothing has loaded the roster yet
  const roster = useApi<{ players: Player[] }>(Object.keys(players).length ? null : "/current");
  useEffect(() => {
    if (roster.data) setPlayers(roster.data.players);
  }, [roster.data, setPlayers]);
  if (loading && !bet) return <Spinner />;
  if (error || !bet) return <ErrorBox error={error} />;
  const legs = bet.legs.filter((l) => !l.carriedOver).sort((a, b) => (players[a.playerId]?.slot ?? 99) - (players[b.playerId]?.slot ?? 99));
  return (
    <div>
      <Link to="/history" className="text-sm text-muted">← Archive</Link>
      <h1 className="font-display text-2xl mt-1">{bet.title ?? fmtDate(bet.date, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</h1>
      <div className="flex flex-wrap gap-1.5 mt-2">
        <span className="chip bg-surface-2">{bet.result === "W" ? "HIT 💰" : bet.result === "L" ? `Lost ${bet.record ?? ""}` : bet.status}</span>
        <span className="chip bg-surface-2 font-mono">{fmtOdds(bet.totalOdds ?? bet.computedOdds)}</span>
        {bet.wager != null && <span className="chip bg-surface-2">{fmtMoney(bet.wager)} → {fmtMoney(bet.toWin)}</span>}
        {bet.bozoId && <span className="chip bg-surface-2">placed by {players[bet.bozoId]?.displayName}</span>}
        {bet.reloadOf && <Link to={`/bets/${bet.reloadOf}`} className="chip bg-surface-2 text-accent">reload of earlier bet</Link>}
        {bet.reloadedInto && <Link to={`/bets/${bet.reloadedInto}`} className="chip bg-surface-2 text-accent">reloaded → next bet</Link>}
      </div>
      {bet.perPerson != null && bet.result === "W" && <div className="card p-3 mt-3 text-sm">💰 Paid {fmtMoney(bet.payout)} · {fmtMoney(bet.perPerson)} each after funding the next bet</div>}
      <Section title="Legs">
        <div className="grid gap-2">
          {legs.map((l) => <LegCard key={l.playerId} leg={l} player={players[l.playerId]} />)}
        </div>
      </Section>
      {bet.nextBozoId && (
        <Section title="Bozo">
          {bet.voting?.votes ? (
            <VoteTally votes={bet.voting.votes} winnerId={bet.nextBozoId}
              rows={(bet.candidates ?? []).map((c) => ({ id: c, title: players[c]?.displayName ?? c, subtitle: bet.legs.find((l) => l.playerId === c)?.text }))} />
          ) : (
            <div className="card p-4 flex items-center gap-3">
              <Avatar p={players[bet.nextBozoId]} size={44} crown />
              <div><div className="font-bold">{players[bet.nextBozoId]?.displayName}</div><div className="text-xs text-muted">{METHOD[bet.nextBozoMethod ?? ""]}</div></div>
            </div>
          )}
        </Section>
      )}
      {bet.slipUrl && (
        <Section title="The Slip">
          <img src={bet.slipUrl} alt="Bet slip" className="card w-full" loading="lazy" />
        </Section>
      )}
    </div>
  );
}
