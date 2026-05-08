# ועד הבית · Vaad Bayit

[English](./README.md)

מערכת מאובטחת ודו-לשונית (עברית / אנגלית) לניהול ועד בית — מעקב הכנסות והוצאות, דוחות חודשיים ושנתיים, אנשי קשר, מסמכים, תזכורות, וקבלות להדפסה. ממשק עברית-RTL או אנגלית-LTR בלחיצה.

רץ על **Cloudflare** (Pages + Functions + D1) עם מסמכים ב-**Google Drive** של מנהל הוועד. חינם לרוב השימושים.

---

## ארכיטקטורה

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
│  • reminders, vaad-members, receipts                         │
│  • documents (proxy ל-Google Drive)                          │
│  • drive (OAuth init / callback / status / disconnect)       │
└──────┬───────────────────────────────┬──────────────────────┘
       │                               │
┌──────▼──────────────────┐   ┌────────▼──────────────────────┐
│  Cloudflare D1 (SQLite) │   │   Google Drive (של המנהל)     │
│  • טבלאות אפליקציה       │   │   תיקייה: vaad-docs           │
│  • sessions, audit log   │   │   • PDF / תמונות               │
│  • PBKDF2 hashes         │   │   • OAuth scope: drive.file    │
│  • טוקן Drive מוצפן      │   │     (אין גישה לקבצים אחרים)    │
└─────────────────────────┘   └────────────────────────────────┘
```

## פיצ'רים עיקריים

- **דשבורד** — תמונת מצב חודשית/שנתית, גרף 12 חודשים אחרונים, יתרת בנק נוכחית.
- **מעקב הכנסות** — רשת דירות × חודשים עם סטטוס שולם / חלקי / לא שולם, פירוט תשלומים, ותשלומים מול חיובים נספרים כהכנסה. גם הסכום ה**צפוי** וגם ה**שולם** ניתנים לעריכה inline פר תא — שינוי הצפוי לתא בודד (דירה+חודש) זורם אוטומטית לכל חישובי התחזית; badge דלתא בכל שורה מציג חוב או יתרת זכות כשהשולם שונה מהצפוי.
- **הוצאות** — שלושה סוגים (חודשית קבועה, שנתית, חד-פעמית), היסטוריית תעריפים, מסמכים מצורפים, סטטוס מחושב בטיפול / הסתיים.
- **חיובים וזיכויים פר דירה** — רישומים ידניים (חוב מהעבר, החזר וכו׳) שמשפיעים על יתרת החוב בנפרד מדמי הוועד, עם ספר תשלומים משלהם.
- **קבלות** — קבלה להדפסה (PDF דרך דיאלוג ההדפסה של הדפדפן) עם מספר רץ גלובלי יציב. אותה דירה ואותו חודש → אותה קבלה.
- **תזכורות** — תזכורות מתמשכות עם זמן מראש. מופיעות בפעמון בכותרת, במודאל בכניסה, או מקושרות להוצאה ספציפית (חידוש חוזה וכו׳).
- **לשונית אודות** — פרטי בנק להעברות, חברי ועד הבית, וטקסט חופשי. גלויה לדיירים לעיון מהיר.
- **דוחות** — חודשי / שנתי · תזרים בפועל מול תמונה חשבונאית · ייצוא CSV · הדפסה ל-PDF.
- **לוג כניסות (audit)** — כל כניסה, שינוי, החלפת סיסמה ואיפוס — נרשמים עם IP אמיתי של הלקוח.
- **אחסון מסמכים** — העלאות עוברות דרך Pages Functions ל-Google Drive; הדפדפן לא רואה את ה-OAuth token.
- **אימות דו-שלבי (2FA)** — אופציונלי למנהל ראשי. תומך ב-Google Authenticator / Authy / 1Password, כולל קודי גיבוי.
- **התראות מייל** — opt-in לכל דירה. מנהל יכול לשלוח הודעה מותאמת לכל הנרשמים, או דוח חודשי. דרך Resend (חינמי, 3,000 מיילים/חודש).
- **דוח חודשי אוטומטי** — Cloudflare Worker אופציונלי שמפעיל את שליחת הדוח ב-1 בכל חודש.

## שפות

הממשק זמין ב-**עברית** (ברירת מחדל) ו-**אנגלית** עם מתג בכותרת ובמסך הכניסה. כיוון העמוד מתחלף אוטומטית (RTL לעברית, LTR לאנגלית). הבחירה נשמרת ב-localStorage לכל דפדפן. מטבע, תאריכים, מספרים ושמות חודשים נטיים לפי השפה.

## הרשאות

יש שלוש רמות שמתבטאות בשדה `sessions.role` בצד השרת:

- **מנהל ראשי** — נכנס עם סיסמת המנהל הכללית (ברירת מחדל `1234` בהתקנה הראשונה). גישה מלאה לכל המערכת.
- **דירה-מנהלת** — דירה שמנהל קיים סימן כמנהלת (הגדרות → סיסמאות דיירים → "הפוך למנהל"). נכנסת עם הסיסמה הרגילה של הדירה ומקבלת אותן הרשאות כמו המנהל הראשי.
- **דייר** — גישת קריאה בלבד לדשבורד, הכנסות, הוצאות, דוחות, אודות, ואפשרות להוריד קבלות לדירה שלו. הדייר יכול לשנות את הסיסמה שלו אבל לא לעדכן שום נתון.

כל endpoint כתיבה דורש `requireAdmin` בצד השרת. דייר שמנסה לקרוא להם יקבל `403 — אין הרשאה`.

## אבטחה

| שכבה                | מימוש                                                            |
|---------------------|------------------------------------------------------------------|
| הצפנת סיסמאות       | **PBKDF2-SHA256**, 100,000 איטרציות, salt 16 בייטים אקראיים      |
| סשנים               | Cookie `HttpOnly` + `Secure` + `SameSite=Lax`, חתום HMAC, מגובה DB row |
| Rate limiting       | 5 ניסיונות / 5 דקות לפי IP+bucket (מנהל / לכל דירה בנפרד)         |
| כותרות אבטחה        | CSP מחמיר, `X-Frame-Options: DENY`, `Strict-Transport-Security`, `Referrer-Policy` |
| לוג כניסות          | כל ניסיון נרשם עם **IP אמיתי** מ-`CF-Connecting-IP`, User-Agent ושעה |
| אימות צד שרת        | כל endpoint רגיש מאמת session — לא ניתן לעקוף ב-DevTools         |
| Drive OAuth scope   | `drive.file` — האפליקציה מוגבלת רק לקבצים שיצרה ב-`vaad-docs`   |
| טוקן refresh של Drive | מוצפן AES-GCM ב-D1 (מפתח נגזר מ-`SESSION_SECRET`)               |

---

## Placeholders במדריך הזה

הפקודות בהמשך משתמשות ב-placeholders — החלף בערכים שלך:

| Placeholder | מה זה | דוגמה |
|---|---|---|
| `<cf-pages-project>` | שם פרויקט Cloudflare Pages (אתה בוחר בעת פריסה ראשונה) | `building-mgmt` |
| `<your-d1-name>` | שם DB של Cloudflare D1 (אתה בוחר בעת `d1 create`) | `building-mgmt-db` |
| `<cf-cron-worker>` | שם ה-Cloudflare Worker של הקרון החודשי | `building-mgmt-cron` |
| `<path-to-project>` | נתיב מקומי לתיקיית ה-repo שלך | `~/Projects/building-mgmt` |
| `<path-to-cron-worker>` | נתיב מקומי לתיקיית ה-Worker של הקרון (תיקייה אחות) | `~/Projects/building-mgmt-cron` |
| `<cron-worker-dir>` | שם תיקיית ה-Worker של הקרון | `building-mgmt-cron` |
| `<cf-account-subdomain>` | ה-workers.dev subdomain שלך ב-Cloudflare (מודפס בעת פריסת Worker ראשונה) | `your-account-name` |

**המלצה:** השאר את ה-placeholders עקביים לכל אורך ה-session — בחר פעם אחת והשתמש בכל מקום. המדריך מניח שאותו ערך של `<cf-pages-project>` משמש בכל ה-`--project-name=...`.

## קבצי הגדרה: דפוס ה-`.example`

ה-repo משתמש בדפוס **template + עותק מקומי** עבור שלושת הקבצים שמכילים
ערכים ספציפיים לפריסה שלך:

| מה שב-git (תבנית) | העותק המקומי שלך (מוחרג ב-gitignore) |
|---|---|
| `wrangler.example.toml` | `wrangler.toml` |
| `worker/wrangler.example.toml` | `worker/wrangler.toml` |
| `package.example.json` | `package.json` |

**למה?** התבניות מכילות placeholders (`YOUR_D1_NAME`, `your-cf-pages-project`,
`REPLACE_WITH_YOUR_D1_DATABASE_ID` וכו׳). אחרי clone, אתה מעתיק כל תבנית לשם
האמיתי שלה וממלא את הערכים האמיתיים שלך מ-Cloudflare. הקבצים המקומיים שלך
מוחרגים מ-git כך שה-UUID של ה-D1 ושמות הפרויקט שלך לעולם לא יידחפו ל-repo ציבורי.

**התקנה ראשונית אחרי clone:**

```bash
cp wrangler.example.toml          wrangler.toml
cp worker/wrangler.example.toml   worker/wrangler.toml
cp package.example.json           package.json
# עכשיו ערוך כל אחד מהשלושה עם הערכים האמיתיים שלך (פירוט במדריך למטה)
```

אם אי פעם תצטרך לשנות את התבניות עצמן (נדיר — רק אם הוספת משתנה או script
חדשים) — ערוך את ה-`.example.*` ועשה commit לקובץ הזה.

## רצף פקודות מהיר (למשתמשים מנוסים)

מי שכבר מכיר Cloudflare ו-Google Cloud:

```bash
git clone https://github.com/moraneus/vaad.git vaad && cd vaad
# 1. צור את קבצי ההגדרה המקומיים מהתבניות
cp wrangler.example.toml         wrangler.toml
cp worker/wrangler.example.toml  worker/wrangler.toml
cp package.example.json          package.json
npm install
# 2. בחר שם פרויקט ל-Pages ושם ל-D1; החלף את ה-placeholders בשלושת הקבצים שלמעלה
npx wrangler login
npx wrangler d1 create <your-d1-name>                                   # → העתק database_id ל-wrangler.toml
npx wrangler d1 execute <your-d1-name> --remote --file=./schema.sql
npx wrangler pages deploy ./public --project-name=<cf-pages-project>     # → מקבל URL לפרודקשן
# רישום OAuth ב-Google Cloud Console עם ה-URL (ראה שלב 6 למטה)
openssl rand -base64 48 | npx wrangler pages secret put SESSION_SECRET    --project-name=<cf-pages-project>
npx wrangler pages secret put GOOGLE_CLIENT_ID                            --project-name=<cf-pages-project>
npx wrangler pages secret put GOOGLE_CLIENT_SECRET                        --project-name=<cf-pages-project>
npx wrangler pages deploy ./public --project-name=<cf-pages-project>              # פריסה מחדש עם secrets
# פתיחת ה-URL → כניסה כמנהל (1234) → שינוי סיסמה → חיבור Drive → מילוי הגדרות
```

אם משהו לעיל לא מוכר — עקוב אחרי המדריך המפורט שמתחת.

---

## מדריך התקנה מפורט

> זמן כולל: ~15 דקות. אין צורך בידע קודם ב-Cloudflare/GCP.

### דרישות מקדימות

לפני שמתחילים, ודא שיש לך:

- **חשבון Cloudflare** (חינם — הרשמה ב-https://cloudflare.com/sign-up).
- **חשבון Google** שיהיה הבעלים של תיקיית המסמכים. עדיף חשבון ייעודי לבניין.
- **Node.js 18+** ו-npm. בדיקה:
  ```bash
  node --version    # אמור להדפיס v18.x ומעלה
  npm --version
  ```
- **Git** מותקן.
- טרמינל / שורת פקודה במחשב שלך.

### שלב 1 — שכפול ה-repo, יצירת קבצי הגדרה מקומיים והתקנת תלויות

```bash
git clone https://github.com/moraneus/vaad.git vaad
cd vaad

