import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useApi } from "../lib/api";
import { login } from "../lib/auth";
import { fmtDate, fmtMoney, fmtOdds, fmtPct, timeAgo } from "../lib/format";
import { useSession } from "../lib/session";
import type { Bet, Current, Player, Stats } from "../lib/types";
import { LegCard } from "../components/LegCard";
import { Avatar, Empty, ErrorBox, Section, Spinner } from "../components/ui";
import { SubmitLeg } from "./SubmitLeg";

const HOW: Record<string, string> = {
  voted: "voted in by the boys",
  auto: "the only leg that lost. No vote needed.",
  reload: "self-proclaimed. Reloaded like a champ.",
  stays: "goes again. The parlay HIT. 💰",
  kept: "keeps the job. Side bet missed, no vote.",
};

/** Survival odds of the parlay: product of implied probabilities of undecided legs. */
function sweat(bet: Bet) {
  const legs = bet.legs.filter((l) => !l.carriedOver);
  if (legs.some((l) => l.result === "L" || l.live?.status === "LOST")) return 0;
  let p = 1;
  for (const l of legs) {
    if (l.result || l.live?.status === "WON" || l.live?.status === "PUSH") continue;
    if (l.odds == null) return null;
    const d = l.odds > 0 ? 1 + l.odds / 100 : 1 + 100 / Math.abs(l.odds);
    p *= 1 / d;
  }
  return p;
}

