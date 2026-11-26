import { useEffect, useState, type ReactNode } from "react";
import { fmtOdds } from "../lib/format";
import { track } from "../lib/analytics";
import { GLOSSARY, type TermKey } from "../lib/glossary";
import type { Leg, LiveStatus, Player, Result } from "../lib/types";

export const slotColor = (p?: Player | null) => (p ? `var(--p${((p.slot - 1) % 7) + 1})` : "var(--muted)");

export function Avatar({ p, size = 40, crown = false, dim = false }: { p?: Player | null; size?: number; crown?: boolean; dim?: boolean }) {
  return (
    <div className="relative shrink-0" style={{ width: size, height: size, opacity: dim ? 0.45 : 1 }}>
      <div
        className="grid place-items-center rounded-full"
        style={{ width: size, height: size, background: `color-mix(in srgb, ${slotColor(p)} 22%, var(--surface-2))`, boxShadow: `inset 0 0 0 2px ${slotColor(p)}`, fontSize: size * 0.5 }}
        aria-hidden
      >
        {p?.avatar || "🤡"}
      </div>
      {crown && (
        <span className="wobble absolute -top-3 left-1/2 -translate-x-1/2" style={{ fontSize: size * 0.45 }} title="Current Bozo" aria-label="Current bozo">
          🤡
        </span>
      )}
    </div>
  );
}

export function Name({ p, className = "" }: { p?: Player | null; className?: string }) {
  return (
    <span className={`font-bold ${className}`}>
      <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: slotColor(p) }} aria-hidden />
      {p?.displayName ?? "Unknown Bozo"}
    </span>
  );
}

const STATUS: Record<LiveStatus | Result, { label: string; icon: string; color: string; solid: boolean }> = {
  W: { label: "Won", icon: "✓", color: "var(--good)", solid: true },
  WON: { label: "Won", icon: "✓", color: "var(--good)", solid: true },
  ON_PACE: { label: "On pace", icon: "↗", color: "var(--good)", solid: false },
  IN_DOUBT: { label: "Sweating", icon: "~", color: "var(--warn)", solid: false },
  OFF_PACE: { label: "Off pace", icon: "↘", color: "var(--critical)", solid: false },
  L: { label: "Lost", icon: "✕", color: "var(--critical)", solid: true },
  LOST: { label: "Lost", icon: "✕", color: "var(--critical)", solid: true },
  P: { label: "Push", icon: "=", color: "var(--muted)", solid: true },
  PUSH: { label: "Push", icon: "=", color: "var(--muted)", solid: true },
  PENDING: { label: "Not started", icon: "·", color: "var(--muted)", solid: false },
  UNKNOWN: { label: "Can't track", icon: "?", color: "var(--muted)", solid: false },
  EARLY: { label: "Early", icon: "•", color: "var(--muted)", solid: false },
};

/** On pace (outlined) vs won (solid) — color never carries meaning alone. */
export function StatusChip({ leg }: { leg: Leg }) {
  const key = (leg.result ?? leg.live?.status ?? "PENDING") as LiveStatus | Result;
  const s = STATUS[key] ?? STATUS.PENDING;
  return (
    <span
      className="chip whitespace-nowrap"
      style={s.solid ? { background: s.color, color: key === "IN_DOUBT" ? "#0b0b0b" : "#fff" } : { boxShadow: `inset 0 0 0 1.5px ${s.color}`, color: s.color }}
    >
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}

export const legAccent = (leg: Leg) => {
  const key = (leg.result ?? leg.live?.status ?? "PENDING") as LiveStatus | Result;
  return (STATUS[key] ?? STATUS.PENDING).color;
};

export function Odds({ o, className = "" }: { o?: number | null; className?: string }) {
  return <span className={`font-mono tabular text-ink-2 ${className}`}>{fmtOdds(o)}</span>;
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-modal aria-label={title}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg max-h-[92dvh] overflow-y-auto card rounded-b-none sm:rounded-b-[18px] p-5 pb-[calc(env(safe-area-inset-bottom)+20px)] pop">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-xl">{title}</h2>
          <button className="btn btn-ghost !min-h-9 !px-3" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Empty({ emoji = "🤷", title, children }: { emoji?: string; title: string; children?: ReactNode }) {
  return (
    <div className="card p-8 text-center">
      <div className="text-5xl mb-3">{emoji}</div>
      <div className="font-display text-lg mb-1">{title}</div>
      <div className="text-ink-2 text-sm">{children}</div>
    </div>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="py-16 text-center text-muted" role="status">
      <div className="text-4xl wobble inline-block">🤡</div>
      <div className="mt-2 text-sm">{label}</div>
    </div>
  );
}

export function ErrorBox({ error }: { error: { message: string } | null }) {
  if (!error) return null;
  return <div className="card p-4 border-critical/50 text-sm" style={{ borderColor: "var(--critical)" }}>😬 {error.message}</div>;
}

export function Section({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="flex items-end justify-between mb-2 px-1">
        <h2 className="font-display text-lg tracking-wide">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, info }: { label: string; value: ReactNode; sub?: ReactNode; info?: TermKey }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card p-3.5 relative">
      <div className="text-[11px] uppercase tracking-wider text-muted font-semibold pr-6">{label}</div>
      {info && <InfoButton open={open} onClick={() => { if (!open) track("stat_explained", { term: info }); setOpen(!open); }} label={label} />}
      {open && info ? (
        <div className="text-xs text-ink-2 mt-1 leading-snug">{GLOSSARY[info].def}</div>
      ) : (
        <>
          <div className="font-display text-2xl tabular mt-0.5">{value}</div>
          {sub && <div className="text-xs text-ink-2 mt-0.5">{sub}</div>}
        </>
      )}
    </div>
  );
}

/** Tap target for "what does this mean?" — tooltips don't exist on phones. */
export function InfoButton({ open, onClick, label }: { open: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick} aria-expanded={open} aria-label={open ? `Hide what ${label} means` : `What does ${label} mean?`}
      className="absolute top-1.5 right-1.5 w-8 h-8 grid place-items-center rounded-full text-muted hover:text-ink text-sm">
      {open ? "✕" : "ⓘ"}
    </button>
  );
}

/** Collapsible list of definitions. */
export function Glossary({ keys, title = "What do these mean?" }: { keys: TermKey[]; title?: string }) {
  return (
    <details className="card mt-2 group" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) track("glossary_open", { section: title }); }}>
      <summary className="p-3 text-sm font-semibold cursor-pointer list-none flex justify-between items-center">
        {title}<span className="text-muted group-open:rotate-180 transition">▾</span>
      </summary>
      <dl className="px-3 pb-3 grid gap-2.5 text-sm">
        {keys.map((k) => (
          <div key={k}><dt className="font-bold">{GLOSSARY[k].term}</dt><dd className="text-ink-2 text-xs leading-snug">{GLOSSARY[k].def}</dd></div>
        ))}
      </dl>
    </details>
  );
}
