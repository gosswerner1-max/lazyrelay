// Shared between OAuthConsent.tsx (the consent screen a customer sees when
// authorizing a new app) and Dashboard.tsx's Connected apps list (the same
// scopes shown again for an app they already authorized) -- one source so
// the wording can't drift between the two.

/** Human-readable labels for the OIDC scopes Supabase's OAuth server
 *  issues. Falls back to the raw scope string for anything unlisted, so an
 *  unrecognised future scope still shows something rather than nothing. */
const SCOPE_LABELS: Record<string, string> = {
  openid: "Confirm it's really you",
  profile: "Your name",
  email: "Your email address",
  offline_access: "Stay connected when you're not using it (refresh access automatically)",
};

export function describeScopes(scope: string | string[]): string[] {
  const scopes = Array.isArray(scope) ? scope : scope.split(" ");
  return scopes.filter(Boolean).map((s) => SCOPE_LABELS[s] ?? s);
}
