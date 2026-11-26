import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, del, patch, post, put, useApi } from "../lib/api";
import { fmtOdds } from "../lib/format";
import { useSession } from "../lib/session";
import type { Bet, Current, Leg, ParsedLeg, Player, Result, User } from "../lib/types";
import { Avatar, ErrorBox, Section, Spinner } from "../components/ui";

const TABS = ["Bet", "Slack", "Checks", "People", "Settings"] as const;

export default function Admin() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Bet");
  const { atLeast } = useSession();
  if (!atLeast("admin")) return <ErrorBox error={{ message: "Admins only. Nice try, bozo." }} />;
  return (
    <div>
      <h1 className="font-display text-3xl">Admin</h1>
      <div className="grid grid-cols-5 gap-1 mt-3 card p-1">
        {TABS.map((t) => (
          <button key={t} className={`btn !min-h-9 !px-1 text-[13px] ${tab === t ? "btn-primary" : ""}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === "Bet" && <BetControl />}
      {tab === "Slack" && <SlackImport />}
      {tab === "Checks" && <DataChecks />}
      {tab === "People" && <People />}
      {tab === "Settings" && <Settings />}
    </div>
  );
}

function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok = "Done ✓") => {
    try {
      await fn();
      setMsg(ok);
    } catch (e) {
      setMsg(`😬 ${(e as Error).message}`);
    }
    setTimeout(() => setMsg(null), 3500);
  };
  const el = msg && <div className="fixed left-1/2 -translate-x-1/2 bottom-24 z-50 card px-4 py-2.5 text-sm font-semibold pop shadow-lg">{msg}</div>;
  return { run, el };
}

// ---------------- Bet control ----------------
export function BetControl() {
  const { id } = useParams();
  const { setPlayers, players } = useSession();
  const cur = useApi<Current>("/current");
  const [betId, setBetId] = useState<string | null>(id ?? null);
  const [creating, setCreating] = useState<"bozo" | "side" | null>(null);
  const bet = useApi<Bet>(betId ? `/bets/${betId}` : null, [betId]);
  const { run, el } = useToast();

  useEffect(() => { if (cur.data) setPlayers(cur.data.players); }, [cur.data, setPlayers]);
  useEffect(() => {
    if (!id && cur.data && !betId && !creating) setBetId(cur.data.bet?.id ?? null);
  }, [cur.data, id, betId, creating]);

  const reloadAll = async () => { await cur.reload(); await bet.reload(); };

  if (cur.loading && !cur.data) return <Spinner />;
  const choices = [cur.data?.bet, ...(cur.data?.sideBets ?? [])].filter(Boolean) as Bet[];

  return (
    <div>
      {el}
      <div className="flex gap-1.5 mt-4 items-center overflow-x-auto">
        {choices.length > 1 && (
          <div className="flex p-1 rounded-full bg-surface-2 gap-1" role="tablist" aria-label="Which bet">
            {choices.map((b) => (
              <button key={b.id} role="tab" aria-selected={betId === b.id && !creating} onClick={() => { setCreating(null); setBetId(b.id); }}
                className={`chip !py-1.5 !px-3 whitespace-nowrap ${betId === b.id && !creating ? "bg-accent text-white" : ""}`}>
                {b.kind === "side" ? `🎲 ${b.title || "Side bet"}` : `🤡 Bozo bet`}
              </button>
            ))}
          </div>
        )}
        <button onClick={() => { setCreating("side"); setBetId(null); }} className={`chip !py-1.5 !px-3 whitespace-nowrap ml-auto ${creating === "side" ? "bg-accent text-white" : "bg-surface-2"}`}>🎲 Open side bet</button>
      </div>
      {creating || !betId || !bet.data ? (
        <CreateBet key={creating ?? "new"} initialKind={creating ?? undefined}
          onCreated={(b) => { setCreating(null); setBetId(b.id); cur.reload(); }}
          onCancel={creating && cur.data?.bet ? () => { setCreating(null); setBetId(cur.data!.bet!.id); } : undefined}
          hasActive={!!cur.data?.bet} defaultWager={cur.data?.settings.defaultWager ?? 10} />
      ) : (
        <BetEditor bet={bet.data} players={players} run={run} onChange={reloadAll} onNew={() => setBetId(null)} />
      )}
    </div>
  );
}

function CreateBet({ onCreated, onCancel, hasActive, defaultWager, initialKind }: { onCreated: (b: Bet) => void; onCancel?: () => void; hasActive: boolean; defaultWager: number; initialKind?: "bozo" | "side" }) {
  const { players } = useSession();
  const [f, setF] = useState({ kind: initialKind ?? (hasActive ? "side" : "bozo"), date: new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }), wager: String(defaultWager), bettingFloor: "", title: "", bozoId: "" });
  const [err, setErr] = useState<string | null>(null);
  async function create() {
    setErr(null);
    try {
      onCreated(await post<Bet>("/admin/bets", {
        kind: f.kind, date: f.date, wager: Number(f.wager), title: f.title || undefined,
        bettingFloor: f.bettingFloor ? parseInt(f.bettingFloor, 10) : undefined, bozoId: f.bozoId || undefined,
      }));
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <Section title="Open a new bet">
      <div className="card p-4 grid gap-3">
        <div className="grid grid-cols-2 gap-2">
          {(["bozo", "side"] as const).map((k) => <button key={k} className={`btn ${f.kind === k ? "btn-primary" : "btn-ghost"}`} onClick={() => setF({ ...f, kind: k })}>{k === "bozo" ? "🤡 Bozo bet" : "🎲 Side bet"}</button>)}
        </div>
        <Field label="Date"><input type="date" className="input" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        {f.kind === "side" && <Field label="Title"><input className="input" placeholder="Thanksgiving Day Bet" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Wager $"><input className="input" inputMode="decimal" value={f.wager} onChange={(e) => setF({ ...f, wager: e.target.value })} /></Field>
          <Field label="Betting floor"><input className="input font-mono" placeholder="-115" value={f.bettingFloor} onChange={(e) => setF({ ...f, bettingFloor: e.target.value })} /></Field>
        </div>
        <Field label={f.kind === "bozo" ? "Bozo (defaults to current)" : "Who's paying"}>
          <select className="input" value={f.bozoId} onChange={(e) => setF({ ...f, bozoId: e.target.value })}>
            <option value="">{f.kind === "bozo" ? "Current bozo" : "—"}</option>
            {Object.values(players).filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
          </select>
        </Field>
        {f.kind === "side" && <div className="text-xs text-muted">Side bets run alongside the bozo bet. They don't count toward stats and never change who's bozo.</div>}
        <button className="btn btn-primary" onClick={create}>Open the books</button>
        {onCancel && <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
        {err && <div className="text-sm" style={{ color: "var(--serious)" }}>{err}</div>}
      </div>
    </Section>
  );
}

/** Legs whose games haven't started roll into the reload; anything lost, won or live has to be re-picked. */
const rollsOver = (l: Leg) => !l.result && (l.live?.state ?? "pre") === "pre";

function ReloadPanel({ bet, players, run, onDone }: { bet: Bet; players: Record<string, Player>; run: ReturnType<typeof useToast>["run"]; onDone: () => Promise<void> }) {
  const legs = bet.legs.filter((l) => !l.carriedOver);
  const name = (id?: string) => (id ? players[id]?.displayName ?? id : "");
  // No-vote bet: nobody self-proclaims, the bozo stays. Otherwise pick who took the L.
  const [taker, setTaker] = useState<string | null>(null);
  const reloader = bet.noVote ? null : taker;
  const carry = legs.filter((l) => l.playerId !== reloader && rollsOver(l));
  const repick = legs.filter((l) => !carry.includes(l));
  const ready = bet.noVote || !!taker;
  const go = () => run(async () => { await post(`/admin/bets/${bet.id}/reload`, reloader ? { playerId: reloader } : {}); await onDone(); }, "Reloaded. Slack knows who's re-picking.");
  return (
    <div className="border-t border-[var(--border)] pt-3 grid gap-2">
      <div className="text-sm font-bold">🔁 Reload: an early leg lost, start a fresh parlay</div>
      {bet.noVote ? (
        <p className="text-xs text-muted">No-vote bet: {name(bet.bozoId)} stays bozo, and the new bet is no-vote too.</p>
      ) : (
        <>
          <p className="text-xs text-muted">Who's taking the L? They become bozo.</p>
          <div className="flex flex-wrap gap-2">
            {legs.filter((l) => l.result !== "W").map((l) => (
              <button key={l.playerId} className={`btn !min-h-9 text-sm ${taker === l.playerId ? "btn-primary" : "btn-ghost"}`} onClick={() => setTaker(taker === l.playerId ? null : l.playerId)} aria-pressed={taker === l.playerId}>
                {name(l.playerId)}{l.result === "L" ? " ❌" : ""}
              </button>
            ))}
          </div>
        </>
      )}
      {ready && (
        <div className="text-xs grid gap-1">
          <div><span className="font-bold">➡️ Rolls over:</span> {carry.map((l) => name(l.playerId)).join(", ") || "nobody"}</div>
          <div><span className="font-bold">✏️ Re-picks:</span> {repick.map((l) => `${name(l.playerId)} (${l.result === "W" ? "won" : l.result === "L" || l.playerId === reloader ? "lost" : "live"})`).join(", ") || "nobody"}</div>
        </div>
      )}
      <button className="btn btn-ghost" disabled={!ready || !carry.length}
        onClick={() => confirm(bet.noVote ? `Reload? ${name(bet.bozoId)} stays bozo.` : `${name(reloader!)} self-proclaims bozo and reloads?`) && go()}>
        {!carry.length && ready ? "Every game has started: nothing to roll over" : "Reload"}
      </button>
    </div>
  );
}

function BetEditor({ bet, players, run, onChange, onNew }: { bet: Bet; players: Record<string, Player>; run: ReturnType<typeof useToast>["run"]; onChange: () => Promise<void>; onNew: () => void }) {
  const active = Object.values(players).filter((p) => p.active || bet.legs.some((l) => l.playerId === p.id)).sort((a, b) => a.slot - b.slot);
  const legFor = (pid: string) => bet.legs.find((l) => l.playerId === pid && !l.carriedOver);
  const [meta, setMeta] = useState({ wager: String(bet.wager ?? ""), bettingFloor: bet.bettingFloor != null ? String(bet.bettingFloor) : "", bozoId: bet.bozoId ?? "" });
  const [payout, setPayout] = useState("");
  const [choice, setChoice] = useState("");
  useEffect(() => setMeta({ wager: String(bet.wager ?? ""), bettingFloor: bet.bettingFloor != null ? String(bet.bettingFloor) : "", bozoId: bet.bozoId ?? "" }), [bet]);

  const setResult = (pid: string, result: Result | null) =>
    run(async () => { await put(`/admin/bets/${bet.id}/legs/${pid}`, { ...legFor(pid), result }); await onChange(); }, "Result saved");

  return (
    <>
      <Section title={bet.title ?? `Bozo bet · ${bet.date}`} right={<span className="flex gap-1.5">{bet.noVote && <span className="chip bg-surface-2">🎲 no vote</span>}<span className="chip bg-surface-2">{bet.status}</span></span>}>
        <div className="card p-4 grid gap-3">
          <div className="grid grid-cols-3 gap-2">
            <Field label="Wager"><input className="input" value={meta.wager} onChange={(e) => setMeta({ ...meta, wager: e.target.value })} /></Field>
            <Field label="Floor"><input className="input font-mono" value={meta.bettingFloor} onChange={(e) => setMeta({ ...meta, bettingFloor: e.target.value })} /></Field>
            <Field label="Bozo">
              <select className="input" value={meta.bozoId} onChange={(e) => setMeta({ ...meta, bozoId: e.target.value })}>
                <option value="">—</option>
                {active.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
              </select>
            </Field>
          </div>
          <button className="btn btn-ghost" onClick={() => run(async () => {
            await patch(`/admin/bets/${bet.id}`, { wager: Number(meta.wager) || null, bettingFloor: meta.bettingFloor ? parseInt(meta.bettingFloor, 10) : null, bozoId: meta.bozoId || null });
            await onChange();
          })}>Save details</button>
          {bet.kind === "bozo" && bet.status !== "CLOSED" && (
            <label className="flex items-start gap-3 text-sm cursor-pointer">
              <input type="checkbox" className="mt-0.5 w-5 h-5 accent-[var(--accent)]" checked={!!bet.noVote}
                onChange={(e) => {
                  const on = e.target.checked;
                  if (on && bet.status === "VOTING" && !confirm("This calls off the vote in progress. The current bozo keeps the job. Continue?")) return;
                  run(async () => { await patch(`/admin/bets/${bet.id}`, { noVote: on }); await onChange(); }, on ? "Side bet: no vote" : "Back to a normal bozo bet");
                }} />
              <span><b>Side bet: no vote</b><span className="block text-xs text-muted">Counts for stats. If it misses, nobody's voted in: the current bozo keeps the job.</span></span>
            </label>
          )}
          <div className="text-sm text-ink-2">Odds {fmtOdds(bet.totalOdds ?? bet.computedOdds)} {bet.totalOdds == null && bet.computedOdds != null && "(computed)"}</div>
        </div>
      </Section>

      <Section title="Legs">
        <div className="grid gap-2">
          {active.map((p) => <LegRow key={p.id} bet={bet} p={p} leg={legFor(p.id)} run={run} onChange={onChange} onResult={setResult} />)}
        </div>
      </Section>

      {(bet.status === "OPEN" || bet.status === "LOCKED") && <SlipPanel bet={bet} run={run} onChange={onChange} />}

      {(bet.status === "LOCKED" || bet.status === "OPEN") && (
        <Section title="Live tracker">
          <div className="card p-4 grid gap-2 text-sm">
            <div className="text-ink-2">
              {bet.tracker?.lastRun ? `${bet.tracker.runs} runs · last ${new Date(bet.tracker.lastRun).toLocaleString()} · ${bet.tracker.nextRun ? `next ${new Date(bet.tracker.nextRun).toLocaleTimeString()}` : bet.tracker.why ?? "off"}` : "Starts automatically when the slip locks."}
            </div>
            <button className="btn btn-ghost" onClick={() => run(async () => { await post(`/admin/bets/${bet.id}/track`); setTimeout(onChange, 25000); }, "Tracker started — results in ~30s 🛰️")}>🛰️ Run tracker now</button>
          </div>
        </Section>
      )}

      {bet.status === "LOCKED" && (
        <Section title="Settle">
          <div className="card p-4 grid gap-3">
            <p className="text-sm text-ink-2">Set every result above, then settle. Pushes are dropped and the payout recomputed unless you enter what the casino actually paid.</p>
            <Field label="Actual payout (optional, only if it hit)"><input className="input" inputMode="decimal" value={payout} onChange={(e) => setPayout(e.target.value)} /></Field>
            <button className="btn btn-primary" onClick={() => run(async () => { await post(`/admin/bets/${bet.id}/settle`, { payout: payout ? Number(payout) : undefined }); await onChange(); }, "Settled")}>Settle bet</button>
            {bet.kind === "bozo" && <ReloadPanel bet={bet} players={players} run={run} onDone={async () => { onNew(); await onChange(); }} />}
          </div>
        </Section>
      )}

      {bet.status === "VOTING" && (
        <Section title="Voting">
          <div className="card p-4 grid gap-3">
            <div className="text-sm">{bet.voting?.voted.length}/{bet.voting?.voters.length} voted{bet.tie && " · TIE — pick the bozo"}</div>
            <select className="input" value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Use the tally</option>
              {(bet.candidates ?? []).map((c) => <option key={c} value={c}>{players[c]?.displayName}</option>)}
            </select>
            <button className="btn btn-gold" onClick={() => run(async () => { await post(`/admin/bets/${bet.id}/close-vote`, { choice: choice || undefined }); await onChange(); }, "Vote closed")}>Close the vote</button>
          </div>
          <button className="btn btn-ghost w-full mt-2" onClick={() => run(async () => { await post(`/admin/bets/${bet.id}/ballot`, {}); await onChange(); }, "Ballot commentary rewritten")}>
            🎙️ {bet.ballot?.some((b) => b.take) ? "Rewrite" : "Write"} ballot commentary
          </button>
        </Section>
      )}

      {bet.status === "CLOSED" && (
        <div className="card p-4 mt-6 text-sm">
          Closed. Bozo: <b>{players[bet.nextBozoId ?? ""]?.displayName ?? "—"}</b> ({bet.nextBozoMethod}). <button className="text-accent font-semibold underline" onClick={onNew}>Open the next bet →</button>
        </div>
      )}
      <Link to={`/bets/${bet.id}`} className="block text-center text-sm text-muted mt-6">View public page</Link>
    </>
  );
}

function LegRow({ bet, p, leg, run, onChange, onResult }: { bet: Bet; p: Player; leg?: Leg; run: ReturnType<typeof useToast>["run"]; onChange: () => Promise<void>; onResult: (pid: string, r: Result | null) => void }) {
  const [text, setText] = useState(leg?.text ?? "");
  const [odds, setOdds] = useState(leg?.odds != null ? String(leg.odds) : "");
  useEffect(() => { setText(leg?.text ?? ""); setOdds(leg?.odds != null ? String(leg.odds) : ""); }, [leg]);
  const dirty = text !== (leg?.text ?? "") || odds !== (leg?.odds != null ? String(leg.odds) : "");
  return (
    <div className="card p-3">
      <div className="flex items-center gap-2 mb-2">
        <Avatar p={p} size={28} /><span className="font-bold text-sm flex-1">{p.displayName}</span>
        {leg?.live?.needsReview && <span className="chip" style={{ background: "var(--warn)", color: "#0b0b0b" }}>check me</span>}
        {leg?.resultSource === "tracker" && <span className="chip bg-surface-2 text-muted">🛰️ auto</span>}
        {leg?.source && <span className="chip bg-surface-2 text-muted">{leg.source}</span>}
      </div>
      <div className="flex gap-2">
        <input className="input flex-1" placeholder="No leg yet" value={text} onChange={(e) => setText(e.target.value)} />
        <input className="input !w-20 font-mono" placeholder="odds" value={odds} onChange={(e) => setOdds(e.target.value)} />
      </div>
      {leg?.live?.detail && <div className="text-xs text-ink-2 mt-1.5">{leg.live.detail}</div>}
      <div className="flex gap-1.5 mt-2 items-center">
        {(["W", "L", "P"] as const).map((r) => (
          <button key={r} disabled={!leg} onClick={() => onResult(p.id, leg?.result === r ? null : r)}
            className="btn !min-h-9 !px-3 text-sm" style={leg?.result === r ? { background: r === "W" ? "var(--good)" : r === "L" ? "var(--critical)" : "var(--muted)", color: "#fff" } : { background: "var(--surface-2)" }}>
            {r}
          </button>
        ))}
        <div className="flex-1" />
        {leg && <button className="btn btn-ghost !min-h-9 text-sm" onClick={() => confirm("Delete this leg?") && run(async () => { await del(`/admin/bets/${bet.id}/legs/${p.id}`); await onChange(); })}>🗑</button>}
        <button className="btn btn-primary !min-h-9 text-sm" disabled={!dirty || !text.trim()} onClick={() => run(async () => {
          await put(`/admin/bets/${bet.id}/legs/${p.id}`, { ...leg, text: text.trim(), odds: odds ? parseInt(odds, 10) : null, source: leg?.source ?? "admin" });
          await onChange();
        }, "Leg saved")}>Save</button>
      </div>
    </div>
  );
}

interface SlipResult {
  totalOdds?: number | null; wager?: number | null; toWin?: number | null; confidence: number;
  legs: { playerId?: string | null; ticketText: string; odds?: number | null }[];
  sgpGroups?: { playerIds: string[]; odds: number }[];
}

function SlipPanel({ bet, run, onChange }: { bet: Bet; run: ReturnType<typeof useToast>["run"]; onChange: () => Promise<void> }) {
  const { players } = useSession();
  const [key, setKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [res, setRes] = useState<SlipResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [totals, setTotals] = useState({ totalOdds: "", wager: String(bet.wager ?? ""), toWin: "" });

  async function upload(file: File) {
    setBusy(true);
    setRes(null);
    setPreview(URL.createObjectURL(file));
    await run(async () => {
      const { uploadUrl, key } = await post<{ uploadUrl: string; key: string }>(`/admin/bets/${bet.id}/slip-upload`, { contentType: file.type || "image/jpeg" });
      const r = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "content-type": file.type || "image/jpeg" } });
      if (!r.ok) throw new Error("Upload failed");
      setKey(key);
      try {
        const out = await post<SlipResult>(`/admin/bets/${bet.id}/slip-extract`, { key });
        setRes(out);
        setTotals({ totalOdds: out.totalOdds != null ? String(out.totalOdds) : "", wager: out.wager != null ? String(out.wager) : String(bet.wager ?? ""), toWin: out.toWin != null ? String(out.toWin) : "" });
      } catch (e) {
        throw new Error(`Uploaded, but couldn't read it (${(e as Error).message}). Enter odds by hand and lock.`);
      }
    }, "Slip read ✓ — check the numbers");
    setBusy(false);
  }

  async function lock() {
    const legOdds = Object.fromEntries((res?.legs ?? []).filter((l) => l.playerId && l.odds != null).map((l) => [l.playerId!, l.odds!]));
    await run(async () => {
      await post(`/admin/bets/${bet.id}/lock`, {
        slipKey: key, legOdds, sgpGroups: res ? res.sgpGroups ?? [] : undefined, totalOdds: totals.totalOdds ? parseInt(totals.totalOdds, 10) : undefined,
        wager: totals.wager ? Number(totals.wager) : undefined, toWin: totals.toWin ? Number(totals.toWin) : undefined,
      });
      await onChange();
    }, "Locked 🔒 Legs are frozen.");
  }

  return (
    <Section title={bet.status === "LOCKED" ? "Slip (locked)" : "Upload the slip → lock"}>
      <div className="card p-4 grid grid-cols-1 gap-3 min-w-0">
        <label className="btn btn-ghost cursor-pointer w-full">
          📸 {busy ? "Reading…" : key ? "Replace photo" : "Upload slip photo"}
          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
        {preview && <img src={preview} alt="Slip preview" className="rounded-xl w-full max-h-72 object-contain bg-surface-2" />}
        {res && <SlipLegs res={res} players={players} />}
        <div className="grid grid-cols-3 gap-2">
          <Field label="Total odds"><input className="input font-mono" placeholder={String(bet.computedOdds ?? "")} value={totals.totalOdds} onChange={(e) => setTotals({ ...totals, totalOdds: e.target.value })} /></Field>
          <Field label="Wager"><input className="input" value={totals.wager} onChange={(e) => setTotals({ ...totals, wager: e.target.value })} /></Field>
          <Field label="To win"><input className="input" value={totals.toWin} onChange={(e) => setTotals({ ...totals, toWin: e.target.value })} /></Field>
        </div>
        <button className="btn btn-primary" onClick={lock}>{bet.status === "LOCKED" ? "Update slip numbers" : "Lock legs 🔒"}</button>
      </div>
    </Section>
  );
}

