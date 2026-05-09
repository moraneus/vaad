# תחזוקה: עדכונים, דומיין מותאם, פיתוח מקומי, גיבוי

[← חזרה ל-README](../../README.he.md) · [English](../operations.md)

## עדכון התקנה קיימת

כשמושכים גרסה חדשה מה-repo:

```bash
# 1. החלת מחדש של הסכימה — כל המיגרציות idempotent.
npx wrangler d1 execute <your-d1-name> --remote --file=./schema.sql

# 2. פריסה מחדש של ה-static + functions
npx wrangler pages deploy ./public --project-name=<cf-pages-project> --commit-dirty=true

# 3. (אופציונלי) פריסה מחדש של ה-Worker אם הקוד או הלו"ז של ה-cron השתנו.
cd <path-to-cron-worker>
npx wrangler deploy
```

קובץ ה-schema משתמש ב-`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS` ו-`INSERT OR IGNORE` כך שריצה חוזרת על DB מאוכלס בטוחה.

`--commit-dirty=true` מדלג על האזהרה של Wrangler על "uncommitted changes" — שימושי כי `wrangler.toml` מוחרג ב-gitignore.

**ה-cron Worker (שלב 3) מטפל בשתי משימות חודשיות:**
- `auto-extend-monthly` — דוחף את `endDate` קדימה להוצאות חודשיות עם opt-in בכל 1 בחודש
- `monthly-report` — מייצר ושולח את דוח ה-PDF החודשי במייל

צריך לפרוס מחדש את שלב 3 רק כשקובץ ה-Worker (`worker/cron-monthly-report.js`) או הלו"ז שלו השתנו. ניתן לפעיל ידנית לבדיקה:

```bash
# הפעלת שני ה-endpoints (כמו הלו"ז המתוזמן)
curl -X POST -H "x-cron-secret: <YOUR_CRON_SECRET>" \
  https://<cf-cron-worker>.<cf-account-subdomain>.workers.dev/run

# הפעלת רק ה-endpoint של auto-extend
curl -X POST -H "x-cron-secret: <YOUR_CRON_SECRET>" \
  https://<cf-cron-worker>.<cf-account-subdomain>.workers.dev/run-extend
```

## דומיין מותאם

ב-Dashboard של Cloudflare:

1. Pages → פרויקט `<cf-pages-project>` → **Custom domains** → **Set up a custom domain**.
2. הוסף את הדומיין שלך — Cloudflare יקבע SSL אוטומטית.
3. עדכן DNS אצל הרשם (CNAME → `<cf-pages-project>.pages.dev`).
4. **חשוב:** הוסף את **שני** אלה ל-Authorized redirect URIs ב-Google Cloud Console (Credentials → ה-OAuth client שלך). בלעדיהם, חיבור Drive ואימות זהות מהדומיין המותאם ייכשלו:
   - `https://yourdomain.com/api/drive/auth-callback`
   - `https://yourdomain.com/api/auth/identity-callback`

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