# יצירת קבצי ההגדרה המקומיים מהתבניות שב-git.
# שלושת הקבצים האלה מוחרגים ב-gitignore — הערכים האמיתיים שלך נשארים על המחשב.
cp wrangler.example.toml         wrangler.toml
cp worker/wrangler.example.toml  worker/wrangler.toml
cp package.example.json          package.json

npm install
```

**למה הפקודות `cp`?** קבצי ה-`*.example.*` שב-git מכילים placeholders
(`YOUR_D1_NAME`, `REPLACE_WITH_YOUR_D1_DATABASE_ID`, `your-cf-pages-project` וכו׳).
תמלא את הערכים האמיתיים שלך ב-Cloudflare בעותקים שיצרת בשלבים הבאים.
מכיוון ש-`wrangler.toml`, `worker/wrangler.toml`, ו-`package.json` רשומים ב-`.gitignore`,
ה-UUID של ה-D1 שלך ושמות הפרויקט לעולם לא יידחפו ל-repo הציבורי.

> **חשוב:** בכל פעם שאתה משנה ערך של פריסה (שם D1, שם פרויקט Pages, שם Worker) —
> ערוך את הקובץ ה**מקומי** `wrangler.toml` / `package.json` שלך, **לא** את
> ה-`.example.*` (אלה התבניות הציבוריות).

**אימות:** `ls` מציג את `public/`, `functions/`, `schema.sql`, ואת ה-`wrangler.toml` שיצרת זה עתה. `npm install` מסתיים ללא שגיאות. התלות היחידה החיונית היא `wrangler`.

### שלב 2 — אימות מול Cloudflare

```bash
npx wrangler login
```

זה פותח את הדפדפן להתחברות ל-Cloudflare. אחרי האישור, חזור לטרמינל — Wrangler שומר את הטוקן מקומית לקריאות עתידיות.

**אימות:**
```bash
npx wrangler whoami
```
אמור להדפיס את האימייל ומזהה החשבון שלך ב-Cloudflare.

**בעיות נפוצות**
- *"Could not open browser"* — העתק את ה-URL שמודפס בטרמינל ופתח אותו ידנית.
- *"User not found"* — הירשם ב-https://cloudflare.com קודם, ואז הרץ שוב את `wrangler login`.

### שלב 3 — יצירת DB של D1

```bash
npx wrangler d1 create <your-d1-name>
```

**פלט צפוי:**
```
✅ Successfully created DB '<your-d1-name>' in region <your-region>
[[d1_databases]]
binding = "DB"
database_name = "<your-d1-name>"
database_id = "abc123-def456-..."
```

**פעולה נדרשת:**
1. העתק את הערך של `database_id` (המחרוזת האקראית הארוכה).
2. פתח את `wrangler.toml` בעורך.
3. החלף את ה-placeholder `REPLACE_WITH_YOUR_D1_DATABASE_ID` בערך הזה:
   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "<your-d1-name>"
   database_id = "abc123-def456-..."
   ```
