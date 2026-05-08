// Shared monthly-report logic — used by both the admin-triggered endpoint
// and the cron-triggered endpoint.

import { sendBatchEmail, emailEnabled, emailFooter } from './email.js';
import { logAudit } from './audit.js';

const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

export async function generateAndSendMonthlyReport(env, request, { year, month, triggeredBy = 'manual', userLabel = 'מנהל' }) {
  if (!emailEnabled(env)) {
    throw new Error('שירות האימייל לא הוגדר');
  }
  // Default: previous calendar month
  if (!year || !month) {
    const prev = new Date(Date.now());
    prev.setDate(1);
    prev.setMonth(prev.getMonth() - 1);
    year = prev.getFullYear();
    month = prev.getMonth() + 1;
  }
  if (month < 1 || month > 12 || year < 2020) throw new Error('תקופה לא תקפה');

  const data = await buildReportData(env.DB, year, month);
  const recipients = await env.DB.prepare('SELECT email FROM apartment_email').all()
    .then(r => (r.results || []).map(x => x.email));
  if (!recipients.length) throw new Error('אין דיירים שרשומים לקבלת מיילים');

  const subjectPrefix = await env.DB.prepare("SELECT value FROM settings WHERE key = 'email_subject_prefix'").first()
    .then(r => r?.value || '').catch(() => '');
  const subject = subjectPrefix
    ? `${subjectPrefix} דוח חודשי · ${HE_MONTHS[month - 1]} ${year}`
    : `[${data.buildingName}] דוח חודשי · ${HE_MONTHS[month - 1]} ${year}`;

  const html = renderReportHtml(data);
  const messages = recipients.map(to => ({ to, subject, html }));

  let sent = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    await sendBatchEmail(env, chunk);
    sent += chunk.length;
  }

  await logAudit(env.DB, request, {
    event: 'monthly_report_sent',
    role: 'admin',
    userLabel,
    meta: { year, month, count: sent, triggeredBy },
    success: true,
  });

  return { ok: true, sent, year, month };
}

// ----- Build the report dataset -----

async function buildReportData(db, year, month) {
  const settingsRows = await db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const sr of settingsRows.results) settings[sr.key] = sr.value;

  const apts = await db.prepare(
    `SELECT id, number, owner FROM apartments ORDER BY CAST(number AS INTEGER), number`
  ).all().then(r => r.results || []);

  const monthlyPayments = await db.prepare(
    `SELECT apartment_id AS apartmentId, SUM(amount) AS total
       FROM payments WHERE year = ? AND month = ? GROUP BY apartment_id`
  ).bind(year, month).all().then(r => r.results || []);

  const adjustmentPayments = await db.prepare(
    `SELECT ap.amount, aa.apartment_id AS apartmentId
       FROM adjustment_payments ap
       JOIN apartment_adjustments aa ON aa.id = ap.adjustment_id
      WHERE substr(ap.paid_on, 1, 7) = ?`
  ).bind(`${year}-${String(month).padStart(2, '0')}`).all().then(r => r.results || []);

  const paidByApt = new Map();
  for (const p of monthlyPayments) {
    paidByApt.set(p.apartmentId, (paidByApt.get(p.apartmentId) || 0) + Number(p.total || 0));
  }
  for (const p of adjustmentPayments) {
    paidByApt.set(p.apartmentId, (paidByApt.get(p.apartmentId) || 0) + Number(p.amount || 0));
  }
  const totalIncome = [...paidByApt.values()].reduce((a, b) => a + b, 0);

  const expensePayments = await db.prepare(
    `SELECT SUM(amount) AS total FROM expense_payments WHERE year = ? AND month = ?`
  ).bind(year, month).first();
  const totalExpenses = Number(expensePayments?.total || 0);

  const targetDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const feeRow = await db.prepare(
    `SELECT amount FROM monthly_fee_history WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1`
  ).bind(targetDate).first();
  const cntRow = await db.prepare(
    `SELECT count FROM apartment_count_history WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1`
  ).bind(targetDate).first();
  const globalFee = Number(feeRow?.amount || 0);
  const cnt = Number(cntRow?.count || 0);
  // Per-apartment overrides for this month replace the global fee for those
  // specific apartments. Sum: (overridden apt fees) + (remaining apartments × global fee).
  const overrides = await db.prepare(
    `SELECT amount FROM apartment_monthly_fee_overrides WHERE year = ? AND month = ?`
  ).bind(year, month).all().then(r => r.results || []);
  const overrideSum = overrides.reduce((s, o) => s + Number(o.amount || 0), 0);
  const expectedIncome = overrideSum + Math.max(0, cnt - overrides.length) * globalFee;

  const expenseDetails = await db.prepare(
    `SELECT e.name, e.category, ep.amount, ep.paid_on AS paidOn
       FROM expense_payments ep
       JOIN expenses e ON e.id = ep.expense_id
      WHERE ep.year = ? AND ep.month = ?
      ORDER BY ep.paid_on DESC, ep.id`
  ).bind(year, month).all().then(r => r.results || []);

  return {
    buildingName: settings.building_name || 'ועד הבית',
    buildingAddress: settings.building_address || '',
    bankInfo: { name: settings.bank_name, branch: settings.bank_branch, account: settings.bank_account_number, holder: settings.bank_account_holder, iban: settings.bank_iban },
    bitInfo: { phone: settings.bit_phone, holder: settings.bit_holder },
    payboxInfo: { phone: settings.paybox_phone, holder: settings.paybox_holder, link: settings.paybox_link },
    year, month,
    monthLabel: `${HE_MONTHS[month - 1]} ${year}`,
    totalIncome,
    totalExpenses,
    expectedIncome,
    expenseDetails,
    apartments: apts.map(a => ({ number: a.number, owner: a.owner, paid: paidByApt.get(a.id) || 0 })),
  };
}

