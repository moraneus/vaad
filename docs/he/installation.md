# מדריך התקנה

[← חזרה ל-README](../../README.he.md) · [English](../installation.md)

> זמן כולל: ~15 דקות. אין צורך בידע קודם ב-Cloudflare/GCP.

## Placeholders במדריך הזה

הפקודות בהמשך משתמשות ב-placeholders — החלף בערכים שלך:

| Placeholder | מה זה | דוגמה |
|---|---|---|
| `<cf-pages-project>` | שם פרויקט Cloudflare Pages (אתה בוחר בעת פריסה ראשונה) | `building-mgmt` |
| `<your-d1-name>` | שם DB של Cloudflare D1 (אתה בוחר בעת `d1 create`) | `building-mgmt-db` |
| `<cf-cron-worker>` | שם ה-Cloudflare Worker של הקרון החודשי | `building-mgmt-cron` |
| `<path-to-project>` | נתיב מקומי לתיקיית ה-repo שלך | `~/Projects/building-mgmt` |
| `<path-to-cron-worker>` | נתיב מקומי לתיקיית ה-Worker של הקרון | `~/Projects/building-mgmt-cron` |
| `<cron-worker-dir>` | שם תיקיית ה-Worker של הקרון | `building-mgmt-cron` |
| `<cf-account-subdomain>` | ה-workers.dev subdomain שלך ב-Cloudflare | `your-account-name` |

**המלצה:** השאר את ה-placeholders עקביים לכל אורך ה-session — בחר פעם אחת והשתמש בכל מקום.

## קבצי הגדרה: דפוס ה-`.example`

ה-repo משתמש בדפוס **template + עותק מקומי** עבור שלושת הקבצים שמכילים ערכים ספציפיים לפריסה:

| מה שב-git (תבנית) | העותק המקומי שלך (מוחרג ב-gitignore) |
|---|---|
| `wrangler.example.toml` | `wrangler.toml` |
| `worker/wrangler.example.toml` | `worker/wrangler.toml` |
| `package.example.json` | `package.json` |

**למה?** התבניות מכילות placeholders. אחרי clone, אתה מעתיק כל תבנית לשם האמיתי שלה וממלא ערכים אמיתיים. הקבצים המקומיים מוחרגים מ-git כך שה-UUID של ה-D1 ושמות הפרויקט שלך לא ייצאו ל-repo ציבורי.

**התקנה ראשונית אחרי clone:**

```bash
cp wrangler.example.toml          wrangler.toml
cp worker/wrangler.example.toml   worker/wrangler.toml
cp package.example.json           package.json
# עכשיו ערוך כל אחד מהשלושה עם הערכים האמיתיים שלך
```

אם אי פעם תצטרך לשנות את התבניות עצמן — ערוך את ה-`.example.*` ועשה commit לקובץ הזה.

## רצף פקודות מהיר (למשתמשים מנוסים)

```bash
git clone https://github.com/moraneus/vaad.git vaad && cd vaad
cp wrangler.example.toml         wrangler.toml
cp worker/wrangler.example.toml  worker/wrangler.toml
cp package.example.json          package.json
npm install
npx wrangler login
npx wrangler d1 create <your-d1-name>
npx wrangler d1 execute <your-d1-name> --remote --file=./schema.sql
npx wrangler pages deploy ./public --project-name=<cf-pages-project>
# רישום OAuth ב-Google Cloud Console עם ה-URL (ראה שלב 6 למטה)
openssl rand -base64 48 | npx wrangler pages secret put SESSION_SECRET    --project-name=<cf-pages-project>
npx wrangler pages secret put GOOGLE_CLIENT_ID                            --project-name=<cf-pages-project>
npx wrangler pages secret put GOOGLE_CLIENT_SECRET                        --project-name=<cf-pages-project>
npx wrangler pages deploy ./public --project-name=<cf-pages-project>
# פתיחת ה-URL → כניסה כמנהל (1234) → שינוי סיסמה → חיבור Drive → מילוי הגדרות
```

---

## מדריך התקנה מפורט

### דרישות מקדימות

