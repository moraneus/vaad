// POST /api/auth/change-password
// Body: { kind: 'admin' | 'tenant', currentPassword, newPassword }
// - admin : changes the master admin password (admin_auth row).
//           ONLY allowed for the master admin session (role='admin' AND no apartmentId).
//           Apartment-admins are NOT allowed here — they're apartment users with
//           an admin grant; their password lives in `apartments`.
// - tenant: changes the apartment password (apartments.password_hash).
//           Allowed for any session with an apartmentId — both regular tenants
//           AND apartment-admins, since their identity is the apartment, not
//           the master admin.

import { json, error, readJSON, pickStr } from '../../lib/util.js';
import { hashPassword, verifyPassword, validatePassword } from '../../lib/crypto.js';
import { loadSession } from '../../lib/session.js';
import { logAudit } from '../../lib/audit.js';
import { wipePassword } from '../../lib/password-stash.js';

export const onRequestPost = async ({ request, env }) => {
  const db = env.DB;
  const sess = await loadSession(db, request, env);
  if (!sess) return error('יש להתחבר תחילה', 401);

  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const kind = pickStr(body.kind, 16);
  const currentPassword = pickStr(body.currentPassword, 200);
  const newPassword = pickStr(body.newPassword, 200);

  // Policy: user-set passwords must include upper, lower, digit, symbol, ≥8 chars.
  const v = validatePassword(newPassword);
  if (!v.ok) {
    return json({
      error: 'הסיסמה לא עומדת במדיניות (לפחות 8 תווים, אות גדולה, אות קטנה, ספרה, סימול)',
      passwordPolicy: v,
    }, { status: 400 });
  }

  if (kind === 'admin') {
    // Master admin only — admin role AND no apartmentId. This blocks
    // apartment-admins from rotating the global admin password.
    if (sess.role !== 'admin' || sess.apartmentId) return error('אין הרשאה', 403);
    // Gate: master admin must have a Google-verified recovery email before
    // changing the password. Without it, a forgotten password is unrecoverable
    // except by editing D1 directly.
    const recovery = await db.prepare('SELECT email FROM admin_recovery WHERE id = 1').first();
    if (!recovery?.email) {
      return json({
        error: 'לפני שינוי סיסמה יש לאמת חשבון Google לאיפוס סיסמה. עבור להגדרות → אבטחה → "אימות זהות עם Google".',
        requiresIdentityVerification: true,
      }, { status: 403 });
    }
    const row = await db.prepare('SELECT password_hash AS h, password_salt AS s, iterations AS i FROM admin_auth WHERE id = 1').first();
    const ok = await verifyPassword(currentPassword, row.h, row.s, row.i);
    if (!ok) return error('סיסמת מנהל נוכחית שגויה', 401);
    const h = await hashPassword(newPassword, Number(env.PBKDF2_ITERATIONS || 100000));
    await db.prepare('UPDATE admin_auth SET password_hash = ?, password_salt = ?, iterations = ?, updated_at = datetime(\'now\') WHERE id = 1')
      .bind(h.hash, h.salt, h.iterations).run();
    await logAudit(db, request, { event: 'admin_password_changed', role: 'admin', userLabel: 'מנהל', success: true });
    return json({ ok: true });
  }

  if (kind === 'owner') {
    // First-class owner (PR E). Session must be a mode='owner' session.
    if (sess.userKind !== 'owner' || !sess.ownerId) return error('אין הרשאה', 403);
    const owner = await db.prepare('SELECT id, password_hash AS h, password_salt AS s, iterations AS i FROM owners WHERE id = ?').bind(sess.ownerId).first();
    if (!owner) return error('בעלים לא נמצא', 404);
    if (!owner.h) return error('הסיסמה אינה מוגדרת', 404);
    const ok = await verifyPassword(currentPassword, owner.h, owner.s, owner.i);
    if (!ok) return error('סיסמה נוכחית שגויה', 401);
    const h = await hashPassword(newPassword, Number(env.PBKDF2_ITERATIONS || 100000));
    await db.prepare(
      "UPDATE owners SET password_hash = ?, password_salt = ?, iterations = ?, password_set_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).bind(h.hash, h.salt, h.iterations, owner.id).run();
    // User changed their own password — admin-visible stash is no longer
    // valid (the new password is private to the user).
    await wipePassword(db, 'owner', owner.id);
    await logAudit(db, request, { event: 'owner_password_changed', role: 'tenant', userLabel: sess.userLabel || `owner:${owner.id}`, success: true, meta: { ownerId: owner.id } });
    return json({ ok: true });
  }

  if (kind === 'tenant') {
    // Any apartment user — regular tenant OR apartment-admin. Both have an
    // apartmentId on their session and own their apartment's password. The
    // session's userKind selects which credential set is being changed:
    //   userKind='tenant' (default) → apartments.password_hash
    //   userKind='owner'             → apartment_owner_auth.password_hash
    if (!sess.apartmentId) return error('אין הרשאה', 403);
    const apt = await db.prepare('SELECT id, number FROM apartments WHERE id = ?').bind(sess.apartmentId).first();
    if (!apt) return error('דירה לא נמצאה', 404);
    const userKind = sess.userKind === 'owner' ? 'owner' : 'tenant';

    if (userKind === 'owner') {
      const cred = await db.prepare('SELECT password_hash AS h, password_salt AS s, iterations AS i FROM apartment_owner_auth WHERE apartment_id = ?').bind(apt.id).first();
      if (!cred?.h) return error('הסיסמה לבעלים אינה מוגדרת', 404);
      const ok = await verifyPassword(currentPassword, cred.h, cred.s, cred.i);
      if (!ok) return error('סיסמה נוכחית שגויה', 401);
      const h = await hashPassword(newPassword, Number(env.PBKDF2_ITERATIONS || 100000));
      await db.prepare(
        `INSERT INTO apartment_owner_auth (apartment_id, password_hash, password_salt, iterations, password_set_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(apartment_id) DO UPDATE SET
           password_hash = excluded.password_hash,
           password_salt = excluded.password_salt,
           iterations = excluded.iterations,
           password_set_at = excluded.password_set_at,
           updated_at = excluded.updated_at`
      ).bind(apt.id, h.hash, h.salt, h.iterations).run();
      await wipePassword(db, 'apartment-owner-legacy', apt.id);
      await logAudit(db, request, { event: 'owner_password_changed', role: sess.role, userLabel: sess.userLabel || String(apt.number), apartmentId: apt.id, success: true });
      return json({ ok: true });
    }

    // Renter / regular tenant credentials.
    const cred = await db.prepare('SELECT password_hash AS h, password_salt AS s, iterations AS i FROM apartments WHERE id = ?').bind(apt.id).first();
    const ok = await verifyPassword(currentPassword, cred.h, cred.s, cred.i);
    if (!ok) return error('סיסמה נוכחית שגויה', 401);
    const h = await hashPassword(newPassword, Number(env.PBKDF2_ITERATIONS || 100000));
    await db.prepare('UPDATE apartments SET password_hash = ?, password_salt = ?, iterations = ?, password_set_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?')
      .bind(h.hash, h.salt, h.iterations, apt.id).run();
    await wipePassword(db, 'apartment-tenant', apt.id);
    await logAudit(db, request, { event: 'tenant_password_changed', role: sess.role, userLabel: sess.userLabel || String(apt.number), apartmentId: apt.id, success: true });
    return json({ ok: true });
  }
  return error('סוג בקשה לא תקף', 400);
};
