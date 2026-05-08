// Login screen — admin or apartment-resident with first-time password setup.

import { api, refreshSession, refreshAll } from '../api.js';
import { esc } from '../utils.js';
import { setHTML, toast, openModal } from '../ui.js';
import { t, getLanguage, setLanguage } from '../i18n.js';

export async function renderLogin(onSuccess) {
  const root = document.getElementById('app');

  // If the user landed via a password-reset email link (?reset=TOKEN),
  // hand off to the reset-password screen instead of normal login.
  const resetToken = new URLSearchParams(location.search).get('reset');
  if (resetToken) {
    return renderResetForm(root, resetToken, onSuccess);
  }

  let apts = [];
  try {
    const r = await fetch('/api/apartments-public', { credentials: 'same-origin' });
    if (r.ok) apts = (await r.json()).apartments || [];
  } catch { /* ignore */ }

  const lang = getLanguage();

  setHTML(root, `
    <div class="auth-screen">
      <section class="auth-side">
        <div class="auth-side__brand">
          <div class="auth-side__brand-mark">${esc(t('app.brand.short'))}</div>
          <div>${esc(t('app.title'))}</div>
        </div>
        <div class="auth-side__hero">
          <h1>${esc(t('login.hero.title'))}</h1>
          <p>${esc(t('login.hero.text'))}</p>
          <div class="auth-side__features">
            <div class="auth-side__feature"><span class="auth-side__feature-dot">₪</span> ${esc(t('login.feature.tracking'))}</div>
            <div class="auth-side__feature"><span class="auth-side__feature-dot">⚖</span> ${esc(t('login.feature.cashflow'))}</div>
            <div class="auth-side__feature"><span class="auth-side__feature-dot">📊</span> ${esc(t('login.feature.reports'))}</div>
            <div class="auth-side__feature"><span class="auth-side__feature-dot">🔒</span> ${esc(t('login.feature.privacy'))}</div>
          </div>
        </div>
        <div class="auth-side__footer">${esc(t('app.footer'))}</div>
      </section>

      <section class="auth-form-wrap">
        <form class="auth-form card" id="auth-form" autocomplete="off">
          <div class="hstack" style="justify-content:flex-end; margin-bottom:6px">
            <div class="segmented" id="lang-toggle" style="padding:2px">
              <button type="button" class="segmented__opt ${lang === 'he' ? 'segmented__opt--active' : ''}" data-lang="he" style="padding:4px 10px; font-size:12px">עברית</button>
              <button type="button" class="segmented__opt ${lang === 'en' ? 'segmented__opt--active' : ''}" data-lang="en" style="padding:4px 10px; font-size:12px">EN</button>
            </div>
          </div>
          <h2>${esc(t('login.welcome'))}</h2>
          <p class="auth-form__sub">${esc(t('login.subtitle'))}</p>

          <div class="segmented" style="display:flex; width:100%; margin-bottom:18px">
            <button type="button" class="segmented__opt segmented__opt--active" data-role="tenant" style="flex:1">${esc(t('login.tenant'))}</button>
            <button type="button" class="segmented__opt" data-role="admin" style="flex:1">${esc(t('login.admin'))}</button>
          </div>

          <div id="role-fields"></div>

          <button class="btn btn--primary btn--block" type="submit" id="auth-submit">${esc(t('login.submit'))}</button>

          <div style="margin-top:20px; padding-top:16px; border-top:1px solid var(--c-border); font-size:12px; color:var(--c-text-muted); line-height:1.7">
            <strong>${esc(t('login.about'))}:</strong> ${esc(t('login.aboutText'))}
          </div>
        </form>
      </section>
    </div>
  `);

  // Wire language toggle on login screen
  document.querySelectorAll('#lang-toggle [data-lang]').forEach(b => b.addEventListener('click', () => {
    setLanguage(b.dataset.lang);
    renderLogin(onSuccess);
  }));

  const fieldsEl = document.getElementById('role-fields');
  const submitBtn = document.getElementById('auth-submit');
  let role = 'tenant';

  const renderFields = () => {
    if (role === 'admin') {
      setHTML(fieldsEl, `
        <div class="field field--required">
          <label class="field__label" for="admin-pass">${esc(t('login.adminPassword'))}</label>
          <input class="input" id="admin-pass" name="admin-pass" type="password" autocomplete="current-password" required />
          <div class="field__hint">${t('login.adminHint')}</div>
        </div>
        <div style="text-align:end; margin-top:-8px; margin-bottom:8px">
          <button type="button" id="forgot-pwd-link" class="btn btn--ghost" style="font-size:12px; padding:4px 8px">${esc(t('login.forgotPassword'))}</button>
        </div>
      `);
      setTimeout(() => fieldsEl.querySelector('#admin-pass')?.focus(), 30);
      fieldsEl.querySelector('#forgot-pwd-link')?.addEventListener('click', () => openForgotPasswordDialog());
    } else {
      if (!apts.length) {
        setHTML(fieldsEl, `<div class="callout callout--warning">${esc(t('login.noApts'))}</div>`);
        return;
      }
      setHTML(fieldsEl, `
        <div class="field field--required">
          <label class="field__label">${esc(t('login.selectApt'))}</label>
          <select class="select" id="apt-select" required>
            <option value="">${esc(t('login.chooseApt'))}</option>
            ${apts.map(a => `<option value="${a.id}" data-has-pwd="${a.hasPassword ? 1 : 0}">${esc(t('login.aptOption', { number: a.number }))}${a.owner ? ` · ${esc(a.owner)}` : ''}${a.hasPassword ? '' : ` (${esc(t('login.firstSetup'))})`}</option>`).join('')}
          </select>
        </div>
        <div id="pwd-fields"></div>
      `);
      const sel = fieldsEl.querySelector('#apt-select');
      const pwdFields = fieldsEl.querySelector('#pwd-fields');
      const renderPwd = () => {
        const apt = apts.find(a => a.id === sel.value);
        if (!apt) { setHTML(pwdFields, ''); return; }
        if (!apt.hasPassword) {
          setHTML(pwdFields, `
            <div class="callout">${esc(t('login.firstHint', { number: apt.number }))}</div>
            <div class="field field--required">
              <label class="field__label">${esc(t('login.choosePassword'))}</label>
              <input class="input" id="np1" type="password" autocomplete="new-password" required minlength="4" />
            </div>
            <div class="field field--required">
              <label class="field__label">${esc(t('login.confirmPassword'))}</label>
              <input class="input" id="np2" type="password" autocomplete="new-password" required minlength="4" />
            </div>
            <div class="field" style="margin-top:14px; padding-top:12px; border-top:1px solid var(--c-border)">
              <label class="field__label">${esc(t('login.email.label'))}</label>
              <input class="input" id="first-login-email" type="email" autocomplete="email" placeholder="you@example.com" />
              <div class="field__hint">${esc(t('login.email.hint'))}</div>
            </div>
            <label class="checkbox" style="font-size:12px; color:var(--c-text-muted)">
              <input type="checkbox" id="first-login-email-consent" />
              <span>${esc(t('login.email.consent'))}</span>
            </label>
          `);
          setTimeout(() => pwdFields.querySelector('#np1')?.focus(), 30);
        } else {
          setHTML(pwdFields, `
            <div class="field field--required">
              <label class="field__label">${esc(t('login.password'))}</label>
              <input class="input" id="ap" type="password" autocomplete="current-password" required />
              <div class="field__hint">${esc(t('login.forgot'))}</div>
            </div>
          `);
          setTimeout(() => pwdFields.querySelector('#ap')?.focus(), 30);
        }
      };
      sel.addEventListener('change', renderPwd);
      renderPwd();
    }
  };

  // When 2FA is enabled for admin, the first POST returns requires2FA=true.
  // We then re-render the field set as a TOTP input and submit the same
  // password + code together. State held here for the second POST.
  let pending2FA = null;   // { password } when 2FA prompt is showing

  document.querySelectorAll('[data-role]').forEach(btn => btn.addEventListener('click', () => {
    role = btn.dataset.role;
    pending2FA = null;     // cancel any in-progress 2FA challenge on role change
    document.querySelectorAll('[data-role]').forEach(b => b.classList.toggle('segmented__opt--active', b.dataset.role === role));
    renderFields();
  }));
  renderFields();

  const showAdminTotpStep = () => {
    setHTML(fieldsEl, `
      <div class="callout">${esc(t('login.totp.hint'))}</div>
      <div class="field field--required">
        <label class="field__label">${esc(t('login.totp.codeLabel'))}</label>
        <input class="input" id="admin-totp" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" required style="font-family:monospace; letter-spacing:6px; font-size:18px; text-align:center" />
        <div class="field__hint">${esc(t('login.totp.backupHint'))}</div>
      </div>
    `);
    setTimeout(() => fieldsEl.querySelector('#admin-totp')?.focus(), 30);
  };

  document.getElementById('auth-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submitBtn.disabled = true;
    try {
      if (role === 'admin') {
        if (pending2FA) {
          const code = fieldsEl.querySelector('#admin-totp')?.value || '';
          await api.login({ mode: 'admin', password: pending2FA.password, totpCode: code });
          pending2FA = null;
        } else {
          const pwd = fieldsEl.querySelector('#admin-pass')?.value || '';
          try {
            await api.login({ mode: 'admin', password: pwd });
          } catch (err) {
            if (err?.data?.requires2FA) {
              pending2FA = { password: pwd };
              showAdminTotpStep();
              return;
            }
            throw err;
          }
        }
      } else {
        const aptId = fieldsEl.querySelector('#apt-select')?.value;
        if (!aptId) { toast(t('login.selectAptFirst'), 'warning'); return; }
        const apt = apts.find(a => a.id === aptId);
        if (!apt.hasPassword) {
          const p1 = fieldsEl.querySelector('#np1')?.value || '';
          const p2 = fieldsEl.querySelector('#np2')?.value || '';
          if (p1.length < 4) { toast(t('login.passwordTooShort'), 'warning'); return; }
          if (p1 !== p2) { toast(t('login.passwordsDontMatch'), 'warning'); return; }
          // Optional opt-in email for monthly reports / broadcasts. Only saved
          // when the user actively typed an address; consent is recorded via
          // the checkbox.
          const emailField = fieldsEl.querySelector('#first-login-email');
          const consentField = fieldsEl.querySelector('#first-login-email-consent');
          const optedInEmail = (emailField?.value || '').trim().toLowerCase();
          if (optedInEmail && !consentField?.checked) {
            toast(t('login.email.consentRequired'), 'warning');
            return;
          }
          await api.login({ mode: 'tenant', apartmentId: aptId, newPassword: p1 });
          if (optedInEmail) {
            try { await api.setApartmentEmail(aptId, optedInEmail); }
            catch (err) { /* non-fatal: account is created, email is optional */ }
          }
        } else {
          const pwd = fieldsEl.querySelector('#ap')?.value || '';
          await api.login({ mode: 'tenant', apartmentId: aptId, password: pwd });
        }
      }
      await refreshSession();
      await refreshAll();
      toast(t('login.success'), 'success');
      onSuccess();
    } catch (err) {
      toast(err.message || t('common.error'), 'danger');
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ----- Forgot password (admin only) -----
// Kicks off a Google OAuth flow with purpose='reset'. The callback verifies
// the signed-in account matches the registered recovery email and then
// redirects to /?reset=<token> to land on the new-password form. No email
// is sent — Google does the verification.
function openForgotPasswordDialog() {
  const m = openModal({
    title: t('login.forgotPassword.title'),
    size: 'md',
    body: `
      <p style="margin-top:0; font-size:14px">${esc(t('login.forgotPassword.intro'))}</p>
      <ul style="font-size:13px; color:var(--c-text-muted); padding-inline-start:20px; line-height:1.7">
        <li>${esc(t('login.forgotPassword.point1'))}</li>
        <li>${esc(t('login.forgotPassword.point2'))}</li>
        <li>${esc(t('login.forgotPassword.point3'))}</li>
      </ul>
    `,
    footer: `
      <button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button>
      <button class="btn btn--primary" data-act="signin">${esc(t('login.forgotPassword.signin'))}</button>
    `,
  });
  m.footerEl.querySelector('[data-act="cancel"]').addEventListener('click', () => m.close());
  m.footerEl.querySelector('[data-act="signin"]').addEventListener('click', async () => {
    const btn = m.footerEl.querySelector('[data-act="signin"]');
    btn.disabled = true;
    try {
      const res = await api.identityInit('reset');
      // Hand off to Google. After successful verification the callback redirects
      // straight to /?reset=<token> on this same origin.
      location.href = res.url;
    } catch (err) {
      if (err.status === 429) {
        toast(err.message || t('common.error'), 'warning');
      } else {
        toast(err.message || t('common.error'), 'danger');
      }
      btn.disabled = false;
    }
  });
}

// ----- Reset password landing (?reset=TOKEN) -----
function renderResetForm(root, token, onSuccess) {
  const lang = getLanguage();
  setHTML(root, `
    <div class="auth-screen">
      <section class="auth-form-wrap" style="grid-column: 1 / -1">
        <form class="auth-form card" id="reset-form" autocomplete="off">
          <div class="hstack" style="justify-content:flex-end; margin-bottom:6px">
            <div class="segmented" id="lang-toggle" style="padding:2px">
              <button type="button" class="segmented__opt ${lang === 'he' ? 'segmented__opt--active' : ''}" data-lang="he" style="padding:4px 10px; font-size:12px">עברית</button>
              <button type="button" class="segmented__opt ${lang === 'en' ? 'segmented__opt--active' : ''}" data-lang="en" style="padding:4px 10px; font-size:12px">EN</button>
            </div>
          </div>
          <h2>${esc(t('login.reset.title'))}</h2>
          <p class="auth-form__sub">${esc(t('login.reset.hint'))}</p>

          <div class="field field--required">
            <label class="field__label">${esc(t('login.choosePassword'))}</label>
            <input class="input" id="rp1" type="password" autocomplete="new-password" required minlength="4" />
          </div>
          <div class="field field--required">
            <label class="field__label">${esc(t('login.confirmPassword'))}</label>
            <input class="input" id="rp2" type="password" autocomplete="new-password" required minlength="4" />
          </div>

          <button class="btn btn--primary btn--block" type="submit" id="reset-submit">${esc(t('login.reset.submit'))}</button>

          <div style="margin-top:14px; text-align:center">
            <a href="/" style="font-size:12px; color:var(--c-text-muted)">${esc(t('login.reset.backToLogin'))}</a>
          </div>
        </form>
      </section>
    </div>
  `);
  document.querySelectorAll('#lang-toggle [data-lang]').forEach(b => b.addEventListener('click', () => {
    setLanguage(b.dataset.lang);
    renderResetForm(root, token, onSuccess);
  }));
  setTimeout(() => document.getElementById('rp1')?.focus(), 30);

  document.getElementById('reset-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const submitBtn = document.getElementById('reset-submit');
    submitBtn.disabled = true;
    try {
      const p1 = document.getElementById('rp1').value;
      const p2 = document.getElementById('rp2').value;
      if (p1.length < 4) { toast(t('login.passwordTooShort'), 'warning'); return; }
      if (p1 !== p2) { toast(t('login.passwordsDontMatch'), 'warning'); return; }
      await api.resetPassword({ token, newPassword: p1 });
      toast(t('login.reset.done'), 'success');
      // Strip the ?reset= query and re-render the regular login screen.
      history.replaceState(null, '', '/');
      renderLogin(onSuccess);
    } catch (err) {
      toast(err.message || t('common.error'), 'danger');
    } finally {
      submitBtn.disabled = false;
    }
  });
}