- **חשבון Cloudflare** (חינם — https://cloudflare.com/sign-up).
- **חשבון Google** שיהיה הבעלים של תיקיית המסמכים.
- **Node.js 18+** ו-npm (`node --version` אמור להציג 18 או יותר).
- **Git** מותקן.

### שלב 1 — שכפול ה-repo, יצירת הגדרות מקומיות והתקנת תלויות

```bash
git clone https://github.com/moraneus/vaad.git vaad
cd vaad
cp wrangler.example.toml         wrangler.toml
cp worker/wrangler.example.toml  worker/wrangler.toml
cp package.example.json          package.json
npm install
```

> **חשוב:** בכל פעם שאתה משנה ערך פריסה (שם D1, שם פרויקט Pages, שם Worker), ערוך את הקובץ ה**מקומי** `wrangler.toml` / `package.json` שלך, **לא** את ה-`.example.*` (אלה התבניות הציבוריות).

### שלב 2 — אימות מול Cloudflare

```bash
npx wrangler login
```

זה פותח את הדפדפן להתחברות. אחרי האישור, חזור לטרמינל. בדיקה: `npx wrangler whoami`.

### שלב 3 — יצירת DB של D1

```bash
npx wrangler d1 create <your-d1-name>
```

העתק את `database_id` מהפלט אל `wrangler.toml` (החלף את `REPLACE_WITH_YOUR_D1_DATABASE_ID`).

### שלב 4 — החלת הסכימה

```bash
npx wrangler d1 execute <your-d1-name> --remote --file=./schema.sql
```

ה-schema הוא idempotent מלא — ריצה חוזרת בטוחה.

### שלב 5 — פריסה ראשונה (עדיין בלי secrets)

```bash
npx wrangler pages deploy ./public --project-name=<cf-pages-project>
```

ה-URL היציב הוא **`https://<cf-pages-project>.pages.dev`**. תעתיק אותו ל-Google Cloud Console בשלב הבא.

### שלב 6 — Google Cloud Console: הגדרת OAuth

#### 6.1 יצירת פרויקט
https://console.cloud.google.com → **New Project** → תן שם → **Create**.

#### 6.2 הפעלת Drive API
**APIs & Services → Library** → "Google Drive API" → **Enable**.

#### 6.3 מסך הסכמת OAuth
**OAuth consent screen** → **External** → מלא את פרטי האפליקציה → ב-**Scopes** הוסף:
- `https://www.googleapis.com/auth/drive.file`
- `https://www.googleapis.com/auth/userinfo.email`

ב-**Test users** הוסף את כל ה-Gmails של המנהלים שיתחברו.

> האפליקציה נשארת ב-**Testing** — תקין לשימוש אישי. רק test users יוכלו להזדהות.

#### 6.4 יצירת OAuth client credentials
**Credentials → + Create credentials → OAuth client ID** → **Web application**.

הוסף **Authorized redirect URIs** (התאמה מדויקת חיונית):
- `https://<cf-pages-project>.pages.dev/api/drive/auth-callback`
- `https://<cf-pages-project>.pages.dev/api/auth/identity-callback`
- `http://localhost:8787/api/drive/auth-callback` *(אם תריץ מקומית)*
- `http://localhost:8787/api/auth/identity-callback` *(אם תריץ מקומית)*

**Create** → העתק את ה-Client ID וה-Client Secret.

### שלב 7 — הגדרת secrets ב-Cloudflare

```bash
openssl rand -base64 48 | npx wrangler pages secret put SESSION_SECRET --project-name=<cf-pages-project>
npx wrangler pages secret put GOOGLE_CLIENT_ID --project-name=<cf-pages-project>
# הדבק את ה-Client ID
npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name=<cf-pages-project>
# הדבק את ה-Client Secret
npx wrangler pages deploy ./public --project-name=<cf-pages-project>
```

> ⚠️ סיבוב `SESSION_SECRET` מנתק את כל הסשנים, פוסל את ה-refresh token של Drive (תצטרך לחבר מחדש), ומבטל את כל הסיסמאות במלאי.

### שלב 8 — כניסה ראשונה

1. פתח `https://<cf-pages-project>.pages.dev` בדפדפן.
2. עבור ללשונית **מנהל**.
3. סיסמת ברירת המחדל: `1234`.
4. שים לב — כפתור *שינוי סיסמת מנהל* חסום עד שתאמת חשבון Google לשחזור (שלב 8.5).

### שלב 8.5 — אימות זהות עם Google (חובה)

**הגדרות → אבטחה וסיסמאות → אימות זהות לאיפוס סיסמה** → **אימות זהות עם Google** → בחר את חשבון ה-Gmail שישמש כ**חשבון השחזור** → **Allow** → תועבר חזרה והכרטיס מציג "מאומת".

> **בחר חשבון בקפידה** — זה החשבון היחיד שיוכל לאפס את סיסמת המנהל בעתיד.

### שלב 9 (אופציונלי) — חיבור Google Drive לאחסון מסמכים

**הגדרות → אינטגרציות → Google Drive → חיבור Google Drive** → **אתה יכול לבחור כאן חשבון Google שונה משלב 8.5** → **Allow** → תופיע תיקייה `vaad-docs` ב-Drive.

### שלב 9.5 — שינוי סיסמת מנהל (חובה)

**הגדרות → אבטחה וסיסמאות → שינוי סיסמת מנהל** → סיסמה נוכחית `1234` ובחר חדשה (לפחות 4 תווים).

אם תשכח את הסיסמה: **שכחת סיסמה?** במסך הכניסה → התחברות עם Google → סיסמה חדשה.

### שלב 10 — הקמת הבניין הראשונית

#### 10.1 פרטי בניין
**הגדרות → כללי** — שם הבניין, כתובת, שמירה.

#### 10.2 הגדרות כספיות
**הגדרות → הגדרות כספיות** — יתרת פתיחה, תאריך התחלת ניהול.

#### 10.3 מספר דירות + דמי ועד
באותו מסך — מספר דירות ודמי ועד חודשיים, שניהם עם היסטוריית תאריכים.

#### 10.4 לשונית אודות
**אודות** — פרטי בנק, חברי ועד הבית, הסבר כללי.

#### 10.5 הוספת דירות
**דירות → + הוספת דירה** עבור כל יחידה. בחר אם בעלים גר בדירה או מושכרת; אם מושכרת — קישור לבעלים קיים או יצירת חדש.

#### 10.6 הסבר לדיירים
שלח לכל דייר את ה-URL ואת הסיסמה שהמנהל הגדיר עבורו (זמינה מ-**הגדרות → סיסמאות דיירים → אייקון העין** במנהל הסיסמאות).

### שלב 11 (אופציונלי) — הפיכת דייר למנהל

**הגדרות → סיסמאות דיירים → "הפוך למנהל"** ליד השורה. ההרשאה נכנסת לתוקף מיידית עבור session פעיל של אותה דירה — כולל session של בעל הדירה (אם זו דירה בבעלות עצמית).

לביטול: **"הסר הרשאת מנהל"** — הסשנים הפעילים ינוערו מיד (גם של דירה וגם של בעלים).

---

## פתרון בעיות התקנה

### שגיאת שרת (5xx) בכניסה הראשונה בגלל הגבלת CPU של PBKDF2

אם רואים עמוד "שגיאת שרת" מעוצב כשמנסים להיכנס לראשונה אחרי התקנה חדשה — וב-audit log רואים שהבקשה חרגה מזמן המעבד — הערך של `PBKDF2_ITERATIONS` שלך גבוה מדי וחורג מתקציב ה-CPU של Cloudflare Workers ב-tier החינמי (10ms לבקשה).

ב-template ברירת המחדל הוא `PBKDF2_ITERATIONS = "100000"`, שמתאים בנוחות לתקציב. אם אתה (או גרסה קודמת של ה-template) הגדלת ל-`"200000"` או יותר — הורד חזרה ל-`"100000"` ופרוס מחדש:

```bash
cd <path-to-project>
sed -i '' 's/PBKDF2_ITERATIONS = "200000"/PBKDF2_ITERATIONS = "100000"/' wrangler.toml
# פריסה מחדש כדי ש-Pages יקלוט את השינוי
npx wrangler pages deploy ./public --project-name=<cf-pages-project> --commit-dirty=true
```

(macOS משתמש ב-`sed -i ''`; Linux משתמש ב-`sed -i` בלי ה-`''`.)

הדגל `--commit-dirty=true` מורה ל-Wrangler לדלג על האזהרה של "uncommitted changes" — שימושי כשערכת רק את `wrangler.toml` המקומי (שמוחרג ב-gitignore) והעץ לא נקי.

אחרי הפריסה מחדש, הכניסה אמורה להצליח. 100,000 איטרציות PBKDF2 עדיין הרבה מעל המינימום שמומלץ ל-OWASP, בהתחשב במודל האיומים שלנו (תוקף יצטרך להגיע ל-D1 ישירות, שזה כבר breach).

### "Sign in with Google" מוביל לעמוד 404 של Google

סיבות נפוצות (מהסבירה לפחות סבירה):
- רווח/שורה חדשה התגנב ל-`GOOGLE_CLIENT_ID` (משתני סביבה ב-Cloudflare Pages לפעמים מודבקים עם רווח בסוף). הזן מחדש את ה-secret.
- ה-OAuth client נמחק/הושבת ב-Google Cloud Console.
- הדפדפן נתפס על redirect cached — נסה חלון פרטי.

### "redirect_uri_mismatch"

ה-URI שרשום ב-Google Cloud חייב להתאים בדיוק — `https` מול `http`, בלי slash בסוף, host זהה. הוסף גם `…/api/drive/auth-callback` וגם `…/api/auth/identity-callback` עבור **כל** origin שתשתמש בו (פרודקשן, דומיין מותאם, `localhost:8787` לפיתוח מקומי).

### "Access blocked: this app's request is invalid"

חשבון ה-Google שאתה בוחר לא נמצא ברשימת Test users. הוסף תחת **APIs & Services → OAuth consent screen → Test users**.
