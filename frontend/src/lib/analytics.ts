/** Google Tag Manager dataLayer events. GTM (and the GA4 tag inside it) is loaded from index.html on the
 * production domain only. Never send names, emails or query strings: pages are sent as bare paths, because the
 * login redirect URL carries a one-time sign-in code. */
type Params = Record<string, string | number | boolean | undefined>;

declare global {
  interface Window { dataLayer?: unknown[] }
}

export function track(event: string, params: Params = {}) {
  try {
    (window.dataLayer = window.dataLayer || []).push({ event, ...params });
  } catch { /* analytics must never break the app */ }
}

/** SPA page view: GA4's own page_view should be off in GTM and this event used instead. */
export function pageView(path: string) {
  track("spa_page_view", { page_path: path, page_location: location.origin + path, page_title: document.title });
}

/** Who's browsing, without saying who: lets reports split viewers / players / admin (and filter out the admin). */
export function setRole(role: string) {
  track("user_context", { user_role: role });
}
