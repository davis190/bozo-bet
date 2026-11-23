import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { post, useApi } from "../lib/api";
import { useSession } from "../lib/session";
import type { Bet, Current } from "../lib/types";
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

  const candidates = bet.candidates ?? [];
  const maxVotes = Math.max(1, ...Object.values(v.tally ?? {}));

  return (
    <div>
      <h1 className="font-display text-3xl">{v.revealed ? "The People Have Spoken" : "Who's the Bozo?"}</h1>
      <p className="text-ink-2 text-sm mt-1">
        {v.revealed ? "Votes are public. Grudges are forever." : `Only losers are on the ballot. Votes stay secret until all ${v.voters.length} are in.`}
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
            <div className="card p-4 grid gap-3">
              {candidates.map((c) => (
                <div key={c}>
                  <div className="flex justify-between text-sm mb-1"><span className="font-bold">{players[c]?.displayName}</span><span className="tabular">{v.tally?.[c] ?? 0}</span></div>
                  <div className="h-2.5 rounded-full bg-surface-2 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${((v.tally?.[c] ?? 0) / maxVotes) * 100}%`, background: "var(--accent)" }} />
                  </div>
                </div>
              ))}
            </div>
          </Section>
          <Section title="Receipts">
            <div className="card divide-y divide-[var(--border)]">
              {(v.votes ?? []).map((x) => (
                <div key={x.voterId} className="flex items-center gap-3 p-3 text-sm">
                  <Avatar p={players[x.voterId]} size={28} />
                  <span className="font-semibold">{players[x.voterId]?.displayName}</span>
                  <span className="text-muted">→</span>
                  <Avatar p={players[x.candidateId]} size={28} />
                  <span className="font-semibold">{players[x.candidateId]?.displayName}</span>
                  {x.voterId === x.candidateId && <span className="chip bg-surface-2 text-gold ml-auto">self-snitch</span>}
                </div>
              ))}
            </div>
          </Section>
        </>
      ) : (
        <>
          <div className="grid gap-2 mt-4">
            {candidates.map((c) => {
              const leg = bet.legs.find((l) => l.playerId === c);
              const selected = pick === c || v.myVote === c;
              return (
                <button key={c} disabled={!canVote} onClick={() => setPick(c)}
                  className="card p-4 flex items-center gap-3 text-left transition"
                  style={selected ? { boxShadow: "inset 0 0 0 2px var(--accent)", background: "color-mix(in srgb, var(--accent) 10%, var(--surface))" } : undefined}
                  aria-pressed={selected}>
                  <Avatar p={players[c]} size={48} />
                  <div className="min-w-0 flex-1">
                    <div className="font-bold">{players[c]?.displayName}{c === me?.id && <span className="text-xs text-muted"> (you)</span>}</div>
                    <div className="text-sm text-ink-2 break-words">{leg?.text} <Odds o={leg?.odds} /></div>
                    {typeof leg?.enrichment?.margin === "number" && <div className="text-xs mt-0.5" style={{ color: "var(--serious)" }}>missed by {Math.abs(leg.enrichment.margin as number)} 💀</div>}
                  </div>
                  {selected && <span className="text-2xl">🤡</span>}
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
