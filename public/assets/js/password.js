// Shared password policy + real-time validator UI helper. Mirrors
// functions/lib/crypto.js's validatePassword so the rules stay in lockstep
// between client and server. The backend is the source of truth — this is
// just the live UX feedback.

export const PASSWORD_RULES = {
  minLength: 8,
};

export function validatePassword(pw) {
  const s = String(pw || '');
  const r = {
    length: s.length >= PASSWORD_RULES.minLength,
    upper:  /[A-Z]/.test(s),
    lower:  /[a-z]/.test(s),
    digit:  /\d/.test(s),
    symbol: /[^A-Za-z0-9]/.test(s),
  };
  r.ok = r.length && r.upper && r.lower && r.digit && r.symbol;
  return r;
}

// Build the validator block via DOM API (no innerHTML — input never reaches
// the DOM as text since validatePassword only returns booleans). `tFn` is
// the i18n `t` function passed in to avoid a circular import.
function buildValidatorBlock(pw, tFn) {
  const v = validatePassword(pw);
  const ul = document.createElement('ul');
  ul.style.listStyle = 'none';
  ul.style.padding = '0';
  ul.style.margin = '6px 0 0';
  ul.style.fontSize = '12px';
  const rules = [
    [v.length, 'pw.rule.length'],
    [v.upper,  'pw.rule.upper'],
    [v.lower,  'pw.rule.lower'],
    [v.digit,  'pw.rule.digit'],
    [v.symbol, 'pw.rule.symbol'],
  ];
  for (const [ok, key] of rules) {
    const li = document.createElement('li');
    li.style.display = 'flex';
    li.style.gap = '6px';
    li.style.alignItems = 'baseline';
    li.style.lineHeight = '1.6';
    const icon = document.createElement('span');
    icon.style.display = 'inline-block';
    icon.style.width = '14px';
    icon.style.textAlign = 'center';
    icon.style.color = ok ? 'var(--c-success)' : 'var(--c-text-muted)';
    icon.textContent = ok ? '✓' : '○';
    const label = document.createElement('span');
    label.style.color = ok ? 'var(--c-text)' : 'var(--c-text-muted)';
    label.textContent = tFn(key);
    li.appendChild(icon);
    li.appendChild(label);
    ul.appendChild(li);
  }
  return ul;
}

// Wire a live validator: on input, re-render the validator block in `targetEl`
// using the current value of `inputEl`. Returns a function that detaches the
// listener.
export function wireLiveValidator(inputEl, targetEl, tFn, onChange) {
  if (!inputEl || !targetEl) return () => {};
  const update = () => {
    targetEl.textContent = '';
    targetEl.appendChild(buildValidatorBlock(inputEl.value, tFn));
    if (onChange) onChange(validatePassword(inputEl.value));
  };
  inputEl.addEventListener('input', update);
  update();
  return () => inputEl.removeEventListener('input', update);
}
