# KAC v5 — Kick Account Controller

**نسخة تنفيذية مطوّرة من v3، وليست تنفيذًا كاملًا للـ350 ميزة.** محتوى التطبيق قابل للنشر مباشرة من GitHub، ولكن تشغيل الجدولة بعد إغلاق المتصفح يحتاج خدمتين منفصلتين، وإضافة أسرارهما عند المستخدم. لا توجد API مزيفة في التطبيق؛ الاختبارات تستخدم Fixtures مستقلة عن التطبيق نفسه.


## ما الجديد في v5

- صفحة الجدولة بتعرض **الحسابات فقط** أولًا. إعدادات القنوات تظهر عند الطلب، وبعدها محرر إعدادات البث والجداول.
- حذف/تشغيل/إيقاف الحساب، مؤشرات تشغيل فعلية، إحصائيات إرسال/فشل/غير مؤكد، والمدة. وبنفس الفكرة لكل قناة على حدة.
- السماح بالإرسال للبث غير المباشر على مستوى الحساب، مع **استثناءات مستقلة لكل قناة**؛ الخيار بيتزامن مع مشغل الجدولة على السيرفر. عدم السماح = التحقق من حالة البث قبل الإرسال؛ وقرار الإرسال النهائي في Kick.
- كل بطاقة بث بتفتح شاشة بها فيديو Kick الرسمي، حالة القناة وبياناتها، شات Webhooks، إيموتات Kick مصوّرة من رمزها ورده الحقيقي بالمعرف، وقائمة لاختيار حساب الإرسال.
- فاحص اتصال فعلي يجرب Kick token introspection، Redis PING، وWorker authenticated probe.
- تذكير ثابت بالصلاة على النبي كل 15 دقيقة **أثناء ظهور صفحة التطبيق فقط**؛ بعد غلق المتصفح يلزم Web Push منفصل وهو غير منفذ.
- **راجع `FEATURE_AUDIT_V5.md` و`FEATURE_MATRIX_V5.csv`** لمعرفة الموجود والفجوات بدل افتراض اكتمال الـ350.

### ترقية GitHub/Vercel/Cloudflare

1. انسخ نسخة احتياطية من ملفات المستودع؛ ارفع ملفات v5 للجذر واستبدل ملفات v4 مع الحفاظ على مجلدي `api/` و`cloudflare/`.
2. Vercel المتصل بفرع `main` يحتاج **Redeploy** ونشر ملف `api/index.js` الجديد.
3. Cloudflare Worker المتصل **بنفس GitHub** لازم يعمل Deployment جديد لأن `cloudflare/worker.js` اتحدث بإجراء `probe`.
4. حافظ على متغيرات البيئة القديمة (`KICK_CLIENT_ID`, `KICK_CLIENT_SECRET`, `KICK_REDIRECT_URI`, `SESSION_SECRET`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `BACKGROUND_WORKER_URL`, `BACKGROUND_WORKER_SECRET`, وفي Worker `BACKGROUND_WORKER_SECRET`, `VERCEL_BACKGROUND_ENDPOINT`).
5. جرّب `https://YOUR-VERCEL-DOMAIN/api?action=health` وتأكد من `version: 2026.10.v5`، ثم اضغط **فحص الاتصال** داخل التطبيق؛ الاختبار ده يعمل اتصالًا فعليًا مع الخدمات.
6. جرب رسالة يدوية واحدة ثم جدولًا قصيرًا في قناة لديك إذن مراسلتها، وراجع النتيجة بعد إغلاق المتصفح.

## الجديد

