// Payment receipts.
//   GET    /api/receipts                        — list (tenant: own apt only; admin: all)
//   GET    /api/receipts?id=...                 — single receipt as JSON
//   GET    /api/receipts?id=...&format=html     — printable HTML page
//   POST   /api/receipts  { apartmentId, year, month, notes? }  — issue new receipt
//
// Rules:
//   - Tenants may only issue/view receipts for their own apartment.
//   - Admins (master or promoted apartment) may issue/view for any apartment.
//   - Receipt can only be issued for a (year, month) where there is at least
//     one payment recorded for the apartment.
//   - Each issuance gets a fresh, monotonically increasing serial that is
//     unique across the whole system.
//
// The HTML format opens directly in a popup window for printing/saving as PDF.
// It needs inline event handlers to work, so we set a per-response CSP that
// allows them — the global middleware default forbids inline scripts.

import { json, error, readJSON, pickStr, pickInt, uid } from '../lib/util.js';
import { requireRead, requireSession } from '../lib/guard.js';
import { logAudit } from '../lib/audit.js';

const SAFE_FIELDS = `id, serial, apartment_id AS apartmentId, apartment_number AS apartmentNumber,
  apartment_owner AS apartmentOwner, year, month, total_amount AS totalAmount,
  payments_json AS paymentsJson, issued_at AS issuedAt, issued_by AS issuedBy, notes`;

function shapeRow(row) {
  if (!row) return null;
  const out = { ...row };
  if (out.paymentsJson) {
    try { out.payments = JSON.parse(out.paymentsJson); } catch { out.payments = []; }
  } else {
    out.payments = [];
  }
  delete out.paymentsJson;
  return out;
}