export default function Home() {
  const { players, setPlayers, me, atLeast, role, ready } = useSession();
  const { data, error, loading, reload } = useApi<Current>("/current");
  const summary = useApi<Stats["group"]>(ready && role === "public" ? "/summary" : null);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [sideSubmit, setSideSubmit] = useState<Bet | null>(null);

  useEffect(() => {
    if (data) setPlayers(data.players);
  }, [data, setPlayers]);

  // Poll while games are live so the board stays fresh
  useEffect(() => {
    if (data?.bet?.status !== "LOCKED") return;
    const t = setInterval(reload, 60_000);
    return () => clearInterval(t);
  }, [data?.bet?.status, reload]);

  const bet = data?.bet ?? null;
  const bozo = data?.currentBozoId ? players[data.currentBozoId] : undefined;
  const myLeg = bet?.legs.find((l) => l.playerId === me?.id && !l.carriedOver);
  const activeCount = useMemo(() => Object.values(players).filter((p) => p.active).length, [players]);
  const legs = (bet?.legs ?? []).filter((l) => !l.carriedOver).sort((a, b) => (players[a.playerId]?.slot ?? 99) - (players[b.playerId]?.slot ?? 99));
  const missing = Object.values(players).filter((p) => p.active && !legs.some((l) => l.playerId === p.id));

  if (loading && !data) return <Spinner label="Finding the bozo…" />;
  if (error) return <ErrorBox error={error} />;

  const sw = bet?.status === "LOCKED" ? sweat(bet) : null;

  return (
    <div>
      {/* Hero: who's the bozo */}
      <div className="card p-5 relative overflow-hidden" style={{ background: "radial-gradient(120% 90% at 100% 0%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 60%), var(--surface)" }}>
        <div className="text-[11px] uppercase tracking-[0.2em] text-muted font-bold">Current Bozo</div>
        <div className="flex items-center gap-4 mt-3">
          <PlayerLink p={bozo}><Avatar p={bozo} size={72} crown /></PlayerLink>
          <div className="min-w-0">
            <div className="font-display text-2xl leading-tight break-words"><PlayerLink p={bozo}>{bozo?.displayName ?? "TBD"}</PlayerLink></div>
            <div className="text-sm text-ink-2 mt-1">{data?.lastBet?.nextBozoMethod ? HOW[data.lastBet.nextBozoMethod] : "Has to go to the casino. Thoughts and prayers."}</div>
          </div>
        </div>
        <CallToAction bet={bet} hasLeg={!!myLeg} onSubmit={() => setSubmitOpen(true)} />
      </div>

      {role === "public" && summary.data && (
        <div className="card p-4 mt-3 text-sm">
          <span className="font-bold">Cursed?</span> The group has hit <b>{summary.data.hits}</b> of {summary.data.parlays} parlays (
          {fmtPct(summary.data.hitRate, 1)}). The odds said {fmtPct(summary.data.expectedHitRate, 1)}.{" "}
          <button className="underline text-accent font-semibold" onClick={() => login()}>Log in</button> for the receipts.
        </div>
      )}

      {bet ? (
        <Section
          title={bet.reloadOf ? "The Reload" : "This Week"}
          right={<span className="text-xs text-muted">{fmtDate(bet.date, { weekday: "short", month: "short", day: "numeric" })}</span>}
        >
          <BetSummary bet={bet} legCount={legs.length} activeCount={activeCount} sweat={sw} />
          <div className="grid gap-2 mt-2">
            {legs.map((l) => (
              <LegCard key={l.playerId} leg={l} player={players[l.playerId]} isBozo={l.playerId === data?.currentBozoId} isMe={l.playerId === me?.id}
                onClick={l.playerId === me?.id && bet.status === "OPEN" ? () => setSubmitOpen(true) : undefined} />
            ))}
            {bet.status === "OPEN" && missing.map((p) => (
              <div key={p.id} className="card p-3.5 flex items-center gap-3 border-dashed opacity-70">
                <PlayerLink p={p}><Avatar p={p} size={40} dim /></PlayerLink>
                <div className="text-sm"><PlayerLink p={p}><b>{p.displayName}</b></PlayerLink> <span className="text-muted">hasn't picked yet. Scared?</span></div>
              </div>
            ))}
          </div>
        </Section>
      ) : (
        <Section title="This Week">
          <Empty emoji="🎰" title="No active bet">The bozo hasn't opened the books yet. Go yell at them in Slack.</Empty>
        </Section>
      )}

      {data?.lastBet && (!bet || bet.status === "OPEN") && <LastResult bet={data.lastBet} />}

      {!!data?.sideBets.length && (
        <Section title="Side Action">
          <div className="grid gap-2">
            {data.sideBets.map((b) => {
              const mine = b.legs.find((l) => l.playerId === me?.id);
              return (
                <div key={b.id} className="card p-3.5">
                  <Link to={atLeast("viewer") ? `/bets/${b.id}` : "#"} className="flex justify-between items-center">
                    <div>
                      <div className="font-bold">🎲 {b.title || "Side bet"}</div>
                      <div className="text-xs text-muted">{b.legs.length} legs · {b.status === "OPEN" ? "taking legs" : "locked"} · doesn't count for stats</div>
                    </div>
                    <span className="font-mono text-sm">{fmtOdds(b.totalOdds ?? b.computedOdds)}</span>
                  </Link>
                  {b.status === "OPEN" && me && atLeast("player") && (
                    <button className="btn btn-ghost w-full mt-2.5 text-sm" onClick={() => setSideSubmit(b)}>
                      {mine ? `Change your leg: ${mine.text}` : "Submit your side bet leg"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {bet && <SubmitLeg open={submitOpen} onClose={() => setSubmitOpen(false)} bet={bet} existing={myLeg} onSaved={reload} />}
      {sideSubmit && <SubmitLeg open onClose={() => setSideSubmit(null)} bet={sideSubmit} existing={sideSubmit.legs.find((l) => l.playerId === me?.id)} onSaved={reload} />}
    </div>
  );
}

/** Wraps a player's avatar/name in a link to their page, for anyone allowed to see it. */
function PlayerLink({ p, children }: { p?: Player; children: React.ReactNode }) {
  const { atLeast } = useSession();
  if (!p || !atLeast("viewer")) return <>{children}</>;
  return <Link to={`/stats/${p.id}`} className="hover:underline">{children}</Link>;
}

function CallToAction({ bet, hasLeg, onSubmit }: { bet: Bet | null; hasLeg: boolean; onSubmit: () => void }) {
  const { role, me } = useSession();
  if (role === "public") return <button className="btn btn-primary w-full mt-5" onClick={() => login()}>Log in with Google</button>;
  if (role === "none") return <div className="mt-5 text-sm text-ink-2 card p-3 bg-surface-2">You're logged in, but the admin hasn't let you into the circus yet.</div>;
  if (!bet || !me) return null;
  if (bet.status === "OPEN")
    return <button className={`btn w-full mt-5 ${hasLeg ? "btn-ghost" : "btn-primary"}`} onClick={onSubmit}>{hasLeg ? "Change your leg" : "Submit your leg"}</button>;
  if (bet.status === "VOTING") {
    const voted = bet.voting?.voted.includes(me.id);
    const canVote = bet.voting?.voters.includes(me.id);
    if (canVote && !voted) return <Link to="/vote" className="btn btn-gold w-full mt-5">🗳️ Vote for the bozo</Link>;
    return <Link to="/vote" className="btn btn-ghost w-full mt-5">Waiting on {(bet.voting?.voters.length ?? 0) - (bet.voting?.voted.length ?? 0)} votes…</Link>;
  }
  return null;
}

function BetSummary({ bet, legCount, activeCount, sweat }: { bet: Bet; legCount: number; activeCount: number; sweat: number | null }) {
  const odds = bet.totalOdds ?? bet.computedOdds;
  const label = { OPEN: `Collecting legs · ${legCount}/${activeCount}`, LOCKED: "Slip locked · sweating", VOTING: "Voting", CLOSED: "Closed" }[bet.status];
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <span className="chip bg-surface-2 text-ink-2">{bet.status === "LOCKED" && <span className="live-dot" aria-hidden />}{label}</span>
        {bet.bettingFloor != null && <span className="chip" style={{ boxShadow: "inset 0 0 0 1.5px var(--warn)", color: "var(--warn)" }}>Floor {fmtOdds(bet.bettingFloor)}</span>}
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3 text-center">
        <div><div className="text-[11px] text-muted uppercase font-semibold">Odds</div><div className="font-display text-xl tabular">{fmtOdds(odds)}</div></div>
        <div><div className="text-[11px] text-muted uppercase font-semibold">Wager</div><div className="font-display text-xl tabular">{fmtMoney(bet.wager)}</div></div>
        <div><div className="text-[11px] text-muted uppercase font-semibold">To win</div><div className="font-display text-xl tabular text-gold">{fmtMoney(bet.toWin ?? (odds && bet.wager ? bet.wager * (odds > 0 ? 1 + odds / 100 : 1 + 100 / -odds) : null))}</div></div>
      </div>
      {sweat != null && (
        <div className="mt-3">
          <div className="flex justify-between text-xs mb-1"><span className="font-bold">Sweat meter</span><span className="tabular">{sweat === 0 ? "Dead 💀" : `${fmtPct(sweat, 1)} alive`}</span></div>
          <div className="h-2 rounded-full bg-surface-2 overflow-hidden"><div className="h-full rounded-full bg-gold" style={{ width: `${Math.max(sweat * 100, sweat ? 2 : 0)}%` }} /></div>
        </div>
      )}
      {bet.tracker?.lastRun && (
        <div className="text-[11px] text-muted mt-3">
          🛰️ Tracker checked {timeAgo(bet.tracker.lastRun)}
          {bet.tracker.nextRun ? ` · next ${new Date(bet.tracker.nextRun).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })} CT` : ` · ${bet.tracker.why ?? "off"}`}
        </div>
      )}
      {bet.slipUrl && <a href={bet.slipUrl} target="_blank" rel="noreferrer" className="block text-xs text-accent font-semibold mt-3">View the slip 🧾</a>}
    </div>
  );
}

function LastResult({ bet }: { bet: Bet }) {
  const { players } = useSession();
  const losers = bet.legs.filter((l) => l.result === "L" && !l.carriedOver);
  return (
    <Section title="Last Week">
      <Link to={`/bets/${bet.id}`} className="card p-4 block">
        <div className="flex justify-between items-center">
          <div className="font-bold">{fmtDate(bet.date)} · {bet.result === "W" ? "HIT 💰" : `${bet.record} 💀`}</div>
          <span className="font-mono text-sm">{fmtOdds(bet.totalOdds)}</span>
        </div>
        {losers.length > 0 && <div className="text-sm text-ink-2 mt-1">Killed by {losers.map((l) => players[l.playerId]?.displayName).join(", ")}</div>}
      </Link>
    </Section>
  );
}
