import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useApi } from "../lib/api";
import { fmtDate, fmtMoney, fmtOdds } from "../lib/format";
import { useSession } from "../lib/session";
import type { Bet, Player } from "../lib/types";
import { LegCard } from "../components/LegCard";
import { VoteTally } from "../components/VoteTally";
import { Avatar, Empty, ErrorBox, Section, Spinner } from "../components/ui";

const METHOD: Record<string, string> = { voted: "🗳️ voted", auto: "🎯 only loser", reload: "🔁 reload", stays: "💰 hit, goes again" };

export default function History() {
  const { setPlayers, players } = useSession();
  const [kind, setKind] = useState<"bozo" | "side">("bozo");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(25);
  const { data, error, loading } = useApi<{ bets: Bet[]; players: Player[] }>("/bets");

  useEffect(() => {
    if (data) setPlayers(data.players);
  }, [data, setPlayers]);

  const bets = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.bets ?? []).filter((b) => b.kind === kind && (!needle || b.legs.some((l) => l.text.toLowerCase().includes(needle)) || (b.title ?? "").toLowerCase().includes(needle)));
  }, [data, kind, q]);

  if (loading && !data) return <Spinner label="Digging through the wreckage…" />;
  if (error) return <ErrorBox error={error} />;

  return (
    <div>
      <h1 className="font-display text-3xl">The Archive</h1>
      <p className="text-ink-2 text-sm">Every bet, every bozo, every bad beat.</p>
      <div className="flex gap-2 mt-4">
        {(["bozo", "side"] as const).map((k) => (
          <button key={k} className={`btn !min-h-9 flex-1 ${kind === k ? "btn-primary" : "btn-ghost"}`} onClick={() => setKind(k)}>
            {k === "bozo" ? "Bozo Bets" : "Side Bets"}
          </button>
        ))}
      </div>
      <input className="input mt-2" placeholder="Search legs… (e.g. Packers, ATD)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search legs" />
      <div className="grid gap-2 mt-3">
        {bets.slice(0, shown).map((b) => {
          const losers = b.legs.filter((l) => l.result === "L" && !l.carriedOver);
          return (
            <Link key={b.id} to={`/bets/${b.id}`} className="card p-3.5 flex items-center gap-3">
              <div className="w-12 text-center shrink-0">
                <div className="text-[10px] uppercase text-muted font-bold">{fmtDate(b.date, { month: "short" })}</div>
                <div className="font-display text-xl leading-none">{fmtDate(b.date, { day: "numeric" })}</div>
                <div className="text-[10px] text-muted">{b.date.slice(0, 4)}</div>
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-sm">
                  {b.title ?? (b.result === "W" ? "HIT 💰" : b.status !== "CLOSED" ? "In progress" : `${b.record ?? ""} ${b.outcome === "reload" ? "· reloaded" : ""}`)}
                </div>
                <div className="text-xs text-ink-2 truncate">
                  {losers.length ? `💀 ${losers.map((l) => players[l.playerId]?.displayName).join(", ")}` : b.result === "W" ? `${fmtMoney(b.payout)} paid out` : ""}
                </div>
                {b.nextBozoId && <div className="text-xs text-muted mt-0.5">🤡 {players[b.nextBozoId]?.displayName} · {METHOD[b.nextBozoMethod ?? ""] ?? ""}</div>}
              </div>
              <span className="font-mono text-sm tabular">{fmtOdds(b.totalOdds ?? b.computedOdds)}</span>
            </Link>
          );
        })}
        {!bets.length && <Empty title="Nothing here">Try a different search.</Empty>}
        {bets.length > shown && <button className="btn btn-ghost" onClick={() => setShown(shown + 25)}>Show older ({bets.length - shown} more)</button>}
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
