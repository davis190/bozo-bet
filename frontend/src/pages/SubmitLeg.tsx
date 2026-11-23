import { useEffect, useState } from "react";
import { ApiError, post, put } from "../lib/api";
import { fmtPct } from "../lib/format";
import type { Bet, Leg, ParsedLeg } from "../lib/types";
import { Sheet } from "../components/ui";
import { track } from "../lib/analytics";
import { useSession } from "../lib/session";

interface ParseResp { leg: ParsedLeg; history: { label: string; w: number; l: number; pct: number }[]; floorWarning?: string | null }

const NUDGES = ["Proceed, bozo?", "You sure about this?", "The casino thanks you in advance.", "Bold. Stupid, but bold."];

export function SubmitLeg({ open, onClose, bet, existing, onSaved }: { open: boolean; onClose: () => void; bet: Bet; existing?: Leg; onSaved: () => void }) {
  const { me } = useSession();
  const [raw, setRaw] = useState("");
  const [parsed, setParsed] = useState<ParseResp | null>(null);
  const [text, setText] = useState("");
  const [odds, setOdds] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRaw(existing ? `${existing.text}${existing.odds != null ? ` ${existing.odds > 0 ? "+" : ""}${existing.odds}` : ""}` : "");
    setParsed(null);
    setErr(null);
    setManual(false);
  }, [open, existing]);

  async function parse() {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<ParseResp>("/legs/parse", { text: raw });
      setParsed(r);
      setText(r.leg.text);
      setOdds(r.leg.odds != null ? String(r.leg.odds) : "");
    } catch (e) {
      // LLM down? Let them type it straight in
      setManual(true);
      setText(raw);
      setOdds((raw.match(/([+-]\d{3,4})\b/) || [])[1] ?? "");
      setErr((e as ApiError).status === 503 ? "The robot is napping. Enter it manually." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const o = odds.trim() ? parseInt(odds, 10) : undefined;
      await put(`/bets/${bet.id}/my-leg`, { text: text.trim(), odds: Number.isFinite(o) ? o : undefined, sgp: parsed?.leg.sgp, parsed: parsed?.leg.parsed });
      track("leg_submit", { changed: !!existing, method: manual ? "manual" : "parsed", sport: parsed?.leg.parsed?.sport, market: parsed?.leg.parsed?.market });
      onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const confirming = parsed || manual;
  return (
    <Sheet open={open} onClose={onClose} title={existing ? "Change your leg" : "Your leg"}>
      {!confirming ? (
        <>
          {me?.scouting && (me.scouting.ride || me.scouting.fade) && (
            <div className="card p-3 mb-3 text-sm bg-surface-2">
              <div className="font-bold">🧠 Your scout says</div>
              {me.scouting.ride && <div className="mt-0.5"><span style={{ color: "var(--good)" }}>{me.scouting.nothingTrending ? "Least-bad:" : "Ride:"}</span> {me.scouting.ride.label} <span className="text-muted font-mono text-xs">({me.scouting.ride.recent.w}-{me.scouting.ride.recent.l} lately)</span></div>}
              {me.scouting.fade && <div><span style={{ color: "var(--critical)" }}>Fade:</span> {me.scouting.fade.label} <span className="text-muted font-mono text-xs">({me.scouting.fade.recent.w}-{me.scouting.fade.recent.l} lately)</span></div>}
            </div>
          )}
          <label className="text-sm text-ink-2" htmlFor="leg-raw">Type it like you'd text it.</label>
          <textarea id="leg-raw" className="input mt-2 min-h-28" placeholder="josh allen over 1.5 td passes -175" value={raw} onChange={(e) => setRaw(e.target.value)} autoFocus />
          <button className="btn btn-primary w-full mt-3" disabled={!raw.trim() || busy} onClick={parse}>{busy ? "Reading your chicken scratch…" : "Next"}</button>
        </>
      ) : (
        <>
          <div className="grid gap-3">
            <div>
              <label className="text-xs text-muted font-semibold uppercase" htmlFor="leg-text">Leg</label>
              <input id="leg-text" className="input mt-1" value={text} onChange={(e) => setText(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted font-semibold uppercase" htmlFor="leg-odds">Odds (optional — the slip fills these in)</label>
              <input id="leg-odds" className="input mt-1 font-mono" inputMode="numeric" placeholder="-110" value={odds} onChange={(e) => setOdds(e.target.value)} />
            </div>
            {parsed?.leg.parsed && (
              <div className="flex flex-wrap gap-1.5">
                {[parsed.leg.parsed.sport, parsed.leg.parsed.market, parsed.leg.parsed.subject, parsed.leg.parsed.stat].filter(Boolean).map((t) => (
                  <span key={t} className="chip bg-surface-2 text-ink-2">{t}</span>
                ))}
              </div>
            )}
            {!!parsed?.history.length && (
              <div className="card bg-surface-2 p-3 text-sm">
                <div className="font-bold mb-1">📜 Your history says…</div>
                {parsed.history.map((h) => (
                  <div key={h.label} className="flex justify-between"><span>{h.label}</span><span className="tabular font-mono">{h.w}-{h.l} ({fmtPct(h.pct)})</span></div>
                ))}
                <div className="text-ink-2 mt-1 italic">{NUDGES[Math.floor(Math.random() * NUDGES.length)]}</div>
              </div>
            )}
            {parsed?.floorWarning && <div className="card p-3 text-sm" style={{ borderColor: "var(--warn)" }}>⚠️ {parsed.floorWarning}</div>}
          </div>
          <div className="flex gap-2 mt-4">
            <button className="btn btn-ghost flex-1" onClick={() => { setParsed(null); setManual(false); }}>Back</button>
            <button className="btn btn-primary flex-[2]" disabled={!text.trim() || busy} onClick={submit}>{busy ? "Locking it in…" : "Lock it in 🔒"}</button>
          </div>
        </>
      )}
      {err && <div className="text-sm mt-3" style={{ color: "var(--serious)" }}>{err}</div>}
    </Sheet>
  );
}