/** What the slip reader saw, one row per ticket line. Same-game groups are bracketed with their one combined price. */
function SlipLegs({ res, players }: { res: SlipResult; players: Record<string, Player> }) {
  const groupOf = (pid?: string | null) => (res.sgpGroups ?? []).findIndex((g) => !!pid && g.playerIds.includes(pid));
  const seen = new Set<number>();
  return (
    <div className="grid gap-2 min-w-0">
      <div className="text-xs text-muted">Read with {(res.confidence * 100).toFixed(0)}% confidence. Check it against the photo.</div>
      {res.legs.map((l, i) => {
        const g = groupOf(l.playerId);
        const firstOfGroup = g >= 0 && !seen.has(g);
        if (g >= 0) seen.add(g);
        return (
          <div key={i} className="min-w-0">
            {firstOfGroup && (
              <div className="text-[11px] uppercase tracking-wider text-muted font-semibold mt-1 mb-1">
                Same-game parlay · <span className="font-mono normal-case text-ink-2">{fmtOdds(res.sgpGroups![g].odds)}</span>
              </div>
            )}
            <div className={`flex items-start gap-3 rounded-xl bg-surface-2 p-2.5 ${g >= 0 ? "border-l-2" : ""}`} style={g >= 0 ? { borderColor: "var(--accent)" } : undefined}>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-bold">{l.playerId ? players[l.playerId]?.displayName : "❓ Unmatched"}</div>
                <div className="text-sm text-ink-2 break-words leading-snug">{l.ticketText}</div>
              </div>
              <span className="font-mono text-sm shrink-0">{g >= 0 && l.odds == null ? "SGP" : fmtOdds(l.odds)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------- Slack paste ----------------
interface SlackLeg extends ParsedLeg { slackName: string; bettor?: string | null; playerId?: string | null; evidence: string }

function SlackImport() {
  const { players, setPlayers } = useSession();
  const cur = useApi<Current>("/current");
  const [text, setText] = useState("");
  const [legs, setLegs] = useState<SlackLeg[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { run, el } = useToast();
  useEffect(() => { if (cur.data) setPlayers(cur.data.players); }, [cur.data, setPlayers]);
  // Pasted legs can go to the bozo bet or any side bet still taking legs
  const targets = [cur.data?.bet, ...(cur.data?.sideBets ?? []).filter((b) => b.status === "OPEN")].filter(Boolean) as Bet[];
  const [targetId, setTargetId] = useState<string | null>(null);
  const bet = targets.find((b) => b.id === targetId) ?? targets[0];
  const betName = (b: Bet) => (b.kind === "side" ? `🎲 ${b.title || "Side bet"}` : "🤡 Bozo bet");

  return (
    <div>
      {el}
      <Section title="Paste from Slack">
        {targets.length > 1 && (
          <div className="flex p-1 rounded-full bg-surface-2 gap-1 mb-2 w-fit max-w-full overflow-x-auto" role="tablist" aria-label="Add legs to">
            {targets.map((b) => (
              <button key={b.id} role="tab" aria-selected={b.id === bet?.id} onClick={() => setTargetId(b.id)}
                className={`chip !py-1.5 !px-3 whitespace-nowrap ${b.id === bet?.id ? "bg-accent text-white" : ""}`}>{betName(b)}</button>
            ))}
          </div>
        )}
        <textarea className="input min-h-48 font-mono text-xs" placeholder="Paste the whole thread. Trash talk and all." value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn btn-primary w-full mt-2" disabled={!text.trim() || busy} onClick={async () => {
          setBusy(true);
          await run(async () => setLegs((await post<{ legs: SlackLeg[] }>("/admin/slack-extract", { conversation: text })).legs), "Extracted — review below");
          setBusy(false);
        }}>{busy ? "Reading the group chat…" : "Extract bets 🤖"}</button>
      </Section>
      {legs && (
        <Section title="Review" right={<span className="text-xs text-muted">{bet ? `→ ${betName(bet)} · ${bet.date}` : "no active bet!"}</span>}>
          <div className="grid gap-2">
            {legs.map((l, i) => (
              <div key={i} className="card p-3 grid gap-2">
                <div className="flex gap-2 items-center">
                  <select className="input !w-auto" value={l.playerId ?? ""} onChange={(e) => setLegs(legs.map((x, j) => (j === i ? { ...x, playerId: e.target.value || null } : x)))}>
                    <option value="">“{l.slackName}” → ?</option>
                    {Object.values(players).map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                  </select>
                  <span className="text-xs text-muted ml-auto">{Math.round(l.confidence * 100)}%</span>
                </div>
                <div className="flex gap-2">
                  <input className="input flex-1" value={l.text} onChange={(e) => setLegs(legs.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
                  <input className="input !w-20 font-mono" value={l.odds ?? ""} onChange={(e) => setLegs(legs.map((x, j) => (j === i ? { ...x, odds: e.target.value ? parseInt(e.target.value, 10) : null } : x)))} />
                </div>
                <div className="text-xs text-muted italic truncate">“{l.evidence}”</div>
              </div>
            ))}
            <button className="btn btn-primary" disabled={!bet} onClick={() => run(async () => {
              for (const l of legs.filter((x) => x.playerId)) {
                await put(`/admin/bets/${bet!.id}/legs/${l.playerId}`, { text: l.text, odds: l.odds ?? undefined, sgp: l.sgp, parsed: l.parsed, source: "slack" });
              }
              setLegs(null);
              setText("");
            }, `Legs added to ${bet ? betName(bet) : "the bet"}`)}>Apply {legs.filter((x) => x.playerId).length} legs</button>
          </div>
        </Section>
      )}
    </div>
  );
}

// ---------------- Data checks ----------------
interface CheckItem {
  betId: string; date: string; kind: string; title?: string; playerId: string; text: string; odds?: number; result?: Result; game?: string;
  check: { status: "mismatch" | "ambiguous" | "unresolved" | "review"; note?: string; espnResult?: Result | null };
}

const CHECK_INFO: Record<CheckItem["check"]["status"], { label: string; color: string; help: string }> = {
  mismatch: { label: "Mismatch", color: "var(--critical)", help: "ESPN disagrees with what was recorded" },
  ambiguous: { label: "Which game?", color: "var(--warn)", help: "ESPN disagrees, but another game in the series would agree. Probably the wrong game, not a wrong result" },
  unresolved: { label: "Can't track", color: "var(--muted)", help: "Couldn't find the game, or the market can't be auto-graded" },
  review: { label: "Review", color: "var(--serious)", help: "Tracker found the game but couldn't grade it (DNP, odd stat…)" },
};

interface MysteryEmoji { name: string; count: number; url?: string; examples: { betId: string; playerId: string; text: string; result?: Result }[] }

function DataChecks() {
  const { data, setData, loading } = useApi<{ items: CheckItem[]; emojis?: MysteryEmoji[]; players: Player[] }>("/admin/checks");
  const [filter, setFilter] = useState<CheckItem["check"]["status"] | "all">("mismatch");
  const { run, el } = useToast();
  if (loading && !data) return <Spinner label="Auditing the books…" />;
  const items = data?.items ?? [];
  const players = Object.fromEntries((data?.players ?? []).map((p) => [p.id, p]));
  const counts = items.reduce<Record<string, number>>((acc, i) => ({ ...acc, [i.check.status]: (acc[i.check.status] ?? 0) + 1 }), {});
  const shown = items.filter((i) => filter === "all" || i.check.status === filter);
  const act = (i: CheckItem, body: { action: string; result?: Result }, msg: string) =>
    run(async () => {
      await post(`/admin/checks/${i.betId}/${i.playerId}`, body);
      setData((d) => (d ? { ...d, items: d.items.filter((x) => !(x.betId === i.betId && x.playerId === i.playerId)) } : d));
    }, msg);
  return (
    <div>
      {el}
      <button className="btn btn-ghost w-full mt-4 text-sm" onClick={() => run(async () => {
        const r = await post<{ added: number; removed: number }>("/admin/reactions/sync", {});
        const fresh = await api<{ items: CheckItem[]; emojis?: MysteryEmoji[]; players: Player[] }>("/admin/checks");
        setData(fresh);
        return r;
      }, "Reactions synced from Slack")}>🔄 Sync Slack reactions</button>
      {!!data?.emojis?.length && (
        <Section title="🤷 Mystery emojis" right={<span className="text-xs text-muted">from Slack reactions</span>}>
          <p className="text-xs text-muted mb-2 px-1">The bot doesn't know what these mean. Your call sticks for every past and future reaction.</p>
          <div className="grid gap-2">
            {data.emojis.map((e) => (
              <div key={e.name} className="card p-3.5">
                <div className="flex items-center gap-2">
                  {e.url ? <img src={e.url} alt="" className="w-7 h-7 object-contain" /> : null}
                  <span className="font-mono font-bold">:{e.name}:</span>
                  <span className="text-xs text-muted ml-auto">used {e.count}×</span>
                </div>
                <div className="text-xs text-ink-2 mt-1.5">on {e.examples.map((x) => `“${x.text}”${x.result ? ` (${x.result})` : ""}`).join(", ")}</div>
                <div className="grid grid-cols-3 gap-1.5 mt-2.5">
                  {([["up", "👍 Positive"], ["down", "👎 Negative"], ["neutral", "😐 Neutral"]] as const).map(([kind, label]) => (
                    <button key={kind} className="btn btn-ghost !min-h-9 text-sm" onClick={() => run(async () => {
                      await post("/admin/emoji", { name: e.name, kind });
                      setData((d) => (d ? { ...d, emojis: d.emojis?.filter((x) => x.name !== e.name) } : d));
                    }, `:${e.name}: is ${kind === "up" ? "positive" : kind === "down" ? "negative" : "neutral"}`)}>{label}</button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
      <p className="text-sm text-ink-2 mt-4">Legs where ESPN and the records disagree, or the tracker needs a human. Changing an old result updates stats only — who was bozo stays as it happened.</p>
      <div className="flex gap-1.5 mt-3 overflow-x-auto no-scrollbar">
        {(["mismatch", "ambiguous", "review", "unresolved", "all"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)} className={`chip !py-1.5 !px-3 whitespace-nowrap ${filter === f ? "bg-accent text-white" : "bg-surface-2 text-ink-2"}`}>
            {f === "all" ? "All" : CHECK_INFO[f].label} {f === "all" ? items.length : counts[f] ?? 0}
          </button>
        ))}
      </div>
      {filter !== "all" && <p className="text-xs text-muted mt-2 px-1">{CHECK_INFO[filter].help}</p>}
      <div className="grid gap-2 mt-3">
        {!shown.length && <div className="card p-6 text-center text-ink-2">Nothing here. The books are clean. 🧼</div>}
        {shown.map((i) => {
          const info = CHECK_INFO[i.check.status];
          return (
            <div key={`${i.betId}-${i.playerId}`} className="card p-3.5" style={{ boxShadow: `inset 4px 0 0 ${info.color}` }}>
              <div className="flex items-center gap-2 text-xs">
                <span className="chip" style={{ boxShadow: `inset 0 0 0 1.5px ${info.color}`, color: info.color }}>{info.label}</span>
                <Link to={`/bets/${i.betId}`} className="text-muted underline">{i.title ?? i.date}</Link>
                <span className="ml-auto text-muted">{players[i.playerId]?.displayName}</span>
              </div>
              <div className="font-semibold mt-2">{i.text} <span className="font-mono text-sm text-ink-2">{fmtOdds(i.odds)}</span></div>
              {i.game && <div className="text-xs text-muted">{i.game}</div>}
              <div className="flex gap-3 text-sm mt-2">
                <span>Recorded: <b>{i.result ?? "—"}</b></span>
                {i.check.espnResult && <span>ESPN: <b>{i.check.espnResult}</b></span>}
              </div>
              {i.check.note && <div className="text-xs text-ink-2 mt-1">{i.check.note}</div>}
              <div className="flex flex-wrap gap-1.5 mt-3">
                <button className="btn btn-ghost !min-h-9 text-sm" onClick={() => act(i, { action: "keep" }, "Kept as recorded")}>Keep {i.result ?? "as is"}</button>
                {i.check.espnResult && i.check.espnResult !== i.result && (
                  <button className="btn btn-primary !min-h-9 text-sm" onClick={() => act(i, { action: "espn" }, `Changed to ${i.check.espnResult}`)}>Use ESPN ({i.check.espnResult})</button>
                )}
                {(["W", "L", "P"] as const).filter((r) => r !== i.result && r !== i.check.espnResult).map((r) => (
                  <button key={r} className="btn btn-ghost !min-h-9 !px-3 text-sm" onClick={() => act(i, { action: "set", result: r }, `Set to ${r}`)}>Set {r}</button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------- People ----------------
function People() {
  const { data, reload, loading } = useApi<{ users: User[]; players: Player[] }>("/admin/users");
  const { run, el } = useToast();
  const [newName, setNewName] = useState("");
  const players = useMemo(() => data?.players ?? [], [data]);
  if (loading && !data) return <Spinner />;
  return (
    <div>
      {el}
      <Section title="Logins">
        <div className="grid gap-2">
          {(data?.users ?? []).map((u) => (
            <div key={u.sub} className="card p-3">
              <div className="font-bold text-sm">{u.name}</div>
              <div className="text-xs text-muted mb-2">{u.email}</div>
              <div className="flex gap-2">
                <select className="input" value={u.role} onChange={(e) => run(async () => { await put(`/admin/users/${u.sub}`, { role: e.target.value, playerId: u.playerId }); await reload(); }, "Role updated")}>
                  <option value="none">Not approved</option>
                  <option value="viewer">Viewer (read-only)</option>
                  <option value="player">Bozo (player)</option>
                  <option value="admin">Admin</option>
                </select>
                <select className="input" value={u.playerId ?? ""} onChange={(e) => run(async () => { await put(`/admin/users/${u.sub}`, { role: e.target.value ? (u.role === "admin" ? "admin" : "player") : u.role, playerId: e.target.value || null }); await reload(); }, "Linked")}>
                  <option value="">No bozo linked</option>
                  {players.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Roster">
        <div className="grid gap-2">
          {players.map((p) => <PlayerRow key={p.id} p={p} run={run} onChange={reload} />)}
          <div className="card p-3 flex gap-2">
            <input className="input" placeholder="New bozo's name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button className="btn btn-primary" disabled={!newName.trim()} onClick={() => run(async () => {
              const id = `p${String(Math.max(0, ...players.map((x) => x.slot)) + 1).padStart(2, "0")}`;
              await put(`/admin/players/${id}`, { name: newName.trim(), active: true, avatar: "🤡" });
              setNewName("");
              await reload();
            }, "Welcome to the circus")}>Add</button>
          </div>
        </div>
      </Section>
    </div>
  );
}

function PlayerRow({ p, run, onChange }: { p: Player; run: ReturnType<typeof useToast>["run"]; onChange: () => Promise<void> }) {
  const [slack, setSlack] = useState((p.slackNames ?? []).join(", "));
  return (
    <div className="card p-3">
      <div className="flex items-center gap-2">
        <Avatar p={p} size={30} dim={!p.active} />
        <div className="flex-1 min-w-0"><div className="font-bold text-sm">{p.name}</div><div className="text-xs text-muted truncate">“{p.pseudonym}”</div></div>
        <button className={`chip !py-1.5 ${p.active ? "bg-surface-2" : "bg-accent text-white"}`} onClick={() => run(async () => { await put(`/admin/players/${p.id}`, { active: !p.active }); await onChange(); })}>
          {p.active ? "Active" : "Retired"}
        </button>
      </div>
      <div className="flex gap-2 mt-2">
        <input className="input text-sm" placeholder="Slack names (comma separated)" value={slack} onChange={(e) => setSlack(e.target.value)} />
        <button className="btn btn-ghost text-sm" onClick={() => run(async () => { await put(`/admin/players/${p.id}`, { slackNames: slack.split(",").map((s) => s.trim().replace(/^@/, "")).filter(Boolean) }); await onChange(); })}>Save</button>
      </div>
    </div>
  );
}

// ---------------- Settings ----------------
function Settings() {
  const { data, setData, loading } = useApi<Record<string, string | number>>("/admin/settings");
  const { run, el } = useToast();
  if (loading || !data) return <Spinner />;
  const set = (k: string, v: string | number) => setData({ ...data, [k]: v });
  return (
    <div>
      {el}
      <Section title="Game">
        <div className="card p-4 grid gap-3">
          <Field label="Default wager $ (carries over each week)"><input className="input" inputMode="decimal" value={data.defaultWager} onChange={(e) => set("defaultWager", Number(e.target.value))} /></Field>
          <Field label="Bozo Oracle questions per person per day"><input className="input" inputMode="numeric" value={data.oracleDailyLimit} onChange={(e) => set("oracleDailyLimit", Number(e.target.value))} /></Field>
        </div>
      </Section>
      <Section title="Slack">
        <div className="card p-4 grid gap-3">
          <Field label="#main channel ID (everyone)"><input className="input font-mono text-xs" placeholder="C0…" value={data.slackChannelMain} onChange={(e) => set("slackChannelMain", e.target.value.trim())} /></Field>
          <Field label="#ops channel ID (tracker runs, errors, new logins)"><input className="input font-mono text-xs" placeholder="C0…" value={data.slackChannelOps} onChange={(e) => set("slackChannelOps", e.target.value.trim())} /></Field>
          <div className="text-xs text-muted">Channel ID is at the bottom of the channel's About tab. Invite the bot to both. Save first, then test.</div>
          <button className="btn btn-ghost" onClick={() => run(async () => {
            const r = await post<{ main: boolean; ops: boolean }>("/admin/slack-test", {});
            if (!r.main || !r.ops) throw new Error(`Couldn't post to ${[!r.main && "main", !r.ops && "ops"].filter(Boolean).join(" + ")}. Is the bot in the channel?`);
          }, "Test posts sent 👋")}>Send test posts</button>
        </div>
      </Section>
      <Section title="Live tracker">
        <div className="card p-4 grid gap-3">
          <Field label="Default minutes between checks"><input className="input" inputMode="numeric" value={data.trackerDefaultMinutes} onChange={(e) => set("trackerDefaultMinutes", Number(e.target.value))} /></Field>
          <Field label="Max tracker runs per day (cost cap)"><input className="input" inputMode="numeric" value={data.trackerMaxRunsPerDay} onChange={(e) => set("trackerMaxRunsPerDay", Number(e.target.value))} /></Field>
        </div>
      </Section>
      <button className="btn btn-primary w-full mt-4" onClick={() => run(() => api("/admin/settings", { method: "PUT", json: data }), "Settings saved")}>Save settings</button>
      <Section title="Pseudonyms">
        <button className="btn btn-ghost w-full" onClick={() => run(() => post("/admin/pseudonyms/reroll"), "New fake names generated 🎭")}>🎲 Reroll everyone's fake name</button>
      </Section>
      <Section title="Scouting reports">
        <p className="text-xs text-muted mb-2 px-1">Rebuilt automatically after every settled bet. Takes about a minute; #ops gets the headlines.</p>
        <button className="btn btn-ghost w-full" onClick={() => run(() => post("/admin/scouting"), "Scouts dispatched 🧠")}>🧠 Refresh scouting reports now</button>
      </Section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-muted font-semibold">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
