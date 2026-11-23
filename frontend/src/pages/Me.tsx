import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { put } from "../lib/api";
import { login, logout } from "../lib/auth";
import { useSession, useTheme } from "../lib/session";
import type { Player } from "../lib/types";
import { Avatar, Section } from "../components/ui";

const AVATARS = ["🎯", "🦬", "🐆", "🧀", "🍺", "🎲", "🤠", "🦍", "🐐", "🦈", "🔥", "💀", "🃏", "🦅", "🐻", "🧠"];
const ROAST = ["mild", "spicy", "no mercy"] as const;

export default function Me() {
  const { user, me, role, refresh } = useSession();
  const [theme, setTheme] = useTheme();
  const [form, setForm] = useState<Omit<Partial<Player>, "bannedWords"> & { bannedWords?: string }>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (me) setForm({ avatar: me.avatar, roastLevel: me.roastLevel ?? "spicy", taunt: me.taunt ?? "", favoriteTeams: me.favoriteTeams ?? [], bannedWords: (me.bannedWords ?? []).join(", ") });
  }, [me]);

  if (role === "public")
    return (
      <div className="card p-6 text-center">
        <div className="text-5xl mb-3">🤡</div>
        <h1 className="font-display text-2xl">Who even are you?</h1>
        <p className="text-ink-2 text-sm mt-1 mb-4">Log in to see real names, history and stats.</p>
        <button className="btn btn-primary w-full" onClick={() => login("/me")}>Log in with Google</button>
      </div>
    );

  async function save() {
    const teams = (form.favoriteTeams ?? []).filter((t) => t.team.trim());
    await put("/me/profile", { ...form, favoriteTeams: teams, bannedWords: (form.bannedWords ?? "").split(",").map((s) => s.trim()).filter(Boolean) });
    await refresh();
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  }

  return (
    <div>
      {me && <Link to={`/stats/${me.id}`} className="text-sm text-muted block mb-3">← Your stats</Link>}
      <div className="card p-5 flex items-center gap-4">
        <Avatar p={me ? { ...me, avatar: form.avatar } : null} size={64} />
        <div className="min-w-0">
          <div className="font-display text-xl break-words">{me?.name ?? user?.name}</div>
          <div className="text-sm text-ink-2 truncate">{user?.email}</div>
          <div className="chip bg-surface-2 mt-1 capitalize">{role === "none" ? "awaiting approval" : role}</div>
        </div>
      </div>

      {me && (
        <>
          {me.pseudonym && <div className="card p-4 mt-3 text-sm">The public knows you as <b>“{me.pseudonym}”</b> this week.</div>}
          <Section title="Avatar">
            <div className="card p-3 grid grid-cols-8 gap-1.5">
              {AVATARS.map((a) => (
                <button key={a} onClick={() => setForm({ ...form, avatar: a })} aria-pressed={form.avatar === a}
                  className="aspect-square rounded-xl text-2xl grid place-items-center" style={form.avatar === a ? { background: "var(--surface-2)", boxShadow: "inset 0 0 0 2px var(--accent)" } : undefined}>{a}</button>
              ))}
            </div>
            <p className="text-xs text-muted mt-1 px-1">Your color is permanent — it's how the group spots you behind the fake names.</p>
          </Section>
          <Section title="Roast level">
            <div className="grid grid-cols-3 gap-2">
              {ROAST.map((r) => (
                <button key={r} className={`btn !min-h-10 capitalize ${form.roastLevel === r ? "btn-primary" : "btn-ghost"}`} onClick={() => setForm({ ...form, roastLevel: r })}>
                  {r === "mild" ? "🥛" : r === "spicy" ? "🌶️" : "☠️"} {r}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted mt-1 px-1">How hard the AI recaps, scouting reports and fake names go on you.</p>
          </Section>
          <Section title="Favorite teams">
            <div className="grid gap-2">
              {(form.favoriteTeams ?? []).map((t, i) => (
                <div key={i} className="flex gap-2">
                  <select className="input !w-28" value={t.league} onChange={(e) => { const ft = [...(form.favoriteTeams ?? [])]; ft[i] = { ...t, league: e.target.value }; setForm({ ...form, favoriteTeams: ft }); }}>
                    {["NFL", "NCAAF", "NBA", "NCAAB", "MLB", "NHL"].map((l) => <option key={l}>{l}</option>)}
                  </select>
                  <input className="input" value={t.team} placeholder="GB" onChange={(e) => { const ft = [...(form.favoriteTeams ?? [])]; ft[i] = { ...t, team: e.target.value.toUpperCase() }; setForm({ ...form, favoriteTeams: ft }); }} />
                  <button className="btn btn-ghost" aria-label="Remove" onClick={() => setForm({ ...form, favoriteTeams: (form.favoriteTeams ?? []).filter((_, j) => j !== i) })}>✕</button>
                </div>
              ))}
              <button className="btn btn-ghost" onClick={() => setForm({ ...form, favoriteTeams: [...(form.favoriteTeams ?? []), { league: "NFL", team: "" }] })}>+ Add team</button>
            </div>
            <p className="text-xs text-muted mt-1 px-1">Powers your Homer Index: how you do betting on your own teams.</p>
          </Section>
          <Section title="Victory taunt">
            <input className="input" maxLength={80} placeholder="Shown when your leg cashes" value={form.taunt ?? ""} onChange={(e) => setForm({ ...form, taunt: e.target.value })} />
          </Section>
          <Section title="Pseudonym banned words">
            <p className="text-xs text-muted mb-2">Words your weekly fake name will never use. Applies from the next reroll.</p>
            <input className="input" placeholder="comma, separated" value={form.bannedWords ?? ""} onChange={(e) => setForm({ ...form, bannedWords: e.target.value })} />
          </Section>
          <button className="btn btn-primary w-full mt-5" onClick={save}>{saved ? "Saved ✓" : "Save"}</button>
        </>
      )}

      <Section title="App">
        <div className="card divide-y divide-[var(--border)]">
          <button className="w-full p-4 flex justify-between" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            <span>Theme</span><span className="text-ink-2">{theme === "dark" ? "🌙 Dark" : "☀️ Light"}</span>
          </button>
          {role === "admin" && <Link to="/admin" className="block p-4">🛠️ Admin</Link>}
          <button className="w-full p-4 text-left" style={{ color: "var(--serious)" }} onClick={logout}>Log out</button>
        </div>
      </Section>
    </div>
  );
}
