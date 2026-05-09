// Login screen — admin or apartment-resident with first-time password setup.

import { api, refreshSession, refreshAll } from '../api.js';
import { esc } from '../utils.js';
import { setHTML, toast, openModal } from '../ui.js';
import { t, getLanguage, setLanguage } from '../i18n.js';
import { wireLiveValidator, validatePassword } from '../password.js';

export async function renderLogin(onSuccess) {
  const root = document.getElementById('app');

  // If the user landed via a password-reset link (?reset=TOKEN[&apt=<id>][&role=owner]),
  // hand off to the reset-password screen instead of normal login.
  // The apt= param scopes the reset to a specific apartment; absent = master admin.
  // The role= param picks the apartment credential set ('owner' or implicitly 'tenant').
  const params = new URLSearchParams(location.search);
  const resetToken = params.get('reset');
  const resetApt = params.get('apt');
  const resetRole = params.get('role');
  if (resetToken) {
    return renderResetForm(root, resetToken, resetApt, resetRole, onSuccess);
  }

  let apts = [];
  let owners = [];
  try {
    const r = await fetch('/api/apartments-public', { credentials: 'same-origin' });
    if (r.ok) apts = (await r.json()).apartments || [];
  } catch { /* ignore */ }
  try {
    const r = await fetch('/api/owners-public', { credentials: 'same-origin' });
    if (r.ok) owners = (await r.json()).owners || [];
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
            <button type="button" class="segmented__opt" data-role="owner" style="flex:1">${esc(t('login.owner'))}</button>
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
        ${googleLoginSectionHTML()}
        <div class="field field--required">
          <label class="field__label" for="admin-pass">${esc(t('login.adminPassword'))}</label>
          <input class="input" id="admin-pass" name="admin-pass" type="password" autocomplete="current-password" required />
          <div class="field__hint">${t('login.adminHint')}</div>
        </div>
        <div style="text-align:end; margin-top:-8px; margin-bottom:8px">
          <button type="button" id="forgot-pwd-link" class="btn btn--ghost" style="font-size:12px; padding:4px 8px">${esc(t('login.forgotPassword'))}</button>
        </div>
      `);
      // Master admin Google button is always enabled — the server will
      // reject if no admin_recovery email is configured (with a clear
      // "no account for this email" page).
      wireGoogleLoginButton(fieldsEl);
      setGoogleButtonState(fieldsEl, 'available');
      setTimeout(() => fieldsEl.querySelector('#admin-pass')?.focus(), 30);
      fieldsEl.querySelector('#forgot-pwd-link')?.addEventListener('click', () => openForgotPasswordDialog());
    } else if (role === 'owner') {
      // First-class owner login (PR E). Mirrors the renter flow: pick the
      // owner from a public dropdown, then password (or "Sign in with Google").
      // The owner's session spans all of their apartments.
      if (!owners.length) {
        setHTML(fieldsEl, `<div class="callout callout--warning">${esc(t('login.owner.noOwners'))}</div>`);
        return;
      }
      setHTML(fieldsEl, `
        ${googleLoginSectionHTML()}
        <div class="field field--required">
          <label class="field__label">${esc(t('login.owner.select'))}</label>
          <select class="select" id="owner-select" required>
            <option value="">${esc(t('login.owner.choose'))}</option>
            ${owners.map(o => {
              // Identify owners by their apartments rather than by name —
              // the dropdown is visible to anyone on the public login screen.
              const apts = (o.apartmentNumbers || []).join(', ');
              const label = apts
                ? t('login.owner.optionByApts', { apts })
                : t('login.owner.optionUnlinked');
              return `<option value="${esc(o.id)}">${esc(label)}</option>`;
            }).join('')}
          </select>
        </div>
        <div id="owner-pwd-fields"></div>
      `);
      wireGoogleLoginButton(fieldsEl);
      setGoogleButtonState(fieldsEl, 'idle');
      const ownerSel = fieldsEl.querySelector('#owner-select');
      const ownerPwdFields = fieldsEl.querySelector('#owner-pwd-fields');
      const renderOwnerPwd = () => {
        const owner = owners.find(o => o.id === ownerSel.value);
        if (!owner) {
          setHTML(ownerPwdFields, '');
          setGoogleButtonState(fieldsEl, 'idle');
          return;
        }
        // Enable the Google button only when this owner has a Google email
        // registered (admin-configured login_email). Otherwise the OAuth
        // callback would never find a match — disable upfront.
        setGoogleButtonState(fieldsEl, owner.hasOauth ? 'available' : 'unavailable');
        if (!owner.hasPassword) {
          setHTML(ownerPwdFields, `<div class="callout callout--warning">${esc(t('login.askAdminForInitial'))}</div>`);
          return;
        }
        setHTML(ownerPwdFields, `
          <div class="field field--required">
            <label class="field__label">${esc(t('login.owner.password'))}</label>
            <input class="input" id="owner-pass" type="password" autocomplete="current-password" required />
          </div>
          <div style="text-align:end; margin-top:-8px; margin-bottom:8px">
            <button type="button" id="forgot-owner-link" class="btn btn--ghost" style="font-size:12px; padding:4px 8px">${esc(t('login.forgotPassword'))}</button>
          </div>
        `);
        setTimeout(() => ownerPwdFields.querySelector('#owner-pass')?.focus(), 30);
        ownerPwdFields.querySelector('#forgot-owner-link')?.addEventListener('click', () => {
          openForgotPasswordDialog({ ownerId: owner.id });
        });
      };
      ownerSel.addEventListener('change', renderOwnerPwd);
      renderOwnerPwd();
    } else {
      if (!apts.length) {
        setHTML(fieldsEl, `<div class="callout callout--warning">${esc(t('login.noApts'))}</div>`);
        return;
      }
      setHTML(fieldsEl, `
        ${googleLoginSectionHTML()}
        <div class="field field--required">
          <label class="field__label">${esc(t('login.selectApt'))}</label>
          <select class="select" id="apt-select" required>
            <option value="">${esc(t('login.chooseApt'))}</option>
            ${apts.map(a => `<option value="${a.id}">${esc(t('login.aptOption', { number: a.number }))}</option>`).join('')}
          </select>
        </div>
        <div id="role-fields-tenant"></div>
        <div id="pwd-fields"></div>
      `);
      wireGoogleLoginButton(fieldsEl);
      setGoogleButtonState(fieldsEl, 'idle');
      const sel = fieldsEl.querySelector('#apt-select');
      const roleFieldsEl = fieldsEl.querySelector('#role-fields-tenant');
      const pwdFields = fieldsEl.querySelector('#pwd-fields');
      let userKind = 'tenant';
      const renderPwd = () => {
        const apt = apts.find(a => a.id === sel.value);
        if (!apt) {
          setHTML(roleFieldsEl, '');
          setHTML(pwdFields, '');
          setGoogleButtonState(fieldsEl, 'idle');
          return;
        }
        // Renter apartments use the tenant's email (apartments.email) for
        // Google OAuth. Enable the button only if it's set; otherwise the
        // callback couldn't match this user to an account.
        setGoogleButtonState(fieldsEl, apt.hasOauth ? 'available' : 'unavailable');

        // Renter apartments offer a userKind toggle (Renter / Owner). Owner-
        // occupied apartments have a single login (the owner is the resident,
        // so no separate "owner" credentials).
        const isRenterApt = apt.occupantType === 'renter';
        if (isRenterApt) {
          setHTML(roleFieldsEl, `
            <div class="field" style="margin-top:6px">
              <div class="segmented" role="radiogroup">
                <label class="segmented__opt ${userKind === 'tenant' ? 'segmented__opt--active' : ''}" data-uk="tenant">
                  <input type="radio" name="userKind" value="tenant" ${userKind === 'tenant' ? 'checked' : ''} style="display:none" />
                  ${esc(t('login.role.renter'))}
                </label>
                <label class="segmented__opt ${userKind === 'owner' ? 'segmented__opt--active' : ''}" data-uk="owner">
                  <input type="radio" name="userKind" value="owner" ${userKind === 'owner' ? 'checked' : ''} style="display:none" />
                  ${esc(t('login.role.owner'))}
                </label>
              </div>
              <div class="field__hint">${esc(t('login.role.hint'))}</div>
            </div>
          `);
          roleFieldsEl.querySelectorAll('[data-uk]').forEach(seg => seg.addEventListener('click', () => {
            userKind = seg.dataset.uk;
            roleFieldsEl.querySelectorAll('.segmented__opt').forEach(s => s.classList.toggle('segmented__opt--active', s.dataset.uk === userKind));
            seg.querySelector('input').checked = true;
            renderPwd();
          }));
        } else {
          setHTML(roleFieldsEl, '');
          userKind = 'tenant';
        }

        // Whether the chosen credential set has a password yet. With PR F,
        // admins always generate a random initial password when creating an
        // apartment/owner — so this branch should only fire for legacy data
        // where the password was never set. We refuse self-setup and tell
        // the user to ask the admin (the admin can regenerate via Settings).
        const hasPwd = userKind === 'owner' ? apt.hasOwnerPassword : apt.hasPassword;

        if (!hasPwd) {
          setHTML(pwdFields, `
            <div class="callout callout--warning">${esc(t('login.askAdminForInitial'))}</div>
          `);
        } else {
          setHTML(pwdFields, `
            <div class="field field--required">
              <label class="field__label">${esc(t(userKind === 'owner' ? 'login.password.owner' : 'login.password'))}</label>
              <input class="input" id="ap" type="password" autocomplete="current-password" required />
            </div>
            <div style="text-align:end; margin-top:-8px; margin-bottom:8px">
              <button type="button" id="forgot-tenant-link" class="btn btn--ghost" style="font-size:12px; padding:4px 8px">${esc(t('login.forgotPassword'))}</button>
            </div>
          `);
          setTimeout(() => pwdFields.querySelector('#ap')?.focus(), 30);
          pwdFields.querySelector('#forgot-tenant-link')?.addEventListener('click', () => {
            const apt = apts.find(a => a.id === sel.value);
            if (apt) openForgotPasswordDialog({ apartment: apt, userKind });
          });
        }
      };
      sel.addEventListener('change', renderPwd);
      renderPwd();
      // Expose current userKind for the submit handler (closes over local `userKind`).
      fieldsEl._getUserKind = () => userKind;
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
      } else if (role === 'owner') {
        // First-class owner — picked from dropdown. Sends ownerId+password.
        // Mirrors the renter flow's apartmentId+password submission.
        const ownerId = fieldsEl.querySelector('#owner-select')?.value;
        if (!ownerId) { toast(t('login.owner.pickRequired'), 'warning'); return; }
        const pwd = fieldsEl.querySelector('#owner-pass')?.value || '';
        await api.login({ mode: 'owner', ownerId, password: pwd });
      } else {
        const aptId = fieldsEl.querySelector('#apt-select')?.value;
        if (!aptId) { toast(t('login.selectAptFirst'), 'warning'); return; }
        const apt = apts.find(a => a.id === aptId);
        const userKind = fieldsEl._getUserKind ? fieldsEl._getUserKind() : 'tenant';
        const hasPwd = userKind === 'owner' ? apt.hasOwnerPassword : apt.hasPassword;
        if (!hasPwd) {
          // Admin must generate the initial password — no self-setup path.
          toast(t('login.askAdminForInitial'), 'warning');
          return;
        }
        const pwd = fieldsEl.querySelector('#ap')?.value || '';
        await api.login({ mode: 'tenant', apartmentId: aptId, password: pwd, userKind });
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

// ----- Forgot password (master admin OR a specific apartment, tenant or owner) -----
// Kicks off a Google OAuth flow with purpose='reset'. The callback verifies
// the signed-in account matches the registered recovery email and then
// redirects to /?reset=<token>[&apt=<id>][&role=owner] to land on the
// new-password form. No email is sent — Google does the verification.
//
// opts.apartment, when provided, scopes the reset to a specific apartment.
// opts.userKind ('tenant' | 'owner') picks which credential set is being
// reset for that apartment. When opts.apartment is absent, scopes to the
// master admin (Admin tab).
function openForgotPasswordDialog(opts = {}) {
  const apartment = opts.apartment || null;
  const ownerId = opts.ownerId || null;
  const userKind = opts.userKind === 'owner' ? 'owner' : 'tenant';
  const titleKey = apartment ? 'login.forgotPassword.title.apt' : 'login.forgotPassword.title';
  const introKey = apartment ? 'login.forgotPassword.intro.apt' : 'login.forgotPassword.intro';
  const subTitle = apartment
    ? t(titleKey, { number: apartment.number, kind: t(userKind === 'owner' ? 'login.role.owner' : 'login.role.renter') })
    : t(titleKey);
  const m = openModal({
    title: subTitle,
    size: 'md',
    body: `
      <p style="margin-top:0; font-size:14px">${esc(t(introKey))}</p>
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
      const res = await api.identityInit('reset', {
        apartmentId: apartment ? apartment.id : null,
        userKind: apartment ? userKind : null,
        ownerId: ownerId || null,
      });
      // Hand off to Google. The callback redirects to /?reset=<token>
      // (with &apt=<id>[&role=owner] for apartments, &owner=<id> for owners).
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

// ----- Reset password landing (?reset=TOKEN[&apt=<id>][&role=owner]) -----
// apartmentId, when present, scopes the reset to that apartment.
// role='owner' selects the owner credential set; otherwise tenant.
// When apartmentId is absent, the master admin password is reset.
function renderResetForm(root, token, apartmentId, role, onSuccess) {
  const lang = getLanguage();
  const userKind = role === 'owner' ? 'owner' : 'tenant';
  const titleKey = apartmentId
    ? (userKind === 'owner' ? 'login.reset.title.owner' : 'login.reset.title.apt')
    : 'login.reset.title';
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
          <h2>${esc(t(titleKey))}</h2>
          <p class="auth-form__sub">${esc(t('login.reset.hint'))}</p>

          <div class="field field--required">
            <label class="field__label">${esc(t('login.choosePassword'))}</label>
            <input class="input" id="rp1" type="password" autocomplete="new-password" required />
            <div id="rp-validator"></div>
          </div>
          <div class="field field--required">
            <label class="field__label">${esc(t('login.confirmPassword'))}</label>
            <input class="input" id="rp2" type="password" autocomplete="new-password" required />
          </div>

          <button class="btn btn--primary btn--block" type="submit" id="reset-submit" disabled>${esc(t('login.reset.submit'))}</button>

          <div style="margin-top:14px; text-align:center">
            <a href="/" style="font-size:12px; color:var(--c-text-muted)">${esc(t('login.reset.backToLogin'))}</a>
          </div>
        </form>
      </section>
    </div>
  `);
  document.querySelectorAll('#lang-toggle [data-lang]').forEach(b => b.addEventListener('click', () => {
    setLanguage(b.dataset.lang);
    renderResetForm(root, token, apartmentId, role, onSuccess);
  }));
  setTimeout(() => document.getElementById('rp1')?.focus(), 30);

  // Wire the live password-policy validator. Submit stays disabled until OK.
  const submitBtn = document.getElementById('reset-submit');
  wireLiveValidator(
    document.getElementById('rp1'),
    document.getElementById('rp-validator'),
    t,
    (v) => { submitBtn.disabled = !v.ok; },
  );

  document.getElementById('reset-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    submitBtn.disabled = true;
    try {
      const p1 = document.getElementById('rp1').value;
      const p2 = document.getElementById('rp2').value;
      if (!validatePassword(p1).ok) { toast(t('pw.policy.failed'), 'warning'); return; }
      if (p1 !== p2) { toast(t('login.passwordsDontMatch'), 'warning'); return; }
      const payload = { token, newPassword: p1 };
      if (apartmentId) payload.apartmentId = apartmentId;
      if (apartmentId && role === 'owner') payload.role = 'owner';
      await api.resetPassword(payload);
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

// ----- Google "Sign in with Google" button -----
// Renders the markup for the OAuth login button (used on Tenant and Owner
// tabs). The button starts DISABLED — user must first pick an apartment or
// owner from the dropdown below. Once a pick is made, the button is enabled
// only if that user has Google OAuth configured (email/login_email set by
// admin). Click handler is attached separately via wireGoogleLoginButton().
function googleLoginSectionHTML() {
  return `
    <div style="margin-bottom:14px">
      <button type="button" id="oauth-google-btn" class="btn btn--block" disabled aria-disabled="true" style="background:#fff; color:#1f1f1f; border:1px solid #dadce0; height:42px; font-weight:500; opacity:0.55; cursor:not-allowed">
        <svg width="18" height="18" viewBox="0 0 48 48" style="display:inline-block; vertical-align:-3px; margin-inline-end:8px">
          <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3c-1.7 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"/>
          <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
          <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.3 0-9.7-3.4-11.3-8l-6.6 5C9.6 39.6 16.2 44 24 44z"/>
          <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.2 5.2c-.4.4 6.6-4.8 6.6-14.7 0-1.3-.1-2.6-.4-3.9z"/>
        </svg>
        ${esc(t('login.oauth.google'))}
      </button>
      <div id="oauth-google-hint" class="muted" style="font-size:11px; text-align:center; margin-top:6px; min-height:1.4em"></div>
      <div class="hstack" style="gap:10px; margin-top:14px; margin-bottom:14px; align-items:center">
        <hr style="flex:1; border:none; border-top:1px solid var(--c-border); margin:0">
        <span class="muted" style="font-size:11px">${esc(t('login.oauth.divider'))}</span>
        <hr style="flex:1; border:none; border-top:1px solid var(--c-border); margin:0">
      </div>
    </div>
  `;
}

// Toggle the Google button's enabled state based on the picked user.
// state = 'idle'      → no selection yet (subtle hint, button disabled)
//       = 'available' → selection has Google OAuth configured (button enabled)
//       = 'unavailable' → selection lacks Google OAuth (button disabled, explanatory hint)
function setGoogleButtonState(scopeEl, state) {
  const btn = scopeEl.querySelector('#oauth-google-btn');
  const hint = scopeEl.querySelector('#oauth-google-hint');
  if (!btn) return;
  const enable = state === 'available';
  btn.disabled = !enable;
  btn.setAttribute('aria-disabled', String(!enable));
  btn.style.opacity = enable ? '1' : '0.55';
  btn.style.cursor = enable ? 'pointer' : 'not-allowed';
  if (hint) {
    hint.textContent = state === 'idle' ? t('login.oauth.pickFirst')
                     : state === 'unavailable' ? t('login.oauth.notLinked')
                     : '';
  }
}

function wireGoogleLoginButton(scopeEl) {
  const btn = scopeEl.querySelector('#oauth-google-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (btn.disabled) return; // Defensive — disabled buttons shouldn't fire,
                              // but guard against keyboard activation edge cases.
    btn.disabled = true;
    try {
      const res = await api.oauthLoginInit();
      // Hand off to Google. After successful match the callback redirects
      // to / with a session cookie set.
      location.href = res.url;
    } catch (err) {
      btn.disabled = false;
      if (err.status === 429) toast(err.message || t('common.error'), 'warning');
      else if (err.status === 412) toast(t('login.oauth.notConfigured'), 'warning');
      else toast(err.message || t('common.error'), 'danger');
    }
  });
}
