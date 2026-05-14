# ארכיטקטורה ומבנה הפרויקט

[← חזרה ל-README](../../README.he.md) · [English](../architecture.md)

## דיאגרמה

```
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare Pages — אתר סטטי (Frontend)                     │
│  ./public/  · vanilla JS, RTL/LTR מודע, i18n                │
└──────────────────┬──────────────────────────────────────────┘
                   │  fetch /api/*  (cookie session)
┌──────────────────▼──────────────────────────────────────────┐
│  Cloudflare Pages Functions  ./functions/api/                │
│  • auth (login, logout, change-password, reset-apartment)    │
│  • CRUD (apartments, payments, expenses, contacts, audit)    │
│  • adjustments + adjustment-payments (חיובים פר דירה)        │
│  • הוצאות תשתיתיות + דרישות + תשלומים                          │
│  • reminders, vaad-members, receipts                         │
│  • פניות (tickets) + תגובות + תמונות מצורפות                  │
│  • documents (proxy ל-Google Drive)                          │
│  • drive (OAuth init / callback / status / disconnect)       │
│  • OAuth זהות (שחזור + כניסה עם Google)                       │
└──────┬───────────────────────────────┬──────────────────────┘
       │          ┌──────────┼──────────┬──────────┐
       │          │          │          │          │
┌──────▼───────┐ ┌▼────────┐┌▼────────┐┌▼────────┐┌▼─────────────┐
│ Cloudflare   │ │ D1 BLOBs ││ R2       ││ Backblaze││ Google Drive │
│ D1 (SQLite)  │ │ טבלה:    ││ bucket:  ││ B2       ││ (חשבון מנהל) │
│ • טבלאות אפ׳ │ │ document_││ vaad-docs││ bucket   ││ תיקייה:      │
│ • sessions   │ │ d1_blobs ││          ││ דרך API  ││ vaad-docs    │
│ • audit log  │ │          ││ binding: ││ נטיב +   ││              │
│ • PBKDF2     │ │ ברירת    ││ DOCS_    ││ מפתחות   ││ OAuth:       │
│ • סודות      │ │ מחדל     ││ BUCKET   ││ מוצפנים  ││ drive.file   │
│   מוצפנים    │ │ ~5MB     ││ 10GB     ││ 10GB     ││ טוקן מוצפן   │
│              │ │ פר קובץ  ││ חינם     ││ חינם     ││ ב-D1         │
└──────────────┘ └──────────┘└──────────┘└──────────┘└──────────────┘
```

**אחסון מסמכים** הוא **ארבעה backends**. העלאות חדשות הולכות לספק שהמנהל בחר (ברירת מחדל: **D1** — ללא צורך בהגדרה ובלי כרטיס אשראי). כל שורה בטבלת `documents` משויכת לשורה ב-`document_storage` (או ל-`document_d1_blobs` עבור D1) שמציינת באיזה backend הקובץ נמצא — כך שהורדות ומחיקות מנותבות למקום הנכון בלי תלות באיזה ספק היה פעיל בזמן ההעלאה. החלפת ספקים בהגדרות משפיעה רק על העלאות *עתידיות*; מסמכים ישנים נשארים היכן שהם. **Backblaze B2** משתמש ב-API הנטיב של B2 (auth → get_upload_url → upload; אין צורך ב-SigV4 ב-Worker); ה-credentials נשמרים מוצפנים תחת AES-GCM הנגזר מ-`SESSION_SECRET`, לא ניתן לקריאה אחורה.

## הרשאות

יש שלוש רמות שמתבטאות בשדה `sessions.role` בצד השרת. ההרשאה **מחושבת מחדש בכל בקשה** מתוך טבלת `apartment_admins` — מתן או ביטול הרשאת מנהל לדירה נכנס לתוקף מיידית עבור session פעיל, בלי צורך ב-re-login.

- **מנהל ראשי** — נכנס עם סיסמת המנהל הכללית (ברירת מחדל `1234` בהתקנה הראשונה). גישה מלאה לכל המערכת.
- **דירה-מנהלת** — דירה שמנהל קיים סימן כמנהלת (הגדרות → סיסמאות דיירים → "הפוך למנהל"). נכנסת עם הסיסמה הרגילה של הדירה ומקבלת אותן הרשאות כמו המנהל הראשי. ההרשאה חלה גם על session של בעל הדירה (אם הדירה בבעלות) וגם על session של שוכר.
- **דייר** — גישת קריאה בלבד לדשבורד, הכנסות, הוצאות, דוחות, אודות, ואפשרות להוריד קבלות לדירה שלו. הדייר יכול לשנות את הסיסמה שלו אבל לא לעדכן שום נתון.

