// Lightweight Google OAuth used purely for identity verification (NOT Drive).
// Scopes: openid + email + profile. No refresh token needed — the verified
// email is consumed once per flow (register / replace / reset).
//
// This is separate from `drive.js` so that:
//   * Identity verification can be done without Drive being connected.
//   * The admin can register one Google account here and use a different one
//     for Drive document storage.

const SCOPE = 'openid email profile';

export function buildIdentityAuthURL(env, redirectURI, state) {
  if (!env.GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID not configured');
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectURI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'online',     // no refresh token
    prompt: 'select_account',  // always show account chooser; admin can pick a different account
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Exchange the authorization code for an access token, then fetch the verified
// email from Google's userinfo endpoint. Returns the lowercase email string.
export async function exchangeAndFetchEmail(env, code, redirectURI) {
  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectURI,
    }),
  });
  if (!tokRes.ok) throw new Error(`token exchange failed: ${tokRes.status}`);
  const tokens = await tokRes.json();

  const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!userRes.ok) throw new Error(`userinfo failed: ${userRes.status}`);
  const user = await userRes.json();
  if (!user.email) throw new Error('no email returned');
  if (user.verified_email === false) throw new Error('email not verified by Google');
  return String(user.email).trim().toLowerCase();
}
