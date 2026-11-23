// Cognito hosted UI + Google, OAuth code flow with PKCE. No SDK needed.
interface Config { region: string; userPoolId: string; clientId: string; authDomain: string }
interface Tokens { idToken: string; refreshToken?: string; expiresAt: number }

const KEY = "bozo.tokens";
let config: Config | null = null;

export async function loadConfig(): Promise<Config | null> {
  if (config) return config;
  try {
    const r = await fetch("/config.json", { cache: "no-store" });
    config = r.ok ? await r.json() : null;
  } catch {
    config = null;
  }
  return config;
}

const redirectUri = () => `${location.origin}/auth/callback`;

function b64url(bytes: ArrayBuffer | Uint8Array) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function read(): Tokens | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(t: Tokens | null) {
  try {
    if (t) localStorage.setItem(KEY, JSON.stringify(t));
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: stay logged in for this tab only */
  }
}

export function isLoggedIn() {
  return !!read();
}

export async function login(returnTo = location.pathname) {
  const c = await loadConfig();
  if (!c) return alert("Auth isn't configured yet");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem("bozo.pkce", JSON.stringify({ verifier, state, returnTo }));
  const q = new URLSearchParams({
    response_type: "code", client_id: c.clientId, redirect_uri: redirectUri(),
    scope: "openid email profile", code_challenge_method: "S256", code_challenge: challenge, state,
  });
  location.assign(`https://${c.authDomain}/oauth2/authorize?${q}`);
}

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const c = (await loadConfig())!;
  const r = await fetch(`https://${c.authDomain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.clientId, ...body }),
  });
  if (!r.ok) throw new Error("Token exchange failed");
  const j = await r.json();
  return { idToken: j.id_token, refreshToken: j.refresh_token ?? body.refresh_token, expiresAt: Date.now() + (j.expires_in - 60) * 1000 };
}

export async function handleCallback(): Promise<string> {
  const p = new URLSearchParams(location.search);
  const saved = JSON.parse(sessionStorage.getItem("bozo.pkce") || "{}");
  if (!p.get("code") || p.get("state") !== saved.state) throw new Error("Login got scrambled. Try again.");
  write(await tokenRequest({ grant_type: "authorization_code", code: p.get("code")!, redirect_uri: redirectUri(), code_verifier: saved.verifier }));
  sessionStorage.removeItem("bozo.pkce");
  return saved.returnTo || "/";
}

export async function idToken(): Promise<string | null> {
  const t = read();
  if (!t) return null;
  if (Date.now() < t.expiresAt) return t.idToken;
  if (!t.refreshToken) return write(null), null;
  try {
    const fresh = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refreshToken });
    write(fresh);
    return fresh.idToken;
  } catch {
    write(null);
    return null;
  }
}

export async function logout() {
  const c = await loadConfig();
  write(null);
  if (c) location.assign(`https://${c.authDomain}/logout?client_id=${c.clientId}&logout_uri=${encodeURIComponent(location.origin + "/")}`);
  else location.assign("/");
}