export const onRequestGet = async ({ request, env }) => {
  const r = await requireRead(env, request); if (r.error) return r.error;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const aptId = url.searchParams.get('apartmentId');

  if (id) {
    const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM receipts WHERE id = ?`).bind(id).first();
    if (!row) return error('הקבלה לא נמצאה', 404);
    if (r.sess.role === 'tenant' && row.apartmentId !== r.sess.apartmentId) {
      return error('אין הרשאה לצפות בקבלה זו', 403);
    }
    const receipt = shapeRow(row);

    if (url.searchParams.get('format') === 'html') {
      // Load building/bank settings to enrich the printable receipt.
      const settingsRows = await env.DB.prepare('SELECT key, value FROM settings').all();
      const settings = {};
      for (const sr of settingsRows.results) settings[sr.key] = sr.value;
      const html = renderReceiptHTML(receipt, settings);
      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          // Local CSP for the printable page — allows inline scripts (auto-print)
          // and inline event handlers (Print/Close buttons). The middleware
          // respects an existing CSP header and won't override.
          'content-security-policy': [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            "img-src 'self' data:",
            "connect-src 'self'",
            "frame-ancestors 'none'",
          ].join('; '),
        },
      });
    }
    return json(receipt);
  }

  // List
  const where = [];
  const params = [];
  // Tenants are limited to their own apartment regardless of query param.
  if (r.sess.role === 'tenant') {
    where.push('apartment_id = ?');
    params.push(r.sess.apartmentId);
  } else if (aptId) {
    where.push('apartment_id = ?');
    params.push(aptId);
  }
  const sql = `SELECT ${SAFE_FIELDS} FROM receipts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY serial DESC`;
  const rows = await env.DB.prepare(sql).bind(...params).all();
  return json({ receipts: rows.results.map(shapeRow) });
};

export const onRequestPost = async ({ request, env }) => {
  const r = await requireSession(env, request); if (r.error) return r.error;
  let body; try { body = await readJSON(request); } catch { return error('בקשה לא תקינה'); }
  const apartmentId = pickStr(body.apartmentId, 80);
  const year = pickInt(body.year);
  const month = pickInt(body.month);
  const notes = pickStr(body.notes, 500);
  if (!apartmentId || !year || !month) return error('שדות חובה חסרים', 400);
  if (month < 1 || month > 12) return error('חודש לא תקף', 400);

  // Tenant can only issue for their own apartment.
  if (r.sess.role !== 'admin' && r.sess.apartmentId !== apartmentId) {
    return error('ניתן להפיק קבלה לדירה שלך בלבד', 403);
  }

  // Idempotent issuance: if a receipt already exists for this (apt, year, month)
  // return that one instead of allocating a new serial. The serial is global
  // and only advances for genuinely new periods that haven't been receipted yet.
  const existing = await env.DB.prepare(
    `SELECT ${SAFE_FIELDS} FROM receipts
      WHERE apartment_id = ? AND year = ? AND month = ?
      ORDER BY serial ASC LIMIT 1`
  ).bind(apartmentId, year, month).first();
  if (existing) {
    return json(shapeRow(existing));
  }

  const apt = await env.DB.prepare('SELECT id, number, owner FROM apartments WHERE id = ?').bind(apartmentId).first();
  if (!apt) return error('דירה לא נמצאה', 404);

  // Verify payments exist for this (apt, year, month). Without paid amount
  // there is nothing to receipt.
  const payments = await env.DB.prepare(
    `SELECT id, amount, paid_on AS paidOn, method, notes
       FROM payments
      WHERE apartment_id = ? AND year = ? AND month = ?
      ORDER BY paid_on ASC, id ASC`
  ).bind(apartmentId, year, month).all();
  if (!payments.results || payments.results.length === 0) {
    return error('אין תשלומים בחודש זה', 400);
  }
  const total = payments.results.reduce((s, p) => s + Number(p.amount || 0), 0);
  if (total <= 0) return error('סכום התשלום הוא אפס — לא ניתן להפיק קבלה', 400);

  // Allocate the next serial. Race between concurrent issuers is acceptable
  // for this scale; the UNIQUE constraint on serial would catch duplicates.
  const next = await env.DB.prepare('SELECT COALESCE(MAX(serial), 0) AS m FROM receipts').first();
  const serial = (Number(next.m) || 0) + 1;

  const id = uid('rcp-');
  await env.DB.prepare(
    `INSERT INTO receipts (id, serial, apartment_id, apartment_number, apartment_owner, year, month, total_amount, payments_json, issued_by, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, serial, apartmentId, String(apt.number), apt.owner || null,
    year, month, total, JSON.stringify(payments.results),
    r.sess.userLabel || null, notes || null,
  ).run();

  await logAudit(env.DB, request, {
    event: 'receipt_issued',
    role: r.sess.role,
    userLabel: r.sess.userLabel,
    apartmentId,
    meta: { serial, year, month, total },
    success: true,
  });

  const row = await env.DB.prepare(`SELECT ${SAFE_FIELDS} FROM receipts WHERE id = ?`).bind(id).first();
  return json(shapeRow(row), { status: 201 });
};

// ----- Server-side receipt HTML rendering -----
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

function htmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtILS(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(Number(n));
}

function fmtDate(s) {
  if (!s) return '—';
  try { return new Date(s).toLocaleDateString('he-IL'); } catch { return s; }
}

function methodLabel(m) {
  const map = { bank: 'העברה בנקאית', bit: 'ביט', check: 'צ׳ק', cash: 'מזומן', other: 'אחר' };
  return map[m] || m || '—';
}

function formatReceiptNumber(receipt) {
  const padded = String(receipt.serial).padStart(5, '0');
  const mm = String(receipt.month).padStart(2, '0');
  return `${padded}/${receipt.apartmentNumber}/${mm}-${receipt.year}`;
}

function renderReceiptHTML(receipt, settings) {
  const number = formatReceiptNumber(receipt);
  const periodLabel = `${HE_MONTHS[receipt.month - 1]} ${receipt.year}`;
  const issuedLabel = receipt.issuedAt ? new Date(receipt.issuedAt).toLocaleString('he-IL') : '';
  const buildingName = settings.building_name || 'בניין הוועד';
  const buildingAddress = settings.building_address || '';

  const paymentsRows = (receipt.payments || []).map(p => `
    <tr>
      <td>${htmlEscape(p.paidOn ? fmtDate(p.paidOn) : '—')}</td>
      <td>${htmlEscape(methodLabel(p.method))}</td>
      <td class="num">${htmlEscape(fmtILS(p.amount))}</td>
      <td class="muted">${htmlEscape(p.notes || '')}</td>
    </tr>
  `).join('');

  // Build payment-method blocks (Bank / Bit / PayBox). Each is rendered only
  // if at least one of its fields was filled in.
  const renderRow = (label, value) => value && String(value).trim()
    ? `<div class="bank-line"><span class="muted">${htmlEscape(label)}:</span> <strong>${htmlEscape(value)}</strong></div>`
    : '';
  const blockIfAny = (title, lines) => {
    const body = lines.join('');
    return body
      ? `<div class="bank"><h3>${htmlEscape(title)}</h3>${body}</div>`
      : '';
  };
  const bankBlock = blockIfAny('פרטי בנק', [
    renderRow('שם הבנק', settings.bank_name),
    renderRow('מספר סניף', settings.bank_branch),
    renderRow('מספר חשבון', settings.bank_account_number),
    renderRow('בעל החשבון', settings.bank_account_holder),
    renderRow('IBAN', settings.bank_iban),
    settings.bank_notes && String(settings.bank_notes).trim()
      ? `<div style="margin-top:6px; font-size:13px; white-space:pre-line">${htmlEscape(settings.bank_notes)}</div>`
      : '',
  ]);
  const bitBlock = blockIfAny('תשלום בביט (Bit)', [
    renderRow('מספר טלפון', settings.bit_phone),
    renderRow('על שם', settings.bit_holder),
    settings.bit_notes && String(settings.bit_notes).trim()
      ? `<div style="margin-top:6px; font-size:13px; white-space:pre-line">${htmlEscape(settings.bit_notes)}</div>`
      : '',
  ]);
  const payboxBlock = blockIfAny('תשלום בפייבוקס (PayBox)', [
    renderRow('מספר טלפון', settings.paybox_phone),
    renderRow('על שם', settings.paybox_holder),
    renderRow('קישור קבוצה', settings.paybox_link),
    settings.paybox_notes && String(settings.paybox_notes).trim()
      ? `<div style="margin-top:6px; font-size:13px; white-space:pre-line">${htmlEscape(settings.paybox_notes)}</div>`
      : '',
  ]);
  const paymentMethods = bankBlock + bitBlock + payboxBlock;

  const titleStr = `קבלה על תשלום — ${number}`;

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${htmlEscape(titleStr)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'Heebo', system-ui, -apple-system, sans-serif;
      margin: 0; padding: 24px 32px;
      color: #1f2937; background: #fff; line-height: 1.5;
    }
    .header {
      display: flex; justify-content: space-between; align-items: flex-start;
      border-bottom: 2px solid #1f4068; padding-bottom: 14px; margin-bottom: 18px;
    }
    .building { font-size: 22px; font-weight: 700; color: #1f4068; }
    .building-sub { font-size: 13px; color: #64748b; margin-top: 2px; }
    .receipt-box {
      text-align: center; border: 2px solid #1f4068; border-radius: 8px;
      padding: 8px 14px; min-width: 220px;
    }
    .receipt-box__label {
      font-size: 11px; letter-spacing: 0.05em; color: #64748b; text-transform: uppercase;
    }
    .receipt-box__number {
      font-size: 18px; font-weight: 700; color: #1f4068;
      font-feature-settings: "tnum"; margin-top: 2px;
    }
    h1 { font-size: 24px; margin: 0 0 16px; color: #1f4068; letter-spacing: -0.01em; }
    .meta {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 8px 24px; font-size: 14px; margin-bottom: 18px;
    }
    .meta__row {
      display: flex; gap: 6px; padding: 4px 0;
      border-bottom: 1px solid #e2e8f0;
    }
    .meta__label { color: #64748b; min-width: 100px; }
    .meta__value { font-weight: 600; }
    h2 {
      font-size: 15px; margin: 18px 0 8px; color: #1f4068;
      border-bottom: 1px solid #e2e8f0; padding-bottom: 4px;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 10px; text-align: start; border-bottom: 1px solid #e2e8f0; }
    th { background: #f1f5f9; font-weight: 600; font-size: 12px; color: #475569; }
    td.num, th.num { text-align: end; font-feature-settings: "tnum"; }
    .muted { color: #64748b; }
    .total {
      margin-top: 14px; padding: 12px 16px; background: #f1f5f9; border-radius: 8px;
      display: flex; justify-content: space-between; align-items: center;
      font-size: 18px; font-weight: 700; color: #1f4068;
    }
    .bank {
      margin-top: 22px; padding: 12px 16px; background: #fafbfc;
      border: 1px solid #e2e8f0; border-radius: 8px;
    }
    .bank h3 { margin: 0 0 8px; font-size: 13px; color: #475569; font-weight: 600; }
    .bank-line { font-size: 13px; padding: 2px 0; }
    .footer {
      margin-top: 28px; text-align: center; color: #64748b;
      font-size: 13px; font-style: italic;
    }
    .actions {
      margin-top: 28px; display: flex; gap: 10px; justify-content: flex-end;
    }
    .btn {
      padding: 10px 18px; border: 1px solid #1f4068; background: #fff;
      color: #1f4068; font-size: 14px; font-weight: 600;
      border-radius: 8px; cursor: pointer;
    }
    .btn--primary { background: #1f4068; color: #fff; }
    .notes {
      margin-top: 12px; padding: 10px 12px; background: #fef9e7;
      border-right: 3px solid #d4a44b; font-size: 13px; white-space: pre-line;
    }
    @media print {
      .actions { display: none; }
      body { padding: 16px 24px; }
    }
    @page { margin: 14mm; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="building">${htmlEscape(buildingName)}</div>
      ${buildingAddress ? `<div class="building-sub">${htmlEscape(buildingAddress)}</div>` : ''}
    </div>
    <div class="receipt-box">
      <div class="receipt-box__label">קבלה מספר</div>
      <div class="receipt-box__number">${htmlEscape(number)}</div>
    </div>
  </div>

  <h1>קבלה על תשלום</h1>

  <div class="meta">
    <div class="meta__row">
      <span class="meta__label">דירה</span>
      <span class="meta__value">${htmlEscape(receipt.apartmentNumber)}</span>
    </div>
    ${receipt.apartmentOwner ? `
      <div class="meta__row">
        <span class="meta__label">בעל הדירה</span>
        <span class="meta__value">${htmlEscape(receipt.apartmentOwner)}</span>
      </div>
    ` : ''}
    <div class="meta__row">
      <span class="meta__label">תקופת התשלום</span>
      <span class="meta__value">${htmlEscape(periodLabel)}</span>
    </div>
    <div class="meta__row">
      <span class="meta__label">תאריך הפקה</span>
      <span class="meta__value">${htmlEscape(issuedLabel)}</span>
    </div>
  </div>

  <h2>פירוט התשלומים</h2>
  <table>
    <thead>
      <tr>
        <th>תאריך</th>
        <th>אמצעי</th>
        <th class="num">סכום</th>
        <th>הערה</th>
      </tr>
    </thead>
    <tbody>${paymentsRows}</tbody>
  </table>

  <div class="total">
    <span>סה״כ שולם</span>
    <span>${htmlEscape(fmtILS(receipt.totalAmount))}</span>
  </div>

  ${receipt.notes ? `<div class="notes">${htmlEscape(receipt.notes)}</div>` : ''}

  ${paymentMethods}

  <div class="footer">תודה על תשלום בזמן</div>

  <div class="actions">
    <button class="btn" onclick="window.close()">סגור</button>
    <button class="btn btn--primary" onclick="window.print()">הדפס / שמור כ-PDF</button>
  </div>

  <script>
    window.addEventListener('load', function () {
      setTimeout(function () { try { window.print(); } catch (e) {} }, 300);
    });
  </script>
</body>
</html>`;
}
