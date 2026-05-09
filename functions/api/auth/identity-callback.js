// GET /api/auth/identity-callback?code=...&state=...
// Google redirects here after the user picks an account on the consent screen.
// Branches on the (purpose, scope) pair stored alongside the state nonce:
//
//   register/replace + scope='master'        : write to admin_recovery (master admin only)
//   register/replace + scope='apartment:<id>': write to apartment_recovery for that apt
//   reset + scope='master'                   : verify match in admin_recovery, mint admin token,
//                                              redirect to /?reset=<token>
//   reset + scope='apartment:<id>'           : verify match in apartment_recovery, mint apartment
//                                              token, redirect to /?reset=<token>&apt=<id>

import { uid, clientIP, userAgent } from '../../lib/util.js';
import { loadSession, createSession, setCookie } from '../../lib/session.js';
import { exchangeAndFetchEmail } from '../../lib/identity-oauth.js';
import { randomToken } from '../../lib/crypto.js';
import { logAudit } from '../../lib/audit.js';

const RESET_TTL_MIN = 30;
const STATE_TTL_MIN = 30;

const html = (status, message, ok = false) => new Response(
  `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${ok ? 'אומת' : 'שגיאת אימות'}</title>
   <meta name="viewport" content="width=device-width,initial-scale=1">
   <style>body{font-family:system-ui,-apple-system,sans-serif;max-width:520px;margin:80px auto;padding:24px;text-align:center;direction:rtl}
   .ok{color:#1f7a52}.err{color:#b3261e}h1{font-size:22px}p{line-height:1.6}
   a{color:#1f4068}</style></head>
   <body><h1 class="${ok ? 'ok' : 'err'}">${ok ? '✓ אומת בהצלחה' : '✗ אימות נכשל'}</h1>
   <p>${message}</p>
   <p><a href="/#settings">חזרה להגדרות</a></p>
   <script>setTimeout(() => location.href = '/#settings', 2500);</script>
   </body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
);

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Parses scope strings:
//   'master'                 → { kind: 'master' }
//   'apartment:<id>'         → { kind: 'apartment', apartmentId, userKind: 'tenant' }
//   'apartment_owner:<id>'   → { kind: 'apartment', apartmentId, userKind: 'owner' }  (legacy PR-B)
//   'owner:<id>'             → { kind: 'owner', ownerId }                              (PR-E)
function parseScope(scope) {
  if (!scope || scope === 'master') return { kind: 'master' };
  if (scope.startsWith('owner:')) return { kind: 'owner', ownerId: scope.slice('owner:'.length) };
  if (scope.startsWith('apartment_owner:')) return { kind: 'apartment', apartmentId: scope.slice('apartment_owner:'.length), userKind: 'owner' };
  if (scope.startsWith('apartment:')) return { kind: 'apartment', apartmentId: scope.slice('apartment:'.length), userKind: 'tenant' };
  return { kind: 'master' };
}

export const onRequestGet = async (ctx) => {
  // Top-level catch — any unhandled error (DB schema mismatch, OAuth
  // exception, network blip, etc.) surfaces as the styled HTML error page
  // instead of the framework's raw JSON. The audit log captures the actual
  // error for debugging; the UI shows a friendly 5xx page.
  try {
    return await handleCallback(ctx);
  } catch (e) {
    try {
      await ctx.env.DB.prepare(
        "INSERT INTO audit_log (id, ts, event, role, user_label, success, ip, user_agent, meta) VALUES (?, datetime('now'), 'identity_callback_unhandled', 'admin', 'oauth', 0, ?, ?, ?)"
      ).bind(
        crypto.randomUUID(),
        ctx.request.headers.get('CF-Connecting-IP') || 'unknown',
        ctx.request.headers.get('User-Agent') || '',
        JSON.stringify({ error: String(e?.message || e).slice(0, 500) }),
      ).run();
    } catch { /* best-effort logging — never let a logging failure mask the original */ }
    return html(500, 'אירעה שגיאת שרת. רשמנו את התקלה — נסה שוב, או פנה למנהל הוועד אם זה ממשיך.');
  }
};

async function handleCallback({ request, env }) {
  const db = env.DB;
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  if (errorParam) return html(400, `Google denied access: ${errorParam}.`);
  if (!code || !state) return html(400, 'חסרים פרמטרים. נסה שוב מהגדרות.');

  // Validate + consume state
  const stateRow = await db.prepare('SELECT purpose, scope, created_at FROM identity_oauth_state WHERE state = ?').bind(state).first();
  if (!stateRow) return html(400, 'הקישור פג תוקף או אינו תקף. התחל את התהליך מחדש מההגדרות.');
  await db.prepare('DELETE FROM identity_oauth_state WHERE state = ?').bind(state).run();

  const ageMin = (Date.now() - new Date(stateRow.created_at + 'Z').getTime()) / 60000;
  if (ageMin > STATE_TTL_MIN) return html(400, 'הבקשה פגה. נסה שוב.');

  const purpose = stateRow.purpose;
  const { kind, apartmentId, userKind, ownerId } = parseScope(stateRow.scope);
  const redirectURI = `${url.origin}/api/auth/identity-callback`;

  let email;
  try {
    email = await exchangeAndFetchEmail(env, code, redirectURI);
  } catch (e) {
    await logAudit(db, request, { event: 'identity_oauth_failed', role: kind === 'master' ? 'admin' : 'tenant', userLabel: kind === 'master' ? 'מנהל' : `apt:${apartmentId}`, success: false, meta: { purpose, reason: String(e.message || e).slice(0, 200) } });
    return html(500, `אימות נכשל: ${escapeHtml(e.message || 'שגיאה לא ידועה')}`);
  }

  if (purpose === 'register' || purpose === 'replace') {
    // Verify the current session matches the scope this OAuth flow was started in.
    const sess = await loadSession(db, request, env);
    if (!sess) {
      return html(403, 'יש להיכנס לפני אימות הזהות. התחבר ונסה שוב.');
    }
    if (kind === 'owner') {
      // First-class owner scope (PR E).
      if (!sess.ownerId || sess.ownerId !== ownerId) {
        await logAudit(db, request, { event: 'identity_register_denied', role: 'tenant', userLabel: `owner:${ownerId}`, success: false, meta: { purpose, reason: 'scope_owner_session_mismatch' } });
        return html(403, 'יש להיכנס עם חשבון הבעלים לפני אימות הזהות.');
      }
      await db.prepare(
        `INSERT INTO owner_recovery (owner_id, email, verified_at, updated_at)
         VALUES (?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(owner_id) DO UPDATE SET
           email = excluded.email,
           verified_at = excluded.verified_at,
           updated_at = excluded.updated_at`
      ).bind(ownerId, email).run();
      await logAudit(db, request, { event: purpose === 'register' ? 'identity_registered' : 'identity_replaced', role: 'tenant', userLabel: sess.userLabel, success: true, meta: { scope: stateRow.scope, email } });
      return html(200, `הזהות אומתה. ${escapeHtml(email)} שמור כעת ככתובת לאיפוס סיסמה לחשבון הבעלים.`, true);
    }
    if (kind === 'master') {
      // Master admin: must be admin role AND no apartmentId.
      if (sess.role !== 'admin' || sess.apartmentId) {
        await logAudit(db, request, { event: 'identity_register_denied', role: 'admin', userLabel: 'מנהל', success: false, meta: { purpose, reason: 'scope_master_session_mismatch' } });
        return html(403, 'יש להיכנס כמנהל ראשי לפני אימות הזהות.');
      }
      await db.prepare(
        `INSERT INTO admin_recovery (id, email, verified_at, updated_at)
         VALUES (1, ?, datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email,
           verified_at = excluded.verified_at,
           updated_at = excluded.updated_at`
      ).bind(email).run();
      await logAudit(db, request, { event: purpose === 'register' ? 'identity_registered' : 'identity_replaced', role: 'admin', userLabel: 'מנהל', success: true, meta: { scope: 'master', email } });
      return html(200, `הזהות אומתה. ${escapeHtml(email)} שמור כעת ככתובת לאיפוס סיסמה. מעביר חזרה להגדרות…`, true);
    }
    // Apartment scope: session must be on the same apartment AND match the
    // userKind (a renter session can only register the renter recovery; same
    // for owner). This prevents an owner-session from accidentally writing
    // to the renter's recovery row, and vice-versa.
    if (!sess.apartmentId || sess.apartmentId !== apartmentId) {
      await logAudit(db, request, { event: 'identity_register_denied', role: 'tenant', userLabel: `apt:${apartmentId}`, success: false, meta: { purpose, reason: 'scope_apartment_session_mismatch' } });
      return html(403, 'יש להיכנס עם דירת היעד לפני אימות הזהות.');
    }
    const sessionKind = sess.userKind === 'owner' ? 'owner' : 'tenant';
    if (sessionKind !== userKind) {
      await logAudit(db, request, { event: 'identity_register_denied', role: 'tenant', userLabel: sess.userLabel, apartmentId, success: false, meta: { purpose, reason: 'scope_userkind_mismatch', expected: userKind, sessionKind } });
      return html(403, 'הסשן הנוכחי לא תואם לחשבון השחזור שאתה מנסה לאמת.');
    }
    const tableName = userKind === 'owner' ? 'apartment_owner_recovery' : 'apartment_recovery';
    await db.prepare(
      `INSERT INTO ${tableName} (apartment_id, email, verified_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(apartment_id) DO UPDATE SET
         email = excluded.email,
         verified_at = excluded.verified_at,
         updated_at = excluded.updated_at`
    ).bind(apartmentId, email).run();
    await logAudit(db, request, { event: purpose === 'register' ? 'identity_registered' : 'identity_replaced', role: 'tenant', userLabel: sess.userLabel || `apt:${apartmentId}`, apartmentId, success: true, meta: { scope: stateRow.scope, email } });
    return html(200, `הזהות אומתה. ${escapeHtml(email)} שמור כעת ככתובת לאיפוס סיסמה לדירה זו (${userKind === 'owner' ? 'בעלים' : 'דייר'}).`, true);
  }

  if (purpose === 'login') {
    // OAuth-as-login: lookup the verified email in our user records and
    // create the right session. The lookup order accepts both the primary
    // login email AND the recovery email — admin doesn't need to enter the
    // same address in two places.
    //
    //   1. owners.login_email           → first-class owner
    //   2. owner_recovery.email         → first-class owner (recovery)
    //   3. apartment_email.email        → apartment renter (opt-in email)
    //   4. apartment_recovery.email     → apartment renter (recovery)
    //   5. admin_recovery.email         → master admin (BLOCKED if 2FA enabled —
    //                                      OAuth alone bypasses the second factor)
    let owner = await db.prepare(
      'SELECT id, name FROM owners WHERE LOWER(login_email) = ?'
    ).bind(email).first();
    if (!owner) {
      owner = await db.prepare(
        `SELECT o.id, o.name
           FROM owners o
           JOIN owner_recovery orec ON orec.owner_id = o.id
          WHERE LOWER(orec.email) = ?`
      ).bind(email).first();
    }
    if (owner) {
      const ownerAdmin = await db.prepare(
        `SELECT 1 AS isAdmin
           FROM apartment_owner_link l
           JOIN apartment_admins aa ON aa.apartment_id = l.apartment_id
          WHERE l.owner_id = ? LIMIT 1`
      ).bind(owner.id).first();
      const role = ownerAdmin?.isAdmin ? 'admin' : 'tenant';
      const userLabel = `${owner.name}${role === 'admin' ? ' (בעלים, מנהל)' : ' (בעלים)'}`;
      const session = await createSession(db, {
        role,
        apartmentId: null,
        userLabel,
        userKind: 'owner',
        ownerId: owner.id,
      }, env, request);
      await logAudit(db, request, { event: 'login', role, userLabel, success: true, meta: { method: 'oauth', ownerId: owner.id, email } });
      const res = new Response(null, { status: 302, headers: { location: '/' } });
      setCookie(res, env, session.token, 60 * 60 * Number(env.SESSION_TTL_HOURS || 12), request);
      return res;
    }

    // Renter — match against apartment_email (the opt-in table; the
    // apartments table itself has no email column) OR apartment_recovery.email.
    let apt = await db.prepare(
      `SELECT a.id, a.number
         FROM apartments a
         JOIN apartment_email ae ON ae.apartment_id = a.id
        WHERE LOWER(ae.email) = ?
        LIMIT 1`
    ).bind(email).first();
    if (!apt) {
      apt = await db.prepare(
        `SELECT a.id, a.number
           FROM apartments a
           JOIN apartment_recovery ar ON ar.apartment_id = a.id
          WHERE LOWER(ar.email) = ?
          LIMIT 1`
      ).bind(email).first();
    }
    if (apt) {
      const adminRow = await db.prepare('SELECT 1 AS isAdmin FROM apartment_admins WHERE apartment_id = ?').bind(apt.id).first();
      const isAdminApt = !!adminRow?.isAdmin;
      const role = isAdminApt ? 'admin' : 'tenant';
      const userLabel = `${apt.number}${isAdminApt ? ' (מנהל)' : ''}`;
      const session = await createSession(db, {
        role,
        apartmentId: apt.id,
        userLabel,
        userKind: 'tenant',
      }, env, request);
      await logAudit(db, request, { event: 'login', role, userLabel, apartmentId: apt.id, success: true, meta: { method: 'oauth', email } });
      const res = new Response(null, { status: 302, headers: { location: '/' } });
      setCookie(res, env, session.token, 60 * 60 * Number(env.SESSION_TTL_HOURS || 12), request);
      return res;
    }

    // Master admin — allowed only when 2FA is disabled. OAuth alone is a
    // single factor; if the admin has enabled 2FA they MUST use the password
    // path (which integrates 2FA challenge). Otherwise OAuth would silently
    // bypass that protection.
    const adminRecovery = await db.prepare('SELECT email FROM admin_recovery WHERE id = 1').first();
    if (adminRecovery?.email && String(adminRecovery.email).toLowerCase() === email) {
      const twofa = await db.prepare("SELECT totp_enabled AS enabled FROM admin_2fa WHERE id = 1").first();
      if (twofa?.enabled) {
        await logAudit(db, request, { event: 'login_failed', role: 'admin', userLabel: 'מנהל', success: false, meta: { method: 'oauth', reason: 'oauth_blocked_by_2fa' } });
        return html(403, 'מנהל ראשי עם 2FA מופעל לא יכול להיכנס דרך Google בלבד — היכנס עם הסיסמה ואז ה-2FA.');
      }
      const session = await createSession(db, { role: 'admin', userLabel: 'מנהל' }, env, request);
      await logAudit(db, request, { event: 'login', role: 'admin', userLabel: 'מנהל', success: true, meta: { method: 'oauth' } });
      const res = new Response(null, { status: 302, headers: { location: '/' } });
      setCookie(res, env, session.token, 60 * 60 * Number(env.SESSION_TTL_HOURS || 12), request);
      return res;
    }

    // No match in any user record.
    await logAudit(db, request, { event: 'login_failed', role: 'tenant', userLabel: 'oauth', success: false, meta: { method: 'oauth', reason: 'no_account_for_email', attempted: email } });
    return html(404, `לא נמצא חשבון עבור ${escapeHtml(email)}. פנה למנהל הוועד כדי לקשר את החשבון שלך.`);
  }

  if (purpose === 'reset') {
    if (kind === 'owner') {
      // First-class owner reset.
      const recovery = await db.prepare('SELECT email FROM owner_recovery WHERE owner_id = ?').bind(ownerId).first();
      if (!recovery?.email || String(recovery.email).toLowerCase() !== email) {
        await logAudit(db, request, { event: 'identity_reset_mismatch', role: 'tenant', userLabel: `owner:${ownerId}`, success: false, meta: { scope: stateRow.scope, attempted: email } });
        return html(403, 'חשבון Google לא תואם לחשבון השחזור הרשום לבעלים.');
      }
      const plainToken = randomToken(32);
      const tokenHash = await sha256Hex(plainToken);
      const expiresAt = new Date(Date.now() + RESET_TTL_MIN * 60 * 1000).toISOString();
      await db.prepare(
        `INSERT INTO owner_password_reset_tokens (id, owner_id, token_hash, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(uid('opr-'), ownerId, tokenHash, expiresAt, clientIP(request), userAgent(request)).run();
      await logAudit(db, request, { event: 'identity_reset_minted', role: 'tenant', userLabel: `owner:${ownerId}`, success: true, meta: { scope: stateRow.scope, email } });
      return new Response(null, { status: 302, headers: { location: `/?reset=${encodeURIComponent(plainToken)}&owner=${encodeURIComponent(ownerId)}` } });
    }
    if (kind === 'master') {
      const recovery = await db.prepare('SELECT email FROM admin_recovery WHERE id = 1').first();
      if (!recovery?.email || String(recovery.email).toLowerCase() !== email) {
        await logAudit(db, request, { event: 'identity_reset_mismatch', role: 'admin', userLabel: 'מנהל', success: false, meta: { scope: 'master', attempted: email } });
        return html(403, 'חשבון Google לא תואם לחשבון השחזור הרשום. אם אתה המנהל, התחבר עם החשבון שרשמת בהגדרות הזהות.');
      }
      const plainToken = randomToken(32);
      const tokenHash = await sha256Hex(plainToken);
      const expiresAt = new Date(Date.now() + RESET_TTL_MIN * 60 * 1000).toISOString();
      await db.prepare(`INSERT INTO password_reset_tokens (id, type, token_hash, expires_at, ip, user_agent) VALUES (?, 'admin', ?, ?, ?, ?)`)
        .bind(uid('pwr-'), tokenHash, expiresAt, clientIP(request), userAgent(request)).run();
      await logAudit(db, request, { event: 'identity_reset_minted', role: 'admin', userLabel: 'מנהל', success: true, meta: { scope: 'master', email } });
      return new Response(null, { status: 302, headers: { location: `/?reset=${encodeURIComponent(plainToken)}` } });
    }
    // Apartment scope reset — picks the right recovery + token tables based
    // on userKind (tenant vs owner).
    const recoveryTable = userKind === 'owner' ? 'apartment_owner_recovery' : 'apartment_recovery';
    const tokenTable    = userKind === 'owner' ? 'apartment_owner_password_reset_tokens' : 'apartment_password_reset_tokens';
    const tokenPrefix   = userKind === 'owner' ? 'apo-' : 'apr-';
    const recovery = await db.prepare(`SELECT email FROM ${recoveryTable} WHERE apartment_id = ?`).bind(apartmentId).first();
    if (!recovery?.email || String(recovery.email).toLowerCase() !== email) {
      await logAudit(db, request, { event: 'identity_reset_mismatch', role: 'tenant', userLabel: `apt:${apartmentId}`, apartmentId, success: false, meta: { scope: stateRow.scope, attempted: email } });
      return html(403, 'חשבון Google לא תואם לחשבון השחזור הרשום לדירה זו.');
    }
    const plainToken = randomToken(32);
    const tokenHash = await sha256Hex(plainToken);
    const expiresAt = new Date(Date.now() + RESET_TTL_MIN * 60 * 1000).toISOString();
    await db.prepare(
      `INSERT INTO ${tokenTable} (id, apartment_id, token_hash, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(uid(tokenPrefix), apartmentId, tokenHash, expiresAt, clientIP(request), userAgent(request)).run();
    await logAudit(db, request, { event: 'identity_reset_minted', role: 'tenant', userLabel: `apt:${apartmentId}`, apartmentId, success: true, meta: { scope: stateRow.scope, email } });
    const roleQS = userKind === 'owner' ? '&role=owner' : '';
    return new Response(null, { status: 302, headers: { location: `/?reset=${encodeURIComponent(plainToken)}&apt=${encodeURIComponent(apartmentId)}${roleQS}` } });
  }

  return html(400, 'מטרה לא חוקית.');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
