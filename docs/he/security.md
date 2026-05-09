# אבטחה

[← חזרה ל-README](../../README.he.md) · [English](../security.md)

## מודל האבטחה

| שכבה                | מימוש                                                            |
|---------------------|------------------------------------------------------------------|
| הצפנת סיסמאות       | **PBKDF2-SHA256**, 100,000 איטרציות, salt 16 בייטים אקראיים      |
| סשנים               | Cookie `HttpOnly` + `Secure` + `SameSite=Lax`, חתום HMAC, מגובה DB row |
| Rate limiting       | 5 ניסיונות / 5 דקות לפי IP+bucket (מנהל / לכל דירה / OAuth)       |
| כותרות אבטחה        | CSP מחמיר, `X-Frame-Options: DENY`, `Strict-Transport-Security`, `Referrer-Policy` |
| לוג כניסות          | כל ניסיון נרשם עם **IP אמיתי** מ-`CF-Connecting-IP`, User-Agent ושעה |
| אימות צד שרת        | כל endpoint רגיש מאמת session — לא ניתן לעקוף ב-DevTools         |
| Drive OAuth scope   | `drive.file` — האפליקציה מוגבלת רק לקבצים שיצרה ב-`vaad-docs`   |
| טוקן refresh של Drive | מוצפן AES-GCM ב-D1 (מפתח נגזר מ-`SESSION_SECRET`)               |
| סיסמאות במלאי        | מוצפנות AES-GCM ב-`SESSION_SECRET` כדי שהמנהל יוכל להציג שוב    |
| 2FA (אופציונלי)     | TOTP RFC 6238 למנהל ראשי; secret מוצפן AES-GCM; קודי גיבוי חד-פעמיים |
| בדיקת תפקיד דינמית   | חברות `apartment_admins` נבדקת בכל בקשה — אין תפקיד מיושן ב-session |

## ⚠️ מה לא מספיק מאובטח לבד

- **סיסמת המנהל ברירת המחדל `1234`** חייבת להשתנות בכניסה הראשונה. השינוי מתועד אוטומטית ב-audit log.
- **`SESSION_SECRET`** נמצא ב-secret store של Cloudflare — לעולם לא ב-repo. סיבוב המפתח מנתק את כל הסשנים, מבטל את ה-refresh token המוצפן של Drive (תצטרך לחבר מחדש), ומבטל את הסיסמאות השמורות במלאי.
- **גישה לחשבון Cloudflare** — כל מי שיש לו גישה לחשבון יכול לעקוף את ה-app auth ולקרוא ישירות מ-D1. **הפעל 2FA** בחשבון Cloudflare.
- **גישה לחשבון Google** — גישה לחשבון Google של המנהל חושפת את תיקיית המסמכים ואת הסיסמה (אם זה גם חשבון השחזור). **הפעל 2FA** ב-Google.

## ✅ מה כן מאובטח

- אי אפשר לקרוא נתונים בלי session תקף (כל endpoint מאמת).
- סיסמאות לא נשמרות ב-plaintext כ-hash — רק PBKDF2. ה-stash המוצפן להצגה מחודשת ניתן לפענוח רק עם `SESSION_SECRET` של ה-runtime החי.
- IP אמיתי נלכד ע״י Cloudflare (אי אפשר לזייף בלוגים).
- מסמכים ב-Drive פרטיים — אף פעם לא משותפים פומבית, רק ב-stream דרך endpoint מאומת.
- ה-scope `drive.file` של OAuth אומר שהאפליקציה **לא יכולה פיזית** לגשת לכלום אחר ב-Drive שלך. גם בחדירה — היא יכולה לגעת רק בקבצים בתוך `vaad-docs`.
- CSP חוסם XSS גם אם הזרקת HTML עברה.
- Rate limiting מקטין הצלחה של brute-force.
- דיירים הם read-only גם ב-UI וגם ב-API. ניסיונות כתיבה של דייר מחזירים `403`.
- כניסה עם Google חסומה למנהל ראשי כש-2FA מופעל (single-factor OAuth היה עוקף את הגורם השני).