4. שמור את הקובץ.

**אימות:**
```bash
npx wrangler d1 list
```
אמור להציג את `<your-d1-name>` ברשימה.

### שלב 4 — החלת הסכימה על ה-DB

```bash
npx wrangler d1 execute <your-d1-name> --remote --file=./schema.sql
```

**מה זה עושה:** יוצר את כל הטבלאות (apartments, payments, expenses, sessions, audit_log, reminders, receipts, …) וזורע ערכים ראשוניים (סנטינל לסיסמת מנהל, שם בניין ברירת מחדל, דמי ועד ברירת מחדל, מספר דירות ברירת מחדל).

**פלט צפוי:** רשימת queries שבוצעו, כולן ב-✅, ללא שגיאות. ה-schema הוא idempotent מלא (`CREATE TABLE IF NOT EXISTS`, `INSERT OR IGNORE`) — ריצה חוזרת בטוחה וזה בדיוק איך תחיל עדכונים עתידיים.

**אימות:**
```bash
npx wrangler d1 execute <your-d1-name> --remote --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```
אמור לציין כ-20 טבלאות כולל `apartments`, `payments`, `expenses`, `receipts`, `sessions`, `audit_log` וכו׳.

### שלב 5 — פריסה ראשונה (עדיין בלי secrets)

צריך לפרוס קודם כדי לקבל URL ציבורי — ההגדרה של OAuth ב-Google דורשת אותו.

```bash
npx wrangler pages deploy ./public --project-name=<cf-pages-project>
```

**פלט צפוי:**
```
🌍  Uploading... (X/X)
✨ Deployment complete!
   https://<random-id>.<cf-pages-project>.pages.dev
```

ה-URL היציב והקבוע הוא **`https://<cf-pages-project>.pages.dev`** (בלי ה-id האקראי). העתק אותו — תדביק אותו בקרוב ב-Google Cloud Console.

**אימות:** פתח את `https://<cf-pages-project>.pages.dev` בדפדפן. אמור להופיע מסך הכניסה בעברית. אל תנסה להיכנס עדיין — secrets לא הוגדרו.

### שלב 6 — Google Cloud Console: הגדרת OAuth

השלב הזה מאפשר לאפליקציה לפנות ל-Google Drive בשמך. חינם לשימוש אישי.

#### 6.1 יצירת פרויקט ב-Google Cloud

1. לך ל-https://console.cloud.google.com.
2. לחץ על picker הפרויקט בראש → **New Project**.
3. תן שם `Vaad Bayit` (או כל שם אחר).
4. לחץ **Create** וחכה כמה שניות עד שיוקצה.
5. עבור לפרויקט החדש מה-picker.

#### 6.2 הפעלת Drive API

1. ב-sidebar שמאלי (≡): **APIs & Services → Library**.
2. חפש "Google Drive API".
3. לחץ על התוצאה → **Enable**.

#### 6.3 הגדרת מסך הסכמת OAuth

1. Sidebar → **APIs & Services → OAuth consent screen**.
2. **User Type:** בחר **External** → **Create**.
3. עמוד פרטי האפליקציה:
   - **App name:** `Vaad Bayit` (זה מה שמשתמשים יראו במסך ההסכמה).
   - **User support email:** האימייל שלך.
   - **Developer contact email:** האימייל שלך.
   - השאר (לוגו, homepage, מדיניות פרטיות) אופציונלי — אפשר להשאיר ריק.
4. **Save and continue** → תגיע ל-**Scopes**.
5. לחץ **Add or remove scopes**, חפש וסמן:
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/userinfo.email`
6. לחץ **Update** → **Save and continue**.
7. עמוד **Test users** → לחץ **+ Add users** → הזן את כתובת ה-Gmail שתהיה הבעלים של תיקיית המסמכים של הבניין. **הוסף את האימייל של כל מנהל שיצטרך לחבר Drive.**
8. **Save and continue** → **Back to dashboard**.

> האפליקציה נשארת במצב **Testing** — זה תקין לשימוש אישי/משפחתי. רק test users יכולים להזדהות; כל השאר יקבלו "Access blocked: app not verified". פרסום האפליקציה ידרוש את תהליך האימות של Google שאינו נחוץ לוועד בית.

#### 6.4 יצירת אישורי OAuth client

1. Sidebar → **APIs & Services → Credentials → + Create credentials → OAuth client ID**.
2. **Application type:** **Web application**.
3. **Name:** `Vaad Bayit Web`.
4. **Authorized redirect URIs** — לחץ **+ Add URI** והוסף את **כל** ה-URIs הבאים (התאמה מדויקת חיונית, אחד בכל שורה):
   - `https://<cf-pages-project>.pages.dev/api/drive/auth-callback` — לחיבור Google Drive (אחסון מסמכים)
   - `https://<cf-pages-project>.pages.dev/api/auth/identity-callback` — לאימות חשבון Google לשחזור סיסמה ולזרימת "שכחתי סיסמה" (ללא הרשאות Drive)
   - `http://localhost:8787/api/drive/auth-callback` *(רק אם תריץ את האפליקציה מקומית)*
   - `http://localhost:8787/api/auth/identity-callback` *(רק אם תריץ את האפליקציה מקומית)*
5. לחץ **Create**.
6. דיאלוג נפתח עם **Client ID** ו-**Client secret**. **העתק את שניהם** — תדביק אותם בשלב 7. (אפשר לפתוח את הדיאלוג שוב מ-Credentials → ה-OAuth client שלך.)

**בעיות נפוצות**
- *"redirect_uri_mismatch"* בהמשך: ה-URI הרשום חייב להתאים בדיוק — `https` מול `http`, בלי slash בסוף, host זהה.
- *"Access blocked"* בזמן הסכמה: המשתמש לא ברשימת Test users (שלב 6.3).

### שלב 7 — הגדרת secrets ב-Cloudflare

Secrets של Cloudflare הם משתני סביבה מוצפנים שרק ה-runtime יכול לקרוא.

#### 7.1 SESSION_SECRET

משמש לחתימת cookies של session *וגם* להצפנת ה-refresh token של Drive ב-DB. חייב להיות ארוך ואקראי.

```bash
openssl rand -base64 48 | npx wrangler pages secret put SESSION_SECRET --project-name=<cf-pages-project>
```

