import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, del, patch, post, put, useApi } from "../lib/api";
import { fmtOdds } from "../lib/format";
import { useSession } from "../lib/session";
import type { Bet, Current, Leg, ParsedLeg, Player, Result, User } from "../lib/types";
import { Avatar, ErrorBox, Section, Spinner } from "../components/ui";

const TABS = ["Bet", "Slack", "People", "Settings"] as const;

export default function Admin() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Bet");
  const { atLeast } = useSession();
  if (!atLeast("admin")) return <ErrorBox error={{ message: "Admins only. Nice try, bozo." }} />;
  return (
    <div>
      <h1 className="font-display text-3xl">Admin</h1>
      <div className="grid grid-cols-4 gap-1 mt-3 card p-1">
        {TABS.map((t) => (
          <button key={t} className={`btn !min-h-9 !px-2 text-sm ${tab === t ? "btn-primary" : ""}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === "Bet" && <BetControl />}
      {tab === "Slack" && <SlackImport />}
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
  const bet = useApi<Bet>(betId ? `/bets/${betId}` : null, [betId]);
  const { run, el } = useToast();

  useEffect(() => { if (cur.data) setPlayers(cur.data.players); }, [cur.data, setPlayers]);
  useEffect(() => {
    if (!id && cur.data && !betId) setBetId(cur.data.bet?.id ?? null);
  }, [cur.data, id, betId]);

  const reloadAll = async () => { await cur.reload(); await bet.reload(); };

  if (cur.loading && !cur.data) return <Spinner />;
  const choices = [cur.data?.bet, ...(cur.data?.sideBets ?? [])].filter(Boolean) as Bet[];

  return (
    <div>
      {el}
      {choices.length > 1 && (
        <div className="flex gap-1.5 mt-4 overflow-x-auto">
          {choices.map((b) => <button key={b.id} onClick={() => setBetId(b.id)} className={`chip !py-1.5 !px-3 ${betId === b.id ? "bg-accent text-white" : "bg-surface-2"}`}>{b.title ?? `Bozo ${b.date}`}</button>)}
        </div>
      )}
      {!betId || !bet.data ? (
        <CreateBet onCreated={(b) => { setBetId(b.id); cur.reload(); }} hasActive={!!cur.data?.bet} defaultWager={cur.data?.settings.defaultWager ?? 10} />
      ) : (
        <BetEditor bet={bet.data} players={players} run={run} onChange={reloadAll} onNew={() => setBetId(null)} />
      )}
    </div>
  );
}

function CreateBet({ onCreated, hasActive, defaultWager }: { onCreated: (b: Bet) => void; hasActive: boolean; defaultWager: number }) {
  const { players } = useSession();
  const [f, setF] = useState({ kind: hasActive ? "side" : "bozo", date: new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" }), wager: String(defaultWager), bettingFloor: "", title: "", bozoId: "" });
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
        <button className="btn btn-primary" onClick={create}>Open the books</button>
        {err && <div className="text-sm" style={{ color: "var(--serious)" }}>{err}</div>}
      </div>
    </Section>
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
      <Section title={bet.title ?? `Bozo bet · ${bet.date}`} right={<span className="chip bg-surface-2">{bet.status}</span>}>
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
            {bet.kind === "bozo" && (
              <div className="border-t border-[var(--border)] pt-3">
                <div className="text-sm font-bold mb-2">🔁 Reload — someone's early leg lost and they're taking the L</div>
                <div className="flex flex-wrap gap-2">
                  {bet.legs.filter((l) => !l.carriedOver).map((l) => (
                    <button key={l.playerId} className="btn btn-ghost !min-h-9 text-sm" onClick={() => confirm(`${players[l.playerId]?.displayName} self-proclaims bozo and reloads?`) &&
                      run(async () => { await post(`/admin/bets/${bet.id}/reload`, { playerId: l.playerId }); onNew(); await onChange(); }, "Reloaded. Legs carried over.")}>
                      {players[l.playerId]?.displayName}
                    </button>
                  ))}
                </div>
              </div>
            )}
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

interface SlipResult { totalOdds?: number | null; wager?: number | null; toWin?: number | null; legs: { playerId?: string | null; ticketText: string; odds?: number | null }[]; confidence: number }

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
        slipKey: key, legOdds, totalOdds: totals.totalOdds ? parseInt(totals.totalOdds, 10) : undefined,
        wager: totals.wager ? Number(totals.wager) : undefined, toWin: totals.toWin ? Number(totals.toWin) : undefined,
      });
      await onChange();
    }, "Locked 🔒 Legs are frozen.");
  }

  return (
    <Section title={bet.status === "LOCKED" ? "Slip (locked)" : "Upload the slip → lock"}>
      <div className="card p-4 grid gap-3">
        <label className="btn btn-ghost cursor-pointer">
          📸 {busy ? "Reading…" : key ? "Replace photo" : "Upload slip photo"}
          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
        {preview && <img src={preview} alt="Slip preview" className="rounded-xl max-h-72 object-contain bg-surface-2" />}
        {res && (
          <div className="text-sm grid gap-1.5">
            <div className="text-xs text-muted">Confidence {(res.confidence * 100).toFixed(0)}%</div>
            {res.legs.map((l, i) => (
              <div key={i} className="flex justify-between gap-2"><span className="truncate">{l.playerId ? players[l.playerId]?.displayName : "❓ unmatched"}: {l.ticketText}</span><span className="font-mono">{fmtOdds(l.odds)}</span></div>
            ))}
          </div>
        )}
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
  const bet = cur.data?.bet;

  return (
    <div>
      {el}
      <Section title="Paste from Slack">
        <textarea className="input min-h-48 font-mono text-xs" placeholder="Paste the whole thread. Trash talk and all." value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn btn-primary w-full mt-2" disabled={!text.trim() || busy} onClick={async () => {
          setBusy(true);
          await run(async () => setLegs((await post<{ legs: SlackLeg[] }>("/admin/slack-extract", { conversation: text })).legs), "Extracted — review below");
          setBusy(false);
        }}>{busy ? "Reading the group chat…" : "Extract bets 🤖"}</button>
      </Section>
      {legs && (
        <Section title="Review" right={<span className="text-xs text-muted">{bet ? `→ ${bet.date}` : "no active bet!"}</span>}>
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
            }, "Legs added to this week's bet")}>Apply {legs.filter((x) => x.playerId).length} legs</button>
          </div>
        </Section>
      )}
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
          <Field label="Main channel webhook"><input className="input font-mono text-xs" placeholder="https://hooks.slack.com/services/…" value={data.slackWebhookMain} onChange={(e) => set("slackWebhookMain", e.target.value)} /></Field>
          <Field label="Logs channel webhook"><input className="input font-mono text-xs" placeholder="https://hooks.slack.com/services/…" value={data.slackWebhookLogs} onChange={(e) => set("slackWebhookLogs", e.target.value)} /></Field>
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