// ----- Render HTML email -----

function renderReportHtml(d) {
  const fmt = (n) => new Intl.NumberFormat('he-IL', { style: 'currency', currency: 'ILS', maximumFractionDigits: 0 }).format(Number(n) || 0);
  const balance = d.totalIncome - d.totalExpenses;
  const collectionPct = d.expectedIncome > 0 ? Math.round((d.totalIncome / d.expectedIncome) * 100) : 0;

  const expenseRows = d.expenseDetails.map(e => `
    <tr>
      <td style="padding:6px;border-bottom:1px solid #e2e8f0">${esc(e.name)}</td>
      <td style="padding:6px;border-bottom:1px solid #e2e8f0;color:#64748b">${esc(e.category || '—')}</td>
      <td style="padding:6px;border-bottom:1px solid #e2e8f0;text-align:end;font-weight:600">${esc(fmt(e.amount))}</td>
    </tr>
  `).join('');

  const aptRows = d.apartments.map(a => `
    <tr>
      <td style="padding:6px;border-bottom:1px solid #e2e8f0">${esc(String(a.number))}${a.owner ? ` <span style="color:#64748b">· ${esc(a.owner)}</span>` : ''}</td>
      <td style="padding:6px;border-bottom:1px solid #e2e8f0;text-align:end;font-weight:600;color:${a.paid > 0 ? '#15803d' : '#64748b'}">${esc(fmt(a.paid))}</td>
    </tr>
  `).join('');

  const paymentMethodsBlock = renderPaymentMethods(d);

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<body style="margin:0;padding:24px;background:#f4f6fb;font-family:'Heebo',system-ui,sans-serif;color:#1f2937;direction:rtl;text-align:right">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06)">
    <div style="background:linear-gradient(135deg,#1f4068,#2c5485);color:#fff;padding:24px">
      <div style="font-size:13px;opacity:0.85">דוח חודשי</div>
      <h1 style="margin:4px 0 0;font-size:22px;font-weight:700">${esc(d.buildingName)}</h1>
      <div style="font-size:14px;margin-top:4px;opacity:0.95">${esc(d.monthLabel)}</div>
    </div>
    <div style="padding:24px">
      <table style="width:100%;border-collapse:collapse;margin-bottom:18px">
        <tr>
          <td style="padding:10px 14px;background:#ecfdf5;border-radius:8px;width:48%">
            <div style="font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:0.05em">הכנסות (בפועל)</div>
            <div style="font-size:22px;font-weight:700;color:#15803d;margin-top:4px">${esc(fmt(d.totalIncome))}</div>
            <div style="font-size:12px;color:#64748b;margin-top:2px">צפי: ${esc(fmt(d.expectedIncome))} · גביה ${collectionPct}%</div>
          </td>
          <td style="width:8px"></td>
          <td style="padding:10px 14px;background:#fef2f2;border-radius:8px">
            <div style="font-size:11px;color:#475569;text-transform:uppercase;letter-spacing:0.05em">הוצאות (בפועל)</div>
            <div style="font-size:22px;font-weight:700;color:#a4271f;margin-top:4px">${esc(fmt(d.totalExpenses))}</div>
          </td>
        </tr>
      </table>

      <div style="margin-bottom:18px;padding:14px;background:${balance >= 0 ? '#f0f9ff' : '#fef2f2'};border:1px solid ${balance >= 0 ? '#bae6fd' : '#fecaca'};border-radius:8px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-weight:600;color:#1f4068">מאזן החודש</span>
        <span style="font-size:20px;font-weight:700;color:${balance >= 0 ? '#15803d' : '#a4271f'}">${esc(fmt(balance))}</span>
      </div>

      ${aptRows ? `
        <h2 style="font-size:15px;color:#1f4068;border-bottom:1px solid #e2e8f0;padding-bottom:6px;margin:20px 0 10px">תשלומי דירות</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr><th style="text-align:start;padding:6px;background:#f1f5f9;color:#475569">דירה</th><th style="text-align:end;padding:6px;background:#f1f5f9;color:#475569">שולם</th></tr></thead>
          <tbody>${aptRows}</tbody>
        </table>
      ` : ''}

      ${expenseRows ? `
        <h2 style="font-size:15px;color:#1f4068;border-bottom:1px solid #e2e8f0;padding-bottom:6px;margin:20px 0 10px">הוצאות החודש</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr><th style="text-align:start;padding:6px;background:#f1f5f9;color:#475569">שם</th><th style="text-align:start;padding:6px;background:#f1f5f9;color:#475569">קטגוריה</th><th style="text-align:end;padding:6px;background:#f1f5f9;color:#475569">סכום</th></tr></thead>
          <tbody>${expenseRows}</tbody>
        </table>
      ` : ''}

      ${paymentMethodsBlock}

      ${emailFooter(d.buildingName)}
    </div>
  </div>