> ⚠️ אל תשתמש בערך זהה בסביבות שונות. אל תעלה ל-git. אל תרוצן בלי סיבה — רוטציה מנתקת את כל הסשנים ופוסלת את ה-refresh token המוצפן של Drive (תצטרך לחבר Drive מחדש מהממשק).

#### 7.2 GOOGLE_CLIENT_ID

```bash
npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name=<cf-pages-project>
```

כשיתבקש, הדבק את ה-**Client ID** שהעתקת בשלב 6.4 ולחץ Enter.

#### 7.3 GOOGLE_CLIENT_SECRET

```bash
npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name=<cf-pages-project>
```

כשיתבקש, הדבק את ה-**Client Secret** שהעתקת בשלב 6.4 ולחץ Enter.

#### 7.4 פריסה מחדש עם ה-secrets החדשים

```bash
npx wrangler pages deploy ./public --project-name=<cf-pages-project>
```

Pages Functions רואות secrets רק אחרי פריסה חדשה.

**אימות:**
```bash
npx wrangler pages secret list --project-name=<cf-pages-project>
```
אמור להציג את `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (שמות בלבד — ערכים לא מוצגים).

### שלב 8 — כניסה ראשונה

1. פתח את `https://<cf-pages-project>.pages.dev` בדפדפן.
2. במסך הכניסה, החלף ללשונית **מנהל**.
3. סיסמת ברירת המחדל היא `1234`. לחץ **התחברות**.
4. נכנסת כעת כמנהל. **שים לב:** כפתור *שינוי סיסמת מנהל* בהגדרות **חסום עד שתאמת חשבון Google לאיפוס סיסמה** (שלב 8.5). זה מכוון — ראה הסבר למטה.

> **למה אימות זהות הוא חובה לפני שינוי הסיסמה?**
> אם תשנה את סיסמת המנהל ובהמשך תשכח אותה, חייבת להיות דרך לשחזר. המערכת
> משתמשת ב-**Google עצמה כערוץ השחזור**: אתה רושם כאן חשבון Google, ואם
> תשכח את הסיסמה — לחיצה על "שכחת סיסמה?" → "התחבר עם Google" → אם Google
> מאמתת את אותו חשבון → אתה רשאי לבחור סיסמה חדשה. **לא נשלח שום מייל**,
> ולכן זה עובד מהיום הראשון בלי Resend, בלי דומיין מאומת, בלי שום דבר מעבר
> ל-OAuth client של Google שכבר יש לך.

### שלב 8.5 — אימות זהות עם Google (חובה)

פתח את **הגדרות** → גלול לקטע **אבטחה וסיסמאות**. תראה כרטיס חדש בראש הקטע בשם **"אימות זהות לאיפוס סיסמה"**.

1. לחץ **"אימות זהות עם Google"**.
2. תועבר לבוחר החשבונות של Google.
3. בחר את חשבון ה-Gmail שישמש כ**חשבון השחזור** שלך. **בחר בקפידה** — זה החשבון היחיד שיוכל לאחר מכן לאפס את סיסמת המנהל. Gmail ייעודי לבניין מומלץ על פני חשבון אישי. (החשבון הזה לא חייב להיות זהה לחשבון שתשתמש בו עבור Drive — ראה את שלב 9 האופציונלי.)
4. לחץ **Allow** עבור הרשאות profile + email בלבד (לא מבוקשות הרשאות Drive בשלב הזה).
5. תועבר חזרה. הכרטיס מציג כעת **"מאומת"** עם הכתובת הרשומה.
6. כפתור *שינוי סיסמת מנהל* שמתחת כעת פעיל.

**אימות:** ב-**הגדרות → אבטחה וסיסמאות** כרטיס הזהות ירוק ומציג את הכתובת שלך. כפתור *שינוי סיסמת מנהל* כבר לא מציג אזהרה.

**בעיות נפוצות**
- *"Error 400: redirect_uri_mismatch"* — ה-redirect URI ב-Google Cloud לא תואם ל-`/api/auth/identity-callback` עבור ה-Pages origin שלך. הוסף `https://<cf-pages-project>.pages.dev/api/auth/identity-callback` ל-**Authorized redirect URIs** ב-OAuth client (שלב 6.4).
- *"Access blocked: this app's request is invalid"* — ה-Gmail שלך לא test user. הוסף בשלב 6.3.

### שלב 9 (אופציונלי) — חיבור Google Drive לאחסון מסמכים

אם ברצונך להעלות קבלות, סריקות הוצאות או מסמכים אחרים לתיקיית Drive פרטית, חבר את Drive עכשיו. אחרת אפשר לדלג — שאר המערכת (דירות, תשלומים, הוצאות, דמי ועד, audit log, שחזור סיסמה) עובדת בשלמותה גם בלעדיו.

1. עדיין בהגדרות, גלול ל-**אינטגרציות → Google Drive** → לחץ **חיבור Google Drive**.
2. תועבר למסך ההסכמה של Google.
3. **אתה יכול לבחור כאן חשבון Google שונה מזה ששימש בשלב 8.5** — לדוגמה, רישום של Gmail אישי כחשבון שחזור ושל Gmail משותף לבניין לאחסון מסמכים. השניים בלתי תלויים לחלוטין.
4. לחץ **Allow** כדי לתת את ה-scope `drive.file` (רק קבצים שהאפליקציה יוצרת — שום דבר אחר ב-Drive שלך לא נגיש).
5. תועבר חזרה. כרטיס Drive מציג **"מחובר"**.

**אימות:** פתח את Drive בלשונית אחרת — תופיע תיקייה חדשה בשם **`vaad-docs`**. כל העלאות המסמכים העתידיות ינחתו שם.

**בעיות נפוצות** זהות לאלו שבשלב 8.5 (redirect URI / test user).

### שלב 9.5 — שינוי סיסמת המנהל (חובה)

חזור ל-**הגדרות → אבטחה וסיסמאות**:

1. לחץ **שינוי סיסמת מנהל** — הכפתור צריך להיות פעיל, עם הערה קטנה מתחתיו שמציגה את חשבון Google לאיפוס.
2. הזן `1234` כסיסמה הנוכחית ובחר סיסמה חזקה חדשה (לפחות 4 תווים; ארוך יותר עדיף).
3. שלח. השינוי נרשם בלוג ה-audit.

אם תשכח את הסיסמה החדשה, השתמש בקישור **שכחת סיסמה?** במסך הכניסה — תועבר ל-Google כדי להתחבר עם חשבון השחזור, ובהתאמה מוצלחת תנחת ישירות בעמוד שבו תוכל לבחור סיסמה חדשה. **בלי Resend, בלי מייל יוצא, בלי אימות דומיין לזרימה הזו.**

### שלב 10 — הקמת הבניין הראשונית

עכשיו ממלאים את הנתונים האמיתיים כך שהמערכת תשקף את הבניין שלך.

#### 10.1 פרטי בניין

**הגדרות → כללי**
- **שם הבניין**
- **כתובת**
- **שמירה**

#### 10.2 הגדרות כספיות

**הגדרות → הגדרות כספיות**
- **יתרת פתיחה** — היתרה בחשבון הבנק ביום שמתחילים להשתמש במערכת.
- **תאריך התחלת ניהול** — חובות הדירות והיתרה המצטברת מחושבים מהתאריך הזה ואילך; כל מה שלפני נחשב סגור ומכוסה ביתרת הפתיחה.

