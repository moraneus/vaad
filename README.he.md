# ועד הבית · Vaad Bayit

[English](./README.md)

מערכת מאובטחת ודו-לשונית (עברית / אנגלית) לניהול ועד בית — מעקב הכנסות והוצאות, דוחות חודשיים ושנתיים, אנשי קשר, מסמכים, תזכורות, וקבלות להדפסה. ממשק עברית-RTL או אנגלית-LTR בלחיצה.

רץ על **Cloudflare** (Pages + Functions + D1) עם מסמכים ב-**Google Drive** של מנהל הוועד. חינם לרוב השימושים.

---

## מה בריפו

- `public/` — frontend סטטי (vanilla JS, RTL/LTR, i18n)
- `functions/` — Cloudflare Pages Functions (REST API + auth + proxy ל-Drive)
- `worker/` — Worker עצמאי אופציונלי ל-cron החודשי (הארכת הוצאות חודשיות + דוח חודשי במייל)
- `schema.sql` — סכימת D1 (idempotent — נטענת בכל פריסה)
- `docs/he/` — תיעוד מלא (עברית) · `docs/` — אנגלית

## עיקרי הפיצ'רים

טעימה ממה שיש (רשימה מלאה ב-[docs/he/features.md](./docs/he/features.md)):

- **הכנסות** — רשת דירה × חודש, עריכה inline של צפוי/בפועל, סימון תשלום מרובה לכמה דירות בלחיצה אחת, ייצוא CSV/PDF לפי חודש/שנה/טווח מותאם.
- **הוצאות** — שלושה סוגים (חודשית / שנתית / חד-פעמית), ספר תשלומים inline להוצאה חודשית, אמצעי תשלום ברירת מחדל פר הוצאה, **הארכה אוטומטית** opt-in שדוחפת את תאריך הסיום קדימה בכל חודש דרך ה-cron Worker, סינון לפי טווח תאריכים, ייצוא CSV/PDF.
- **דוחות** — חודשי, שנתי, או דוח אגרגטיבי לטווח מותאם עם מודי תזרים בפועל לעומת תמונה חשבונאית (עם tooltips שמסבירים מתי כל אחד רלוונטי); CSV + הדפסת דפדפן ל-PDF.
- **בעלים** — entity first-class שמחזיק כמה דירות בכניסה אחת, טלפונים מרובים עם תיאורים אופציונליים (כמו "אישה" / "בן"), רשימה הניתנת למיון (לפי מספר דירה או שם).
- **דירות** — מספר הדירה נאכף כספרות בלבד גם בלקוח וגם בשרת; החלפת שוכר / בעל דירה ללא איבוד היסטוריית כספים.
- **מסמכים** — מועלים לדרייב של המנהל (scope `drive.file` בלבד), ניתנים לחיבור להוצאות, תשלומים, *וגם* להוצאות תשתיתיות.
- **אימות** — סיסמאות התחלתיות שמייצר המנהל (נשמרות מוצפנות וניתנות להצגה מחודשת), קביעת סיסמה מרובה לכמה דירות בו-זמנית, כניסה עם Google לדיירים ולמנהל, שחזור סיסמה דרך Google OAuth, TOTP 2FA אופציונלי למנהל הראשי.

## תיעוד

| נושא | קישור |
|---|---|
| **ארכיטקטורה** — דיאגרמה, הרשאות, מבנה פרויקט, מודל בעלים/שוכר | [docs/he/architecture.md](./docs/he/architecture.md) |
| **פיצ'רים** — רשימת יכולות מלאה + שפות נתמכות | [docs/he/features.md](./docs/he/features.md) |
| **אבטחה** — מודל אבטחה, מה מוגן ומה לא | [docs/he/security.md](./docs/he/security.md) |
| **התקנה** — placeholders, מדריך מפורט, **פתרון בעיות (כולל תיקון PBKDF2)** | [docs/he/installation.md](./docs/he/installation.md) |
| **הגדרה אופציונלית** — 2FA, מייל Resend, cron חודשי, שחזור סיסמה | [docs/he/optional-setup.md](./docs/he/optional-setup.md) |
| **תחזוקה** — עדכונים, דומיין מותאם, פיתוח מקומי, גיבוי ושחזור | [docs/he/operations.md](./docs/he/operations.md) |
| **עלות** — פריסת tier חינמי של Cloudflare, Google, Resend | [docs/he/cost.md](./docs/he/cost.md) |

## התחלה מהירה

```bash
git clone https://github.com/moraneus/vaad.git vaad && cd vaad
cp wrangler.example.toml         wrangler.toml
cp worker/wrangler.example.toml  worker/wrangler.toml
cp package.example.json          package.json
npm install
# כעת עקוב אחר docs/he/installation.md
```

אם נתקלת בשגיאת שרת בכניסה הראשונה — ראה **תיקון PBKDF2** ב-[docs/he/installation.md → פתרון בעיות](./docs/he/installation.md#פתרון-בעיות-התקנה).

## רעיונות לעתיד

- התראות push לדיירים (WhatsApp / SMS) על תשלומים שאחורה
- מיגרציה דו-שלבית ל-Postgres + Hyperdrive אם הפרויקט יגדל מעבר ל-D1

## רישיון

Open source. אין אחריות. שימוש על אחריותך.