</body>
</html>`;
}

function renderPaymentMethods(d) {
  const lines = [];
  if (d.bankInfo.name || d.bankInfo.account) {
    lines.push(`<strong>בנק:</strong> ${esc([d.bankInfo.name, d.bankInfo.branch, d.bankInfo.account].filter(Boolean).join(' · '))}${d.bankInfo.holder ? ' · ' + esc(d.bankInfo.holder) : ''}`);
  }
  if (d.bitInfo.phone) {
    lines.push(`<strong>ביט:</strong> ${esc(d.bitInfo.phone)}${d.bitInfo.holder ? ' · ' + esc(d.bitInfo.holder) : ''}`);
  }
  if (d.payboxInfo.phone || d.payboxInfo.link) {
    let line = `<strong>פייבוקס:</strong> `;
    if (d.payboxInfo.phone) line += esc(d.payboxInfo.phone);
    if (d.payboxInfo.link) line += ` · <a href="${esc(d.payboxInfo.link)}" style="color:#1f4068">קישור לקבוצה</a>`;
    lines.push(line);
  }
  if (!lines.length) return '';
  return `
    <div style="margin-top:22px;padding:14px;background:#fafbfc;border:1px solid #e2e8f0;border-radius:8px">
      <h3 style="margin:0 0 8px;font-size:13px;color:#475569;font-weight:600">אופן תשלום</h3>
      ${lines.map(l => `<div style="font-size:13px;padding:3px 0">${l}</div>`).join('')}
    </div>
  `;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
