export const fmtOdds = (o?: number | null) => (o == null ? "—" : o > 0 ? `+${o}` : `${o}`);

export const fmtMoney = (n?: number | null) =>
  n == null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n % 1 ? 2 : 0 });

export const fmtPct = (n?: number | null, digits = 0) => (n == null ? "—" : `${(n * 100).toFixed(digits)}%`);

export const fmtSigned = (n?: number | null, digits = 1) => (n == null ? "—" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}`);

export function fmtDate(iso: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", opts);
}

export const record = (r: { w: number; l: number; p?: number }) => `${r.w}-${r.l}${r.p ? `-${r.p}` : ""}`;

export function timeAgo(iso?: string) {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
