import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import { isLoggedIn } from "./auth";
import type { Player, Role, User } from "./types";

interface Session {
  ready: boolean;
  user: User | null;
  role: Role;
  me: Player | null;
  players: Record<string, Player>;
  setPlayers: (ps: Player[]) => void;
  refresh: () => Promise<void>;
  atLeast: (r: Role) => boolean;
}

const RANK: Record<Role, number> = { public: 0, none: 1, viewer: 2, player: 3, admin: 4 };
const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [me, setMe] = useState<Player | null>(null);
  const [players, setPlayersMap] = useState<Record<string, Player>>({});

  const setPlayers = useCallback((ps: Player[]) => setPlayersMap(Object.fromEntries(ps.map((p) => [p.id, p]))), []);

  const refresh = useCallback(async () => {
    if (isLoggedIn()) {
      try {
        const r = await api<{ user: User; player: Player | null }>("/me");
        setUser(r.user);
        setMe(r.player);
      } catch {
        setUser(null);
      }
    }
    setReady(true);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const role: Role = user?.role ?? "public";
  const value = useMemo<Session>(
    () => ({ ready, user, role, me, players, setPlayers, refresh, atLeast: (r) => RANK[role] >= RANK[r] }),
    [ready, user, role, me, players, setPlayers, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error("SessionProvider missing");
  return s;
}

export function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return (localStorage.getItem("bozo.theme") as "dark" | "light") || "dark";
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0d0d14" : "#f6f5f1");
    try {
      localStorage.setItem("bozo.theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, setTheme] as const;
}
