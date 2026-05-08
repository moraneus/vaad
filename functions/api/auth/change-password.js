// POST /api/auth/change-password
// Body: { kind: 'admin' | 'tenant', currentPassword, newPassword, apartmentId? }
// - admin: current admin password required
// - tenant: tenant changes own apartment password (must be logged in as tenant)

import { json, error, readJSON, pickStr } from '../../lib/util.js';
import { hashPassword, verifyPassword } from '../../lib/crypto.js';
import { loadSession } from '../../lib/session.js';
import { logAudit } from '../../lib/audit.js';

export const onRequestPost = async ({ request, env }) => {
  const db = env.DB;
  const sess = await loadSession(db, request, env);
  if (!sess) return error('יש להתחבר תחילה', 401);

  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const kind = pickStr(body.kind, 16);
  const currentPassword = pickStr(body.currentPassword, 200);
  const newPassword = pickStr(body.newPassword, 200);

  if (newPassword.length < 4) return error('הסיסמה החדשה חייבת לכלול 4 תווים לפחות', 400);

  if (kind === 'admin') {
    if (sess.role !== 'admin') return error('אין הרשאה', 403);
    // Gate: admin must have a Google-verified recovery email on file before
    // changing the password. The recovery email is what powers the "forgot
    // password" flow (Sign in with Google). Without it, a forgotten password
    // would be unrecoverable except by editing D1 directly.
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

  if (kind === 'tenant') {
    if (sess.role !== 'tenant') return error('אין הרשאה', 403);
    const apt = await db.prepare('SELECT id, number, password_hash AS h, password_salt AS s, iterations AS i FROM apartments WHERE id = ?').bind(sess.apartmentId).first();
    if (!apt) return error('דירה לא נמצאה', 404);
    const ok = await verifyPassword(currentPassword, apt.h, apt.s, apt.i);
    if (!ok) return error('סיסמה נוכחית שגויה', 401);
    const h = await hashPassword(newPassword, Number(env.PBKDF2_ITERATIONS || 100000));
    await db.prepare('UPDATE apartments SET password_hash = ?, password_salt = ?, iterations = ?, password_set_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?')
      .bind(h.hash, h.salt, h.iterations, apt.id).run();
    await logAudit(db, request, { event: 'tenant_password_changed', role: 'tenant', userLabel: String(apt.number), apartmentId: apt.id, success: true });
    return json({ ok: true });
  }
  return error('סוג בקשה לא תקף', 400);
};
