import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { post, useApi } from "../lib/api";
import { useSession } from "../lib/session";
import type { BallotEntry, Bet, Current } from "../lib/types";
import { VoteTally } from "../components/VoteTally";
import { Avatar, Empty, ErrorBox, Odds, Section, Spinner } from "../components/ui";

export default function Vote() {
  const { players, setPlayers, me } = useSession();
  const { data, error, loading, setData } = useApi<Current>("/current");
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (data) setPlayers(data.players);
  }, [data, setPlayers]);

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} />;

  // Show the active vote, or the most recently revealed one
  const bet: Bet | null = data?.bet?.status === "VOTING" ? data.bet : data?.lastBet?.voting?.revealed ? data.lastBet : null;
  if (!bet || !bet.voting) return <Empty emoji="🗳️" title="Nothing to vote on">Everyone's leg has to settle first. <Link className="text-accent underline" to="/">Back home</Link></Empty>;

  const v = bet.voting;
  const canVote = bet.status === "VOTING" && !!me && v.voters.includes(me.id) && !v.myVote;

  async function cast() {
    if (!pick) return;
    setBusy(true);
    setErr(null);
    try {
      const updated = await post<Bet>(`/bets/${bet!.id}/vote`, { candidateId: pick });
      setData((d) => (d ? { ...d, bet: updated.status === "CLOSED" ? null : updated, lastBet: updated.status === "CLOSED" ? updated : d.lastBet } : d));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ballot = ballotOf(bet);

  return (
    <div>
      <h1 className="font-display text-3xl">{v.revealed ? "The People Have Spoken" : "Worst Bet of the Week"}</h1>
      <p className="text-ink-2 text-sm mt-1">
        {v.revealed ? "Votes are public. Grudges are forever." : `Vote on the bet, not the bettor. Only losing legs make the ballot. Votes stay secret until all ${v.voters.length} are in.`}
      </p>

      {v.revealed ? (
        <>
          {bet.nextBozoId && (
            <div className="card p-6 mt-4 text-center pop">
              <div className="inline-block"><Avatar p={players[bet.nextBozoId]} size={88} crown /></div>
              <div className="font-display text-2xl mt-3">{players[bet.nextBozoId]?.displayName}</div>
              <div className="text-ink-2 text-sm">Pack your bags. You're going to the casino. 🎰</div>
            </div>
          )}
          <Section title="Tally">
            <VoteTally votes={v.votes ?? []} winnerId={bet.nextBozoId}
              rows={ballot.map((b) => ({ id: b.playerId, title: <>{b.label} · {players[b.playerId]?.displayName}</>,
                subtitle: <>{b.text} <Odds o={b.odds} />{b.headline ? ` · “${b.headline}”` : ""}</> }))} />
          </Section>
        </>
      ) : (
        <>
          <div className="grid gap-2 mt-4">
            {ballot.map((b) => {
              const leg = bet.legs.find((l) => l.playerId === b.playerId);
              const selected = pick === b.playerId || v.myVote === b.playerId;
              return (
                <button key={b.playerId} disabled={!canVote} onClick={() => setPick(b.playerId)}
                  className="card p-4 text-left transition"
                  style={selected ? { boxShadow: "inset 0 0 0 2px var(--accent)", background: "color-mix(in srgb, var(--accent) 10%, var(--surface))" } : undefined}
                  aria-pressed={selected}>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider font-bold text-muted">
                        {b.label}{b.playerId === me?.id && <span className="chip bg-surface-2 normal-case tracking-normal">yours</span>}
                      </div>
                      <div className="font-bold mt-1 break-words">{b.text} <Odds o={b.odds} /></div>
                      {leg?.live?.detail && <div className="text-xs text-muted mt-0.5">{leg.live.detail}</div>}
                      {typeof leg?.enrichment?.margin === "number" && <div className="text-xs mt-0.5" style={{ color: "var(--serious)" }}>missed by {Math.abs(leg.enrichment.margin as number)} 💀</div>}
                    </div>
                    {selected && <span className="text-2xl">🤡</span>}
                  </div>
                  {b.take && (
                    <div className="mt-3 rounded-lg bg-surface-2 p-3 text-sm">
                      <div className="font-display">🎙️ {b.headline}</div>
                      <div className="text-ink-2 mt-1">{b.take}</div>
                    </div>
                  )}
                </button>
              );
            })}
          </div>
          {canVote && <button className="btn btn-primary w-full mt-4" disabled={!pick || busy} onClick={cast}>{busy ? "Casting…" : "Cast your vote (no take-backs)"}</button>}
          {v.myVote && <div className="text-center text-sm text-ink-2 mt-4">Vote cast. Now we wait. 🍿</div>}
          {err && <div className="text-sm mt-3" style={{ color: "var(--serious)" }}>{err}</div>}
          <Section title={`Voted ${v.voted.length}/${v.voters.length}`}>
            <div className="flex flex-wrap gap-3">
              {v.voters.map((id) => (
                <div key={id} className="flex flex-col items-center gap-1 w-14">
                  <Avatar p={players[id]} size={40} dim={!v.voted.includes(id)} />
                  <span className="text-[10px] text-center leading-tight">{v.voted.includes(id) ? "✓ voted" : "waiting"}</span>
                </div>
              ))}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

/** The nameless ballot; votes that opened before ballots existed get plain labels. */
function ballotOf(bet: Bet): BallotEntry[] {
  if (bet.ballot?.length) return bet.ballot;
  return (bet.candidates ?? []).map((c, i) => {
    const leg = bet.legs.find((l) => l.playerId === c);
    return { playerId: c, label: `Bet ${String.fromCharCode(65 + i)}`, text: leg?.text, odds: leg?.odds };
  });
}