כל endpoint כתיבה דורש `requireAdmin` בצד השרת. דייר שמנסה לקרוא להם יקבל `403 — אין הרשאה`.

## למה דירות-מנהלות אינן "אותו משתמש" כמו המנהל הראשי

- **המנהל הראשי** הוא login נפרד (טאב Admin) שמגובה ב-row יחיד ב-`admin_auth`.
- **דירות-מנהלות** הן משתמשי דירה רגילים (login דרך טאב Tenant) שדירתם סומנה כמנהלת ב-`apartment_admins`. יש להם הרשאות מנהל בממשק, אבל ה**זהות שלהם היא הדירה**: הסיסמה ב-`apartments.password_hash`, ה-recovery ב-`apartment_recovery`, וה-session שלהם עם `apartmentId`.
- דירה-מנהלת **לא יכולה** לסובב את סיסמת המנהל הראשי (ה-`change-password` endpoint אוכף את זה — `kind=admin` דורש session ללא `apartmentId`).
- המנהל הראשי **כן יכול** לאפס סיסמה של כל דירה ממסך הניהול של הדירות.

## בעלים / שוכר / בעל דירה first-class

כל דירה מסומנת כ-**בעלים גר בדירה** או **מושכרת**:

- **בעלים גר בדירה** — הבעלים מתגוררים בדירה. הם נכנסים דרך login של בעל דירה בלבד; אין login נפרד של שוכר.
- **מושכרת** — השוכר נכנס דרך dropdown הדירות. בעל הדירה נכנס בנפרד דרך login של בעל דירה, עם סיסמה משלו וחשבון Google משלו לשחזור. גם השוכר וגם הבעלים מקבלים אותן הרשאות צפייה בדיוק.

הבעלים הם entities first-class (טבלת `owners`) עם קישור לדירות דרך `apartment_owner_link` (row אחד לדירה). בעלים אחד יכול להחזיק כמה דירות. כשדירה בבעלות בעלים כלשהו מקבלת הרשאת מנהל-דירה, ה-session של אותו בעלים יורש את ההרשאות.

## מבנה הפרויקט

```
vaad/
├── public/                        # frontend סטטי שמתפרס ל-Pages
│   ├── index.html
│   └── assets/
│       ├── css/
│       └── js/
│           ├── i18n.js            # מילוני EN + HE, attribute dir
│           ├── app.js             # bootstrap & routing
│           ├── api.js             # fetch wrapper + cache
│           ├── store.js           # state cache & mutators
│           ├── ui.js              # מעטפת, modal, toast, מתג שפה, פעמון
│           ├── utils.js           # פורמטרים, תאריכים, esc
│           ├── calc.js            # חשבונאות / תזרים
│           ├── password.js        # validator מדיניות סיסמה בצד הלקוח
│           └── views/             # dashboard, apartments, expenses, reminders,
│                                  # about, receipt, reports, settings, …
├── functions/                     # Cloudflare Pages Functions
│   ├── _middleware.js             # security headers + CSP + ניקוי sessions
│   ├── lib/                       # crypto, session, audit, util, guard, drive,
│   │                              # password-stash, identity-oauth, admin2fa
│   └── api/
│       ├── auth/                  # login, logout, me, change-password,
│       │                          # reset-apartment, identity-init/callback,
│       │                          # oauth-login-init, 2fa-*
│       ├── drive/                 # auth-init, auth-callback, status, disconnect
│       ├── settings/              # count-history, fee-history
│       ├── documents/             # proxy upload/download/delete דרך Drive
│       ├── admin/                 # reset, bulk-reset-passwords
│       └── *.js                   # apartments, owners, payments, expenses,
│                                  # contacts, apartment-adjustments,
│                                  # adjustment-payments, infrastructure-*,
│                                  # reminders, receipts, vaad-members,
│                                  # apartment-admin, audit, …
├── docs/                          # התיעוד הזה
├── schema.sql                     # סכימה D1 — idempotent מלא
├── wrangler.example.toml / wrangler.toml          # עותק מקומי מוחרג ב-gitignore
├── worker/                        # Worker אופציונלי לדוח חודשי
├── package.example.json / package.json            # עותק מקומי מוחרג ב-gitignore
└── README.md / README.he.md
```
