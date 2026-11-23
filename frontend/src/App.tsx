import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { BrowserRouter, Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { handleCallback, login } from "./lib/auth";
import { useSession, useTheme } from "./lib/session";
import { Avatar, Spinner } from "./components/ui";
import Home from "./pages/Home";
import Vote from "./pages/Vote";
import History, { BetDetail } from "./pages/History";
import Me from "./pages/Me";

// Charts + admin are members-only; keep them out of the public first load
const Stats = lazy(() => import("./pages/Stats"));
const PlayerPage = lazy(() => import("./pages/PlayerPage"));
const Admin = lazy(() => import("./pages/Admin"));

function Gate({ need, children }: { need: "viewer" | "player" | "admin"; children: ReactNode }) {
  const { ready, atLeast, role } = useSession();
  if (!ready) return <Spinner />;
  if (atLeast(need)) return <Suspense fallback={<Spinner />}>{children}</Suspense>;
  return (
    <div className="card p-6 text-center mt-4">
      <div className="text-5xl mb-2">🔒</div>
      <div className="font-display text-xl">Members only</div>
      <p className="text-sm text-ink-2 mt-1 mb-4">
        {role === "public" ? "History and stats are for the boys (and approved spectators)." : "You're in, but the admin hasn't approved you yet. Go bug him."}
      </p>
      {role === "public" && <button className="btn btn-primary w-full" onClick={() => login()}>Log in with Google</button>}
    </div>
  );
}

function Callback() {
  const nav = useNavigate();
  const { refresh } = useSession();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    handleCallback().then(async (to) => { await refresh(); nav(to, { replace: true }); }).catch((e) => setErr(e.message));
  }, [nav, refresh]);
  return err ? <div className="card p-6 mt-4 text-center">😬 {err} <Link className="text-accent underline block mt-2" to="/">Home</Link></div> : <Spinner label="Checking your ID at the door…" />;
}

const NAV = [
  { to: "/", label: "Home", icon: "🏠", end: true },
  { to: "/history", label: "History", icon: "📜" },
  { to: "/stats", label: "Stats", icon: "📊" },
  { to: "/me", label: "Me", icon: "🤡" },
];

function Shell() {
  useTheme();
  const { me, role } = useSession();
  return (
    <div className="mx-auto max-w-2xl px-4 pt-[calc(env(safe-area-inset-top)+12px)] pb-safe">
      <header className="flex items-center justify-between mb-4">
        <Link to="/" className="font-display text-2xl tracking-wide">BOZO<span className="text-accent">BET</span></Link>
        {role === "public" ? (
          <button className="btn btn-ghost !min-h-9 text-sm" onClick={() => login()}>Log in</button>
        ) : (
          <Link to="/me" aria-label="Your profile"><Avatar p={me} size={34} /></Link>
        )}
      </header>
      <main className="overflow-x-clip">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/vote" element={<Gate need="viewer"><Vote /></Gate>} />
          <Route path="/history" element={<Gate need="viewer"><History /></Gate>} />
          <Route path="/bets/:id" element={<Gate need="viewer"><BetDetail /></Gate>} />
          <Route path="/stats" element={<Gate need="viewer"><Stats /></Gate>} />
          <Route path="/stats/:id" element={<Gate need="viewer"><PlayerPage /></Gate>} />
          <Route path="/me" element={<Me />} />
          <Route path="/admin" element={<Gate need="admin"><Admin /></Gate>} />
          <Route path="/auth/callback" element={<Callback />} />
          <Route path="*" element={<div className="card p-6 text-center">🤡 Wrong turn, bozo. <Link to="/" className="text-accent underline">Home</Link></div>} />
        </Routes>
      </main>
      <nav className="fixed bottom-0 inset-x-0 z-40 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--bg)_88%,transparent)] backdrop-blur-md pb-[env(safe-area-inset-bottom)]" aria-label="Main">
        <div className="mx-auto max-w-2xl grid grid-cols-4">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}
              className={({ isActive }) => `flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-semibold ${isActive ? "text-ink" : "text-muted"}`}>
              {({ isActive }) => (<><span className={`text-xl ${isActive ? "" : "grayscale opacity-70"}`} aria-hidden>{n.icon}</span>{n.label}</>)}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  );
}