- جدولة ذات مستويين: لكل **حساب** قنواته وجداول كل قناة، وإمكانية إيقاف حساب، بث، أو جدول مستقل.
- جدولة خادمية اختيارية باستخدام **Cloudflare Workers + SQLite-backed Durable Objects (alarms)**، تحفظ حالة كل جدول في **Upstash Redis** على جهة Vercel. تظل صلاحيات Kick وتوكنات المستخدمين على Vercel، ولا تنتقل إلى Cloudflare.
- حقل الفاصل الأدنى **3 ثوانٍ**، وفاصل عشوائي بين حد أدنى وأقصى، و**عدد غير محدد** من المحاولات حتى إيقاف الجدول أو بلوغ نهاية الوقت أو فشل طلب؛ هذا ليس إذنًا بتجاوز حدود Kick أو ضمانًا للإرسال كل 3 ثوانٍ. عند HTTP 429 والتأخير/الرفض تتوقف العملية بدل التحايل على حدود المنصة.
- إنشاء جدول **مسودة لا يعمل تلقائيًا** عند عدم تحديد بداية. بداية مستقبلية تبدأ عبر Cloudflare عند الموعد المحدد إن كانت الخدمة متاحة. يمكن بدء المسودات يدويًا.
- عدد المقبول من Kick، المرفوض، غير المؤكد، والمنتظر لكل حساب؛ نتيجة `is_sent=true` تعني قبول طلب الإرسال، وليس تأكيد ظهور الرسالة في الشات.
- **تجديد OAuth تلقائيًا** عند طلب الحساب، مع محاولة دورية للخادم كل نصف ساعة تقريبًا بعد تفعيل Cloudflare، حسب صلاحية Refresh Token وتوافر Kick. لا يمكن ضمان إبقاء حساب متصل للأبد إذا ألغي التفويض أو انتهت صلاحية التوكن أو رفض Kick التجديد.
- إضافة توكن **User Access Token رسمي** بعد التحقق من `POST /oauth/token/introspect` والتأكد من أنه نشط وصادر لهذا التطبيق، والتحقق من هوية مستخدمه عبر واجهة Kick. يمكن إرفاق Refresh Token رسمي تابع له. **توكن App Access ليس حساب مستخدم، والتوكنات القديمة بصيغة `ID|SESSION` ليست OAuth ولا يدعمها هذا التكامل.**
- **نسخ احتياطي شامل مشفر** بكلمة مرور 12 حرفًا على الأقل باستخدام PBKDF2-SHA256 (310000 دورة) وAES-256-GCM؛ يشمل إعدادات الواجهة والقنوات والملاحظات والجداول وتوكنات الحسابات المشفرة داخل الكود. لا تصدّر التوكنات بلا تشفير. الاستعادة تتحقق من الحسابات عبر Kick، وتبلغ عن الحسابات التي تحتاج إعادة ربط. لا تبدأ الجداول المستعادة من نفسها.
- تبقى وظائف الشات الحقيقي والمكتبة والقنوات والثيمات والتحكم كما في الإصدار السابق وفق القيود الموثّقة.

## المرحلة الأولى — نشر الواجهة والخادم على Vercel

1. فك ضغط الحزمة. ارفع **محتويات الحزمة** إلى الجذر في مستودع GitHub الحالي، بما فيها مجلد `api` ومجلد `cloudflare`، وليس ملف ZIP نفسه.
2. على Vercel افتح مشروعك المتصل بمستودع GitHub. **Framework Preset: Other**، و**Root Directory: `./`**، وسيب Build Command فاضي.
3. من Project → Settings → Environment Variables أضف أو احتفظ بالقيم السابقة (في **Production**):
   - `KICK_CLIENT_ID`
   - `KICK_CLIENT_SECRET`
   - `KICK_REDIRECT_URI` = `https://YOUR-VERCEL-DOMAIN/api?action=callback` بنفس رابط Kick Developer
   - `SESSION_SECRET` (سلسلة عشوائية قوية 32 حرفًا على الأقل)
   - `UPSTASH_REDIS_REST_URL` (من Upstash Redis)
   - `UPSTASH_REDIS_REST_TOKEN` (من Upstash Redis)
4. اضغط **Redeploy** لو أضفت متغيرات بعد أول نشر. افحص `https://YOUR-VERCEL-DOMAIN/api?action=health` — القيمة `chatStorage:true` تشير لوجود إعداد Redis، مش لفحص الاتصال الحقيقي.
5. حافظ على Webhook Kick إن كنت تستخدمه: `https://YOUR-VERCEL-DOMAIN/api?action=webhook`. لا تغيّر Redirect URI لو الدومين لم يتغير.

## المرحلة الثانية — الاستمرار الحقيقي بعد غلق المتصفح

Cloudflare Durable Objects متاح أيضًا على الخطة المجانية مع **SQLite-backed** objects، لكن تفعيل الخدمة وحدودها يخضعان لحالة حسابك. لا تحتاج تثبيت Node/Python على الموبايل عند استخدام GitHub integration.

1. افتح **Cloudflare dashboard → Workers & Pages → Create application → GitHub** (أو اختر Connect Repository).
2. اختار **نفس مستودع GitHub** الموجود على Vercel، وفرع `main`.
3. في إعدادات البناء اضبط:
   - **Worker name:** `kac-background` (بالضبط كما في `cloudflare/wrangler.jsonc`).
   - **Root directory:** `cloudflare`.
   - **Build command:** سيبه فارغًا.
   - **Deploy command:** `npx wrangler deploy`.
4. بعد النشر افتح **Worker → Settings → Variables and Secrets**، واضف Runtime Secrets:
   - `BACKGROUND_WORKER_SECRET` = سلسلة عشوائية **من 32 حرفًا على الأقل**، لا تضعها في GitHub، واحتفظ بنسخة آمنة منها.
   - `VERCEL_BACKGROUND_ENDPOINT` = `https://YOUR-VERCEL-DOMAIN/api?action=background_execute`.