#### 10.3 היסטוריית מספר דירות + דמי ועד

באותו מסך, גלול למטה:
- **מספר דירות בבניין** — כמה דירות משלמות. ההיסטוריה מאפשרת לשנות זאת לאורך זמן (למשל הוספת קומה).
- **דמי ועד חודשיים** — תשלום פר דירה לחודש, גם הוא עם היסטוריית תאריכים.

#### 10.4 לשונית אודות

**אודות**
- **פרטי בנק** — שם בנק, סניף, מספר חשבון, בעל החשבון, IBAN, הערות. הדיירים יראו את זה לצורך העברות.
- **חברי ועד הבית** — שם, תפקיד, טלפון, אימייל לכל חבר ועד.
- **הסבר כללי** — טקסט חופשי שהדיירים יראו (זמני אסיפות, מדיניות יצירת קשר וכו׳).

#### 10.5 הוספת דירות

**דירות → + הוספת דירה** עבור כל יחידה:
- מספר, שם בעלים, טלפון (אופציונלי), הערות (אופציונלי), תאריך התחלת פעילות.

#### 10.6 הסבר לדיירים על הכניסה

שלח לכל דייר:
1. את ה-URL של האתר (למשל `https://<cf-pages-project>.pages.dev` או הדומיין המותאם).
2. בחר **דייר / דירה** במסך הכניסה.
3. בחר את מספר הדירה מהרשימה.
4. הם יתבקשו להגדיר סיסמה אישית בכניסה הראשונה.

אם שכחו את הסיסמה, אתה יכול לאפס מ-**הגדרות → סיסמאות דיירים → אפס**.

### שלב 11 (אופציונלי) — הפיכת דייר למנהל

אם תרצה שלסגן יושב ראש תהיה גם הרשאת מנהל בלי לשתף את סיסמת המנהל הראשי:

1. הדייר חייב להיכנס לפחות פעם אחת (כדי שתהיה לו סיסמה).
2. **הגדרות → סיסמאות דיירים → "הפוך למנהל"** ליד השורה שלו.
3. סיימת — בפעם הבאה שייכנס דרך מסך הכניסה כדייר, יקבל אוטומטית את כל הרשאות המנהל. ה-label של ה-session יראה למשל `5 (מנהל)` להבחנה ב-audit log.

לביטול: באותו מסך → **"הסר הרשאת מנהל"**. הסשנים הפעילים שלו ינוערו מיד.

---

## הגדרה אופציונלית: 2FA, מייל ו-cron חודשי

שלוש התוספות עצמאיות — אפשר להפעיל כל תת-קבוצה.

### אימות דו-שלבי (2FA) למנהל הראשי

1. היכנס כמנהל ולך ל-**הגדרות → אבטחה וסיסמאות → אימות דו-שלבי → הפעל**.
2. הדיאלוג מציג מפתח Base32 + URL `otpauth://`. פתח את Google Authenticator (או Authy / 1Password / Microsoft Authenticator) בטלפון והוסף חשבון *ידנית* על ידי הדבקת המפתח.
3. הקלד את הקוד 6 ספרות מהאפליקציה ולחץ **אמת והפעל**.
4. **שמור את קודי הגיבוי שמוצגים בעקבות** — הם קודי חירום למקרה שתאבד את הטלפון, ומוצגים פעם אחת בלבד.
5. מעכשיו, כניסת מנהל דורשת סיסמה **וגם** קוד עדכני מהאפליקציה.

לכיבוי 2FA תזדקק גם לסיסמת המנהל וגם לקוד עדכני (או קוד גיבוי) — מונע ממי שגנב את ה-session לכבות את ההגנה.

> אדמיני־דירה (דירות שהוגדרו כמנהלות) משתמשים רק בסיסמה. ההפעלה של 2FA היא ברמת המערכת — מגנה רק על המנהל הראשי.

### התראות מייל דרך Resend (חינמי)

