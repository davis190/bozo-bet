import { fmtDate } from "../lib/format";
import type { ScoutPick, Scouting } from "../lib/types";

const CONFIDENCE: Record<Scouting["confidence"], { label: string; fill: number }> = {
  "lock it in": { label: "Lock it in 🔒", fill: 4 },
  lean: { label: "Lean 🤏", fill: 3 },
  "coin flip": { label: "Coin flip 🪙", fill: 2 },
  pray: { label: "Pray 🙏", fill: 1 },
};

const rec = (r: ScoutPick["recent"]) => `${r.w}-${r.l}${r.p ? `-${r.p}` : ""}`;
const units = (u: number) => `${u >= 0 ? "+" : ""}${u.toFixed(1)}u`;

/** The scout's verdict on a player: headline, roast, one split to ride and one to fade (records are computed, not written). */
export function ScoutingCard({ s, mine }: { s: Scouting; mine: boolean }) {
  const conf = CONFIDENCE[s.confidence] ?? CONFIDENCE.lean;
  return (
    <section className="card p-4 mt-4" style={{ background: "radial-gradient(120% 90% at 100% 0%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 60%), var(--surface)" }}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted font-bold">🧠 Scouting report</div>
        <div className="flex items-center gap-1.5 text-[11px] text-ink-2" title="How much the scout trusts this">
          <span className="flex gap-0.5" aria-hidden>{[1, 2, 3, 4].map((i) => <span key={i} className="w-1.5 h-3 rounded-sm" style={{ background: i <= conf.fill ? "var(--accent)" : "var(--surface-2)" }} />)}</span>
          {conf.label}
        </div>
      </div>
      <h2 className="font-display text-xl leading-tight mt-2">{s.headline}</h2>
      <p className="text-sm text-ink-2 mt-1.5">{s.take}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
        {s.ride && <Pick kind="ride" p={s.ride} least={s.nothingTrending} />}
        {s.fade && <Pick kind="fade" p={s.fade} />}
      </div>
      <div className="text-[11px] text-muted mt-3">
        Last {s.window.n} legs: {rec(s.window)} · {units(s.window.units)} · updated {fmtDate(s.generatedAt.slice(0, 10), { month: "short", day: "numeric" })}
        {mine ? " · not financial advice, obviously" : ""}
      </div>
    </section>
  );
}

function Pick({ kind, p, least }: { kind: "ride" | "fade"; p: ScoutPick; least?: boolean }) {
  const ride = kind === "ride";
  const color = ride ? "var(--good)" : "var(--critical)";
  return (
    <div className="rounded-xl p-3 bg-surface-2" style={{ boxShadow: `inset 3px 0 0 ${color}` }}>
      <div className="text-[11px] uppercase tracking-wider font-bold" style={{ color }}>
        {ride ? (least ? "🫠 Least-bad option" : "✅ Ride this") : "🚫 Fade this"}
      </div>
      <div className="font-bold mt-0.5">{p.label}</div>
      <div className="text-xs font-mono tabular text-ink-2 mt-0.5">
        last 20: {rec(p.recent)} · {units(p.recent.units)} <span className="text-muted">| all-time {rec(p.allTime)} · {units(p.allTime.units)}</span>
      </div>
      <div className="text-sm mt-1.5">{p.why}</div>
    </div>
  );
}