5. ارجع إلى **Vercel → Project → Settings → Environment Variables** وأضف:
   - `BACKGROUND_WORKER_URL` = رابط Worker الحقيقي `https://kac-background.YOUR-CLOUDFLARE-SUBDOMAIN.workers.dev/`.
   - `BACKGROUND_WORKER_SECRET` = **نفس القيمة تمامًا** التي وضعتها في Cloudflare.
6. اعمل **Redeploy** لـCloudflare Worker بعد تحديث Runtime Secrets إذا لزم، ثم **Redeploy** لمشروع Vercel.
7. افتح `https://YOUR-VERCEL-DOMAIN/api?action=health`. لو `background:true`، ده يعني إن تكوين Redis والمتغيرات موجود — **مش تأكيد وصول Worker**. اختبر حفظ جدول صغير ثم تشغيله من الحساب الذي سمح بالإرسال وتابع سجل Vercel/Cloudflare والرد الحقيقي من Kick. الأزرار هتبلغك عن أخطاء الاتصال عند محاولة الحفظ على مشغل Cloudflare.

**مهم:** Worker لا يُنشر مع Vercel تلقائيًا؛ هو مشروع نشر ثانٍ على Cloudflare مربوط بنفس المستودع. لو مش قادر تفعّل Cloudflare، يظل التطبيق يعمل محليًا لكن **الجدولة لن تكون مضمونة بعد غلق المتصفح**، حتى لو اتصال الإنترنت شغال.

## الخصوصية والتحكم

- **لا ترسل** Client Secret أو توكنات OAuth أو كود النسخة المشفرة أو كلمة مرورها في المحادثات أو GitHub. كود النسخ المشفر يحتوي على بيانات تسجيل حساسة محمية بكلمة مرور؛ حفظ الكود وكلمة المرور معًا غير آمن. لا يمكن استرجاع كلمة المرور المفقودة.
- الاستعادة تتحقق من توكن الحساب بواجهة Kick الرسمية، وبالتالي قد ترفض توكنًا أُلغي تفويضه. عند استبدال الحسابات، يجري إيقاف الجداول القديمة المرتبطة بالجلسة عند نجاح الاتصال بالخلفية.
- استيراد البيانات المحلية JSON غير المشفرة لا يحتوي على التوكنات؛ لو عايز نقل حساباتك استخدم كود النسخة **المشفر** فقط.
- لا تُعتبر `is_sent: true` دليلًا على ظهور الرسالة في الشات؛ استقبال أحداث Webhook منفصل. لا إعادة إرسال تلقائية لطلبات قد تكون نجحت رغم انتهاء المهلة.
- وقف الجدول وهو بيرسل بالفعل ممكن يوقف الطلبات التالية لكنه مش ضمان لإلغاء رسالة خرج طلبها لـKick.
- الفاصل 3 ثوانٍ قيمة واجهة دنيا، مش معدل إرسال مضمون، وبيخضع لحدود Kick وحالة الخدمة؛ لا تستخدم الحسابات أو السيرفرات للتحايل على الحصص.

## ملفات مرجعية ومراجعة

- `FEATURE_MATRIX.csv` — تقييم 350 متطلبًا مع توضيح المستويات الجزئية.
- `LEGACY_COMPARISON_20.csv` — فروق ومقارنة مع النسخ الأصلية.
- `FEATURE_AUDIT_370.md` — الـ350 بند + 20 بندًا من واجهات القديم، والأجزاء الناقصة.
- `smoke.test.js`، `scheduler.test.js`، `v4.test.js` — اختبارات Node تستخدم Kick/Redis/Worker وهمية **داخل بيئة الاختبار فقط**. التطبيق نفسه لا يولّد نجاحًا وهميًا.

شغّل الاختبارات في CI أو بيئة Node: `node --check script.js` و`node --check api/index.js` و`node smoke.test.js` و`node scheduler.test.js` و`node v4.test.js`.

## مصادر

- Kick OAuth + introspection: https://github.com/KickEngineering/KickDevDocs/blob/main/getting-started/generating-tokens-oauth2-flow.md
- Kick API permissions: https://github.com/KickEngineering/KickDevDocs/blob/main/scopes/scopes.md
- Cloudflare alarms: https://developers.cloudflare.com/durable-objects/api/alarms/
- Cloudflare Workers Git build: https://developers.cloudflare.com/workers/ci-cd/builds/configuration/
- Vercel Hobby Cron limits: https://vercel.com/docs/cron-jobs/usage-and-pricing
- Browser timer throttling: https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