הירשם ב-[resend.com](https://resend.com) — החבילה החינמית נותנת 3,000 מיילים בחודש, יותר מספיק לוועד.

> ⚠️ **חשוב — נדרש domain משלך לשליחת מייל אמיתית.**
>
> Resend (כמו כל שירות מייל transactional מכובד) דורש שכתובת השולח תהיה ב-domain שאימתת. **אי אפשר לשלוח מ-`@gmail.com`, `@outlook.com` או כל ספק אחר שאינו שלך** — Resend ידחה את הבקשה עם `validation_error: domain not verified`.
>
> שלוש דרכים לפתרון:
>
> 1. **לוותר על מייל לגמרי.** המערכת עובדת מצוין בלי זה; פשוט מאבדים את הפיצ'רים של המייל (דוח חודשי, ברודקאסט, שחזור סיסמה). ראה "ללא מייל" למטה.
> 2. **לבדוק עם `onboarding@resend.dev`.** זוהי כתובת ברירת המחדל של Resend. אפשר להשתמש בה בלי domain, אבל היא **שולחת רק** לכתובת איתה נרשמת ל-Resend. מתאים לבדיקה שהחיווט עובד; לא מתאים לפרודקשן.
> 3. **לרכוש domain זול (~$10/שנה).** הדרך הקלה ביותר לטווח ארוך. רגיסטרים מומלצים: Cloudflare Registrar (במחיר עלות, משתלב בחשבון שלך), Porkbun, Namecheap. `.com` עולה כ-$10/שנה; חלק מ-TLDs כמו `.online`, `.xyz`, `.site` יכולים להיות $1–3 בשנה הראשונה.

#### 1. צור API key

ב-Dashboard של Resend → **API keys → Create API key** → העתק את הערך (`re_...`).

#### 2. הוסף שולח — בחר אחד משלושה מודים

**(א) שולח sandbox ברירת מחדל (לבדיקות בלבד):**
השתמש ב-`onboarding@resend.dev`. אין צורך בהגדרה. מוגבל למייל של חשבון Resend שלך.

**(ב) ה-domain האישי שלך (פרודקשן):**
- ב-Dashboard של Resend → **Domains → Add Domain** → הזן את ה-domain.
- Resend ייתן לך 3-4 רשומות DNS (SPF, DKIM, DMARC). הוסף אותן בפאנל ה-DNS של הרגיסטר.
- חכה 5-30 דקות לאימות. הסטטוס ב-Resend יהפוך לירוק.
- עכשיו תוכל לשלוח מכל כתובת ב-domain הזה, למשל `vaad@yourdomain.co.il`.

**(ג) Subdomain על domain של מישהו אחר (פתרון חינמי):**
אם לחבר/בן משפחה יש domain, תוכל לבקש subdomain (למשל `vaad.theirdomain.co.il`). הם יוסיפו את רשומות ה-DNS, אתה תאמת ב-Resend.

#### בעיות נפוצות

- **`The domain gmail.com is not verified`** — הגדרת `EMAIL_FROM=you@gmail.com`. Gmail/Outlook/Hotmail לא יכולים להיות שולחים. עבור ל-(א) או (ב) למעלה.
- **`The domain example.com is not verified`** — האימות לא הושלם או ש-DNS שגוי. בדוק ב-Resend dashboard → Domains את הסטטוס המדויק ובדוק שוב את ה-DNS אצל הרגיסטר.
- **המייל לא מגיע** — בדוק spam. הוסף את כתובת השולח לאנשי קשר. ל-deliverability לטווח ארוך, הפעל DMARC alignment (יש מדריך חד-לחיצה ב-Resend).

#### 3. הוסף את ה-secrets ל-Cloudflare

```bash
cd <path-to-project>
npx wrangler pages secret put RESEND_API_KEY --project-name=<cf-pages-project>
# הדבק את ה-re_... key

npx wrangler pages secret put EMAIL_FROM --project-name=<cf-pages-project>
# הדבק את כתובת השולח, למשל vaad@yourdomain.co.il
# (או onboarding@resend.dev לבדיקה ראשונית)

# אופציונלי: שם תצוגה (ברירת מחדל "Vaad Bayit")
npx wrangler pages secret put EMAIL_FROM_NAME --project-name=<cf-pages-project>
# למשל: "ועד הבית של רחוב הרצל 5"

# פריסה מחדש כדי לקלוט את ה-secrets החדשים
npx wrangler pages deploy ./public --project-name=<cf-pages-project>
```

#### 4. בדוק שזה עובד

היכנס כמנהל → **הגדרות → אינטגרציות → התראות מייל → שלח מייל בדיקה**. אם הגיע — סיימת.

#### 5. הסבר לדיירים איך להירשם

כל דייר מצטרף לעדכוני מייל **בכניסה הראשונה שלו** (יש שדה+checkbox בשלב הגדרת הסיסמה). דיירים קיימים יכולים להירשם בהמשך מ-**הגדרות → אימייל לעדכונים → הירשם**, או שהמנהל יכול להזין עבורם את האימייל בעת הוספה/עריכה של דירה ב-**דירות → ✏️ → אימייל לעדכונים**.

מנהל יכול:
- **לשלוח דוח חודשי** (ידנית) — הגדרות → אינטגרציות → שלח דוח חודשי. ברירת המחדל: החודש הקודם.
- **לשלוח הודעה לכל הדיירים** — הגדרות → אינטגרציות → שלח הודעה לכל הדיירים. נושא + תוכן חופשי.

כל מייל כולל footer עם הצהרת "אינו דואר זבל" והוראות הסרה. תאריך ההסכמה נשמר בבסיס הנתונים.

### Cron חודשי אוטומטי

אם תרצה שהדוח החודשי יישלח אוטומטית ב-1 בכל חודש, פרוס Cloudflare Worker קטן ועצמאי. **Cloudflare Pages Functions לא תומך ב-scheduled triggers**, אז אנחנו משתמשים ב-Worker כ-scheduler דק שקורא ל-Pages endpoint עם סוד משותף.

#### 1. צור סוד משותף

```bash
openssl rand -base64 32
# העתק את הפלט — תדביק אותו פעמיים (Pages + Worker).
```

#### 2. הגדר אותו ב-Pages

```bash
cd <path-to-project>
npx wrangler pages secret put CRON_SECRET --project-name=<cf-pages-project>
# הדבק את הערך משלב 1
npx wrangler pages deploy ./public --project-name=<cf-pages-project>  # פריסה מחדש לקליטת הסוד
```

#### 3. פרוס את ה-Worker (תיקייה אחות מומלצת)

Wrangler 4.x הולך מעלה מהתיקייה הנוכחית בחיפוש `wrangler.toml`. כי לפרויקט Pages יש כבר אחד ב-root, הסידור הנקי הוא להשאיר את ה-Worker בתיקייה אחות:

```bash
mv <path-to-project>/worker <path-to-cron-worker>
cd <path-to-cron-worker>
ls
# cron-monthly-report.js  wrangler.toml

npx wrangler secret put CRON_SECRET
# הדבק את אותו הערך משלב 2

npx wrangler secret put PAGES_ORIGIN
# הדבק את כתובת ה-production, למשל https://<cf-pages-project>.pages.dev
# (בלי / בסוף; אם יש דומיין מותאם — השתמש בו)

npx wrangler deploy
```

חפש `schedule: 0 8 1 * *` בפלט הפריסה — זה ה-cron יורה ב-1 בכל חודש ב-08:00 UTC (≈ 11:00 ישראל).

#### 4. בדיקה ידנית (אופציונלי)

מצא את ה-`workers.dev` subdomain שלך — הוא מודפס בפלט הפריסה, או נמצא ב-Cloudflare Dashboard תחת **Workers & Pages → <cf-cron-worker>**. אז:

```bash
curl -X POST \
  -H "x-cron-secret: <CRON_SECRET_שלך>" \
  https://<cf-cron-worker>.<cf-subdomain-שלך>.workers.dev/run
```

| תגובה | משמעות |
|---|---|
| `{"ok":true,"sent":N,"year":Y,"month":M}` | 🎉 עובד — N דיירים קיבלו את המייל |
| `{"error":"אין דיירים שרשומים לקבלת מיילים"}` | הצינור תקין, אין דיירים שנרשמו עדיין — ה-cron ימתין |
| `{"error":"Forbidden"}` | `CRON_SECRET` לא תואם בין Pages ל-Worker — קבע אותו ערך בשניהם |
| `{"error":"שירות האימייל לא הוגדר..."}` | `RESEND_API_KEY` / `EMAIL_FROM` לא הוגדרו ב-Pages |
| `{"error":"Resend batch: 403 — ... domain ... is not verified"}` | `EMAIL_FROM` מצביע ל-domain שלא אימתת ב-Resend. השתמש ב-`onboarding@resend.dev` לבדיקה, או אמת domain משלך. ראה "התראות מייל דרך Resend" למעלה. |

> **בלי ה-Cron Worker**, הכל עדיין עובד — פשוט לחץ **שלח דוח חודשי** ידנית כל חודש.

### שחזור סיסמת מנהל

אם המנהל הראשי שכח את הסיסמה, השחזור נעשה דרך **Google OAuth** — המשתמש מתחבר עם חשבון Google שנרשם כחשבון השחזור בשלב 8.5, ובהתאמה מוצלחת הוא נוחת ישירות בעמוד שבו ניתן לבחור סיסמה חדשה. **לא נשלח שום מייל.**

**דרישות** — שחזור עובד כל עוד:
- נרשם חשבון Google לשחזור (הגדרות → אבטחה → אימות זהות).
- ה-OAuth client של Google מוגדר (כבר מוגדר משלב 6).

**זה הכל.** בלי Resend. בלי דומיין מאומת. בלי תשתית מייל יוצא. הזרימה רצה מקצה לקצה על deploy חדש שלא נגע במייל בכלל.

**זרימה:**
1. במסך הכניסה, עבור ללשונית **מנהל**.
2. לחץ **"שכחתי סיסמה?"** מתחת לשדה הסיסמה.
3. מופיע מודאל קטן שמסביר את התהליך. לחץ **"התחבר עם Google"**.
4. בוחר החשבונות של Google נפתח. התחבר עם חשבון השחזור משלב 8.5.
5. Google מעבירה אותך חזרה. אם הכתובת תואמת, אתה נוחת ישירות בטופס סיסמה חדשה. אם לא תואם (חשבון Google של מישהו אחר), מתקבלת שגיאה מנומסת.
6. בחר סיסמה חדשה ושמור.

**השפעות בעקבות שחזור מוצלח:**
- כל הסשנים הפעילים של מנהל מנותקים (כל לשונית פתוחה תזרק החוצה).
- **אימות דו-שלבי מבוטל אוטומטית** אם היה פעיל. הסיבה: מי ששכח את הסיסמה לרוב גם איבד את ה-authenticator — כיבוי 2FA מונע נעילה לצמיתות. המנהל יכול להפעיל 2FA מחדש מההגדרות אחרי הכניסה.

**החלפת חשבון השחזור:**
הגדרות → אבטחה → "החלפת חשבון לאיפוס" מריץ את אותה זרימת OAuth עם `purpose=replace`. הכתובת הנוכחית מוחלפת **רק לאחר אימות מוצלח של חשבון Google החדש**. זמין רק כשמחוברים כמנהל.

**מניעת ניצול:**
ה-endpoint של "שכחת סיסמה" מוגבל לפי IP (5 בקשות / 5 דקות). חשבון Google שלא תואם נרשם בלוג ה-audit תחת `identity_reset_mismatch` כדי שתוכל לראות ניסיונות.

**אם השחזור לא זמין:**
תיכנס למצב הזה רק אם מחקת את חשבון השחזור (או מעולם לא רשמת אחד). חלופה: לאפס את סיסמת המנהל ישירות ב-D1:

```bash
# מחיקת ה-hash הקיים כך שהכניסה הבאה תעבור דרך מסלול "התקנה ראשונה"
# ותקבל את הסיסמה "1234":
npx wrangler d1 execute <your-d1-name> --remote --command \
  "UPDATE admin_auth SET password_hash = 'NEEDS_INIT', password_salt = 'NEEDS_INIT' WHERE id = 1"
```

לאחר ריצה, היכנס עם `1234`, אמת מחדש חשבון לשחזור בהגדרות, ואז שנה את הסיסמה.

### ללא מייל (Resend)

המערכת **שמישה לחלוטין בלי Resend**, כולל כל פעולות המנהל הקריטיות. אם לא תרצה להגדיר Resend / domain:

- **מה ממשיך לעבוד:** כל פיצ'ר של מנהל ודייר ב-UI — תשלומים, הוצאות, דוחות, קבלות, תזכורות, לשונית "אודות", שינוי סיסמה, **שחזור סיסמה** (Google OAuth), 2FA.
- **מה תאבד:** דוח חודשי במייל, ברודקאסט אדמין לדיירים, רישום מייל לדיירים.

במילים אחרות: Resend הוא שיפור גרידא ל*תקשורת יוצאת לדיירים*. שום דבר במסלול הקריטי של המנהל לא דורש אותו.

---

## עדכון התקנה קיימת

כשמושכים גרסה חדשה מה-repo:

```bash
# 1. החלת מחדש של הסכימה — כל המיגרציות idempotent (CREATE IF NOT EXISTS).
npx wrangler d1 execute <your-d1-name> --remote --file=./schema.sql

# 2. פריסה מחדש של ה-static + functions
npx wrangler pages deploy ./public --project-name=<cf-pages-project>
```

קובץ ה-schema משתמש ב-`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` ו-`INSERT OR IGNORE` כך שריצה חוזרת על DB מאוכלס בטוחה.

---

## דומיין מותאם

ב-Dashboard של Cloudflare:

1. Pages → פרויקט `<cf-pages-project>` → **Custom domains** → **Set up a custom domain**.
2. הוסף את הדומיין שלך — Cloudflare יקבע SSL אוטומטית.
3. עדכן DNS אצל הרשם (CNAME → `<cf-pages-project>.pages.dev`).
4. **חשוב:** הוסף את **שני** אלה ל-Authorized redirect URIs ב-Google Cloud Console (Credentials → ה-OAuth client שלך). בלעדיהם, חיבור Drive ואימות זהות מהדומיין המותאם ייכשלו:
   - `https://yourdomain.com/api/drive/auth-callback`
   - `https://yourdomain.com/api/auth/identity-callback`

---

## פיתוח מקומי

כדי ש-OAuth יעבוד מקומית, הגדר את אישורי Google בקובץ `.dev.vars` (Wrangler קורא אותו אוטומטית; **אל תעלה ל-git**):

```bash
# .dev.vars
SESSION_SECRET=any-random-string-for-local
GOOGLE_CLIENT_ID=...your-client-id...
GOOGLE_CLIENT_SECRET=...your-client-secret...
```

```bash
# הקמת ה-D1 מקומי (פעם אחת)
npm run db:init:local

# הרצת שרת dev
npm run dev
# → http://127.0.0.1:8787
```

`wrangler pages dev` משתמש ב-Miniflare — סביבת Cloudflare מקומית עם D1 מדומה (state ב-`.wrangler/state/`). דאג ששני ה-URIs `http://localhost:8787/api/drive/auth-callback` ו-`http://localhost:8787/api/auth/identity-callback` רשומים ב-OAuth redirect URIs ב-Google.

---

## גיבוי ושחזור

### גיבוי DB

```bash
mkdir -p backups
npx wrangler d1 export <your-d1-name> --remote --output=./backups/$(date +%Y%m%d).sql
```

### מסמכים

המסמכים *הם עצמם* בדרייב שלך — זה הגיבוי. הם שורדים גם אם תמחק את ה-D1. כדי לקשור אותם מחדש אחרי איפוס D1 תצטרך להעלות מחדש דרך האפליקציה (טבלת `documents` שומרת את ה-Drive file IDs).

### שחזור D1

```bash
npx wrangler d1 execute <your-d1-name> --remote --file=./backups/snapshot.sql
```

---

## עלות — הכל חינם

הפעלת המערכת לבניין אחד עולה **0 ש״ח לחודש** כשמשתמשים בהתקנה הסטנדרטית. הנה התמונה המלאה של כל שירות חיצוני שהמערכת נוגעת בו ומה כל אחד גובה:

### Cloudflare (כל ה-backend + ה-hosting)

| משאב | מסגרת חינם | השימוש הצפוי שלך |
|---|---|---|
| **Pages** (אירוח סטטי + דומיין מותאם) | בקשות ללא הגבלה, רוחב פס ללא הגבלה, 500 builds/חודש | זניח — build אחד לכל `wrangler pages deploy` |
| **Pages Functions** (ה-handlers של `/api/...`) | 100,000 הפעלות/יום, 10ms CPU להפעלה (משותף עם Workers) | ועד טיפוסי בקושי מגיע ל-1,000 בקשות/יום |
| **D1** (מסד הנתונים) | 5GB אחסון, 5,000,000 קריאות/יום, 100,000 כתיבות/יום | האפליקציה תופסת < 10MB וכותבת ~50 שורות/יום לבניין אחד |
| **Workers** (ה-Worker העצמאי של הקרון החודשי) | 100,000 בקשות/יום, 10ms CPU לבקשה | הקרון רץ פעם בחודש → 12 הפעלות בשנה |
| **Cron Triggers** | חינם עם Workers | טריגר אחד, חודשי |
| **חיבור דומיין מותאם** | חינם לכל דומיין שאתה הבעלים שלו (CF לא גובה על ה-proxy) | אופציונלי |

**ה-Free Tier של Cloudflare הוא לא טריאל.** אין מגבלת זמן, אין expiration, אין "חינם לשנה הראשונה" עם מלכודת. כל זמן שהשימוש מתחת למגבלות היומיות, זה נשאר חינם לעד. אם תחרוג ממכסה יומית, Cloudflare מחזירים 429 — **לא** מחייבים אותך אוטומטית.

### שירותי Google

| שירות | עלות עבורך |
|---|---|
| **Google Cloud Console** (ה-OAuth client של Drive + אימות זהות) | חינם — רישום בלבד, אין עלות לכל בקשת OAuth |
| **Google Drive API** (לאחסון מסמכים) | חינם בנפח שלך — מכסת ברירת מחדל של מיליארד בקשות/יום לפרויקט |
| **אחסון Google Drive** | משתמש ב-15GB חינמיים של חשבון Google שמחבר את Drive — מספיק בקלות למסמכי ועד |

### Resend (אופציונלי — רק אם תרצה פיצ׳רי מייל)

| תכנית | עלות | מה תקבל |
|---|---|---|
| Free tier | $0/חודש — **3,000 מיילים/חודש, 100/יום** | מכסה בנוחות דוחות חודשיים + ברודקאסטים מזדמנים לכל בניין סביר |

**Resend אופציונלי לכל הפיצ׳רים עכשיו.** גרסאות קודמות של האפליקציה דרשו את Resend לזרימת "שכחתי סיסמה"; הארכיטקטורה הנוכחית מחליפה את זה בזרימת אימות זהות של Google (ראה [שחזור סיסמת מנהל](#שחזור-סיסמת-מנהל)). Resend משמש כעת רק לפיצ׳רי מייל פונים לדיירים (ברודקאסטים, דוח חודשי PDF). אם תוותר על Resend לחלוטין, המערכת עדיין רצה מקצה לקצה — ראה [ללא מייל (Resend)](#ללא-מייל-resend).

### מתי בכל זאת תיתכן עלות?

רק אם תבחר להוסיף אחד מהשניים האלה (שניהם אופציונליים ולא קשורים לאפליקציה):

1. **רישום דומיין מותאם** — אם תרצה `vaad.<הבניין-שלך>.com` במקום `<cf-pages-project>.pages.dev`, ה-Registrar גובה ~30-50₪ לשנה. החיבור ל-Cloudflare עצמו חינם.
2. **דומיין שניתן לאמת ב-Resend** — רק אם תרצה שמיילים יוצאים יבואו מ-`vaad@<הדומיין-שלך>.com` במקום `onboarding@resend.dev`. אותו דומיין מסעיף 1 יעבוד.

### דבר אחד שכדאי לא לגעת בו

**אל תוסיף כרטיס אשראי לחשבון Cloudflare שלך.** ללא כרטיס בחשבון, חריגה ממכסה יומית פשוט מחזירה 429 ללקוחות — שום דבר לא מחויב. עם כרטיס בחשבון, חריגה ממכסה תעלה אותך אוטומטית ל-paid plan. לפריסה של בניין אחד זה לא יקרה ממילא, אבל ברירת המחדל הבטוחה היא "ללא כרטיס".

---

## נקודות אבטחה

### ⚠️ מה לא מאובטח לחלוטין מעצמו

- **הסיסמה הראשונית `1234`** של המנהל — חייבים לשנות מיד אחרי הכניסה. השינוי נרשם ב-audit log אוטומטית.
- **`SESSION_SECRET`** מאוחסן ב-secret store של Cloudflare — לעולם לא ב-repo. החלפתו מבטלת את כל הסשנים הפעילים **וגם** את הצפנת הטוקן של Drive (תצטרך להתחבר מחדש).
- **גישה לחשבון Cloudflare** — כל מי שיש לו גישה לחשבון Cloudflare שלך יכול לעקוף את האימות ולקרוא ישירות מ-D1. **חובה להפעיל 2FA** על חשבון Cloudflare.
- **גישה לחשבון Google** — מי שניגש לחשבון Google של המנהל יוכל לראות את תיקיית המסמכים. **חובה להפעיל 2FA** על Google.

### ✅ מה כן מאובטח

- אין אפשרות לקרוא נתונים בלי session תקף (כל endpoint מאמת).
- סיסמאות לא נשמרות בפלט — רק PBKDF2 hash.
- ה-IP האמיתי נלכד ע"י Cloudflare (אין ספוף בלוגים).
- מסמכי Drive פרטיים — לעולם לא נחשפים ציבורית, רק זורמים דרך ה-endpoint המאומת.
- ה-OAuth scope `drive.file` אומר שהאפליקציה **פיזית לא יכולה לראות** שום דבר אחר בדרייב שלך. גם אם תיפרץ, היא יכולה לגעת רק בקבצים שיצרה בתיקיית `vaad-docs`.
- CSP חוסם XSS גם אם הזרקת HTML עברה.
- Rate limiting מצמצם הצלחת brute-force.
- דיירים read-only גם ב-UI וגם ב-API. ניסיון כתיבה של דייר מוחזר עם 403.

---

## מבנה הפרויקט

```
vaad/
├── public/                        # Frontend סטטי הפרוס ב-Pages
│   ├── index.html
│   └── assets/
│       ├── css/
│       └── js/
│           ├── i18n.js            # מילוני עברית + אנגלית, dir attribute
│           ├── app.js             # bootstrap וניתוב
│           ├── api.js             # עטיפת fetch + cache
│           ├── store.js           # state cache + mutators
│           ├── ui.js              # shell, modal, toast, מתג שפה, פעמון
│           ├── utils.js           # מעצבי טקסט/תאריכים, html escape
│           ├── calc.js            # חשבונאות / cash-flow
│           └── views/             # dashboard, apartments, expenses, reminders,
│                                  # about, receipt, reports, settings, …
├── functions/                     # Cloudflare Pages Functions
│   ├── _middleware.js             # כותרות אבטחה + CSP + ניקוי sessions
│   ├── lib/                       # crypto, session, audit, util, guard, drive
│   └── api/
│       ├── auth/                  # login, logout, me, change-password, reset-apartment
│       ├── drive/                 # auth-init, auth-callback, status, disconnect
│       ├── settings/              # count-history, fee-history
│       ├── documents/             # proxy ל-Drive להעלאה/הורדה/מחיקה
│       ├── admin/                 # reset
│       └── *.js                   # apartments, payments, expenses, contacts,
│                                  # apartment-adjustments, adjustment-payments,
│                                  # reminders, receipts, vaad-members,
│                                  # apartment-admin, audit, …
├── schema.sql                     # סכימת D1 — idempotent מלא
├── wrangler.toml
├── package.json
└── README.md / README.he.md
```

---

## רעיונות לעתיד

- **2FA למנהל** — TOTP (Google Authenticator) עם `otplib`
- **התראות לדייר** — webhook ל-WhatsApp / SMS על אי-תשלום
- **מיגרציה דו-שלבית** ל-Postgres + Hyperdrive אם הפרויקט גדל מעבר ל-D1

## רישיון

קוד פתוח. אין אחריות. השימוש על אחריות המשתמש.
