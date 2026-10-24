# KAC — نسخة إعادة البناء 2026.10

**النسخة دي تنفيذ حقيقي جزئي من متطلبات KAC الـ350، مش إعلان إن الـ350 ميزة اتنفذت.** الواجهة عربية/إنجليزية، HTML/CSS/JavaScript بدون React أو npm أو حزم. الـBackend ملف Node.js واحد في `api/index.js` قابل للنشر على Vercel. مفيش توكنات تجريبية داخل التطبيق أو ردود Kick مفبركة.

## بداية سريعة من الموبايل — GitHub ثم Vercel

1. اعمل مستودع GitHub جديد، وارفع محتويات ملف `KAC-2026.zip` **بنفس المجلدات**. خلي `index.html`, `style.css`, `script.js`, `vercel.json` في الجذر، و`index.js` **داخل** المجلد الوحيد `api`. لا ترفع الملفات الأصلية القديمة للريبو العام: قد تحتوي إعدادات أو بيانات تخصك.
2. افتح https://vercel.com/new واختر **Import Git Repository**، وحدد المستودع. **Framework Preset: Other**، و**Root Directory: `./`**. لا تحتاج Build Command ولا Output Directory مخصصة؛ اترك الإعدادات الافتراضية للـStatic Site + Serverless Functions.
3. من إعدادات تطبيقك في https://kick.com/settings/developer (أو بوابة Kick Dev) هات **Client ID** و**Client Secret** الخاصين بتطبيقك.
4. من Vercel افتح **Project → Settings → Environment Variables** وحط القيم التالية **من غير علامات تنصيص**:

   - `KICK_CLIENT_ID` = Client ID الخاص بتطبيق Kick.
   - `KICK_CLIENT_SECRET` = Client Secret الحقيقي، **في Vercel فقط**.
   - `SESSION_SECRET` = سلسلة عشوائية قوية لا تقل عن 32 حرفًا (الأفضل 64+ حرفًا عشوائيًا). لا تنسخ أي مثال أو قيمة تجريبية.
   - `KICK_REDIRECT_URI` = `https://YOUR-PROJECT.vercel.app/api?action=callback` — بدّل `YOUR-PROJECT` باسم مشروعك الفعلي.

5. في إعدادات Kick Developer ضيف نفس قيمة `KICK_REDIRECT_URI` كـ **Redirect URI**، بنفس الحروف بالضبط.
6. من Vercel اختر **Redeploy** بعد إضافة القيم. افتح `https://YOUR-PROJECT.vercel.app/api?action=health`؛ وجود `configured: true` يعني الإعدادات المطلوبة موجودة، **مش** إن حساب Kick اتجرب بالفعل.
7. افتح رابط موقعك، واضغط **ربط حساب Kick**. هيتفتح تسجيل الدخول الرسمي، وبعد الموافقة هترجع للموقع. ساعتها جرب إضافة قناة حقيقية وفتح شات البث وإرسال رسالة **يدوية مصرح بها**.

> مهم: فتح `index.html` مباشرة من مدير الملفات يشغّل أقسام الواجهة والمكتبة المحلية فقط. OAuth وإرسال الشات والتحقق من القنوات يحتاجوا خادم HTTPS منشور ومفاتيح حقيقية. خدمات Kick قد ترفض حسابًا أو تطبيقًا حسب الصلاحيات والحدود؛ لا يوجد ضمان قبول مسبق.

## تشغيل الأحداث الحقيقية والشات

الـPublic API الرسمي في Kick يسمح بإرسال الرسائل، لكن **تاريخ الشات العام** ليس واجهة REST متاحة للتطبيق لاسترجاع جميع الرسائل القديمة. الحل الرسمي للأحداث الجديدة هو Webhooks. عشان الشات يعرض أحداث حقيقية:

1. جهز Redis يدعم Upstash REST API بشكل دائم، وضيف في Vercel `UPSTASH_REDIS_REST_URL` و `UPSTASH_REDIS_REST_TOKEN`. ده إعداد **اختياري** لباقي التطبيق لكنه **أساسي** لعرض الشات عبر Webhooks في النسخة دي.
2. افتح إعداد Kick Developer وفعّل Webhooks على رابط `https://YOUR-PROJECT.vercel.app/api?action=webhook`.
3. أعد النشر وافتح أي قناة محفوظة، ومن صفحة الشات اضغط **الاشتراك في أحداث القناة**. الباكيند بيطلب الاشتراك الرسمي في `chat.message.sent` و `livestream.status.updated` باستخدام App Access Token.
4. أي رسالة توصل بعد بدء الاشتراك، بعد **تأكيد التوقيع باستخدام المفتاح العام الحالي من Kick**، بتتسجل بحد أقصى آخر 350 حدث/قناة مع مدة حفظ 48 ساعة، وبتتعرض في التطبيق مع فاصل تحديث تختاره. الرسائل القديمة قبل الاشتراك مش متاحة من النظام ده.
5. زر إرسال رسالة **لا** يضيفها تلقائيًا للشات كأنها استُقبلت؛ Kick قد يقبل الطلب عبر `is_sent: true` ثم يظهر الحدث الموثق بعد وصول Webhook فعليًا.

**ملاحظة مهمة:** لو Redis غير مضبوط أو توقيع الحدث غير صحيح، الشات **مش** هيعرض بيانات مفبركة. تأكيد الإرسال من Kick منفصل عن تأكيد استلام الرسالة من Webhook.

## اللي اتنفذ في الكود حاليًا

- واجهة Premium متجاوبة للموبايل والتابلت والكمبيوتر، عربي/إنجليزي، RTL/LTR، ثيمات **Dark/Light/OLED** وأربعة ألوان، Dock للموبايل، أزرار فعلية وحالات فارغة وحفظ تفضيلات.
- حفظ القنوات/الملاحظات/تفضيلات الواجهة في **IndexedDB**، إضافة وحذف وتثبيت القنوات، مكتبة رسائل وملاحظات، استيراد وتصدير JSON للبيانات المحلية **بدون توكنات**، خيار تقليل الصور والحركة والطلبات.
- **OAuth 2.1 + PKCE S256 + state** مع exchange/refresh بـClient Secret على الخادم فقط؛ بيانات حسابات مخفية التوكنات في **كوكي مشفر HttpOnly**، وتفاصيل عامة فقط للواجهة.
- **GET /public/v1/channels** بتوكن تطبيق على الخادم، مع واجهة بطاقات تظهر الحالة الحقيقية، عنوان البث، التصنيف، عدد المشاهدين عندما يظهر في رد Kick؛ لا نعرض stream key أو stream URL الحساسة حتى لو وردت من واجهة Kick.
- **POST /public/v1/chat** من User OAuth token بالصلاحية الصحيحة، واستخدام `type:user`, `broadcaster_user_id`, `content`، ودعم `reply_to_message_id`، والتحقق من `is_sent` وHTTP errors و429 وعدم إعادة المحاولة تلقائيًا لو النتيجة غير مؤكدة.
- اشتراكات أحداث Kick الرسمية واستقبال Webhook بتوقيع RSA-SHA256، ومخزن دائم اختياري Redis مع deduplication واكتفاء بأحدث 350 حدثًا والقناة.
- عرض مكافآت **قناة صاحب الحساب نفسه** إذا كانت `channel:rewards:read` فعّالة، لا ادعاء بجلب متجر أو رصيد نقاط **أي** قناة أو أي مشاهد.

## ما لم يُنفَّذ بعد (لا توجد محاكاة له)

- رصيد نقاط المستخدمين ومستواهم ونقاط مشاهدتهم الحية، والمتابعة الرسمية كفعل من التطبيق، وأرشيف الشات الكامل قبل الاشتراك: لم يتم التحقق من وجود واجهة عامة موثقة تدعمها لنفس الاستخدام.
- جداول الإرسال المستمرة بعد غلق المتصفح، Tasks/Cron/Queues متعددة الحسابات، الاشتراكات المدفوعة، الحظر/الإشراف، مكتبة حسابات مشتركة بين الأجهزة، النوافذ متعددة البث، تحليلات 50 ميزة الإضافية: **تحت التطوير** ولا تُعرض كميزات شغالة.
- **محدودية الحسابات**: الكوكي المشفر له حد حوالي 3.7KB، فعدد الحسابات المحفوظة عبر OAuth محدود حسب طول التوكنات. تطبيق حسابات كثيرة بحق يحتاج Database للجلسات، مع ACL ومفاتيح وتوزيع مضبوطين؛ Redis الحالي للأحداث فقط.
- حالات الـ429 وRetry-After تُعرض أخطاؤها، لكن ليس هناك queue موزعة للإرسال بلا Redis. لا تستخدم نسخ السيرفرات أو الحسابات لتجاوز حدود Kick.
- عمليات المصادقة والإرسال والإشعارات **لم يتم اختبارها بتوكن Kick حقيقي في بيئة النشر** لأن مفاتيحك غير موجودة. اختباراتنا آلية *بمحاكاة نقل API داخل الاختبارات فقط*، لا تحاول إظهار بيانات مزيفة داخل المنتج.
- **النواة الأصلية الضخمة لم تندمج بالكامل** داخل هذا الإصدار. الملفات اللي أرسلتها محفوظة **كما هي** في أرشيف منفصل للتدقيق والدمج التدريجي؛ نقل آلاف الأسطر المكررة غير الآمنة للواجهة الجديدة بلا مراجعة كان هيكرر أخطاء التطبيق.

## تشغيل الاختبارات

مع توفر Node 20+ محليًا أو عبر GitHub Actions: `node smoke.test.js`. الاختبارات لا تحتاج إنترنت ولا تؤدي إرسالًا فعليًا إلى Kick. لا تستخدمها كدليل نجاح إرسال حي.

## المراجع الرسمية المستخدمة

- Kick API Swagger: https://api.kick.com/swagger/doc.json
- OAuth 2.1: https://github.com/KickEngineering/KickDevDocs/blob/main/getting-started/generating-tokens-oauth2-flow.md
- Scopes: https://github.com/KickEngineering/KickDevDocs/blob/main/scopes/scopes.md
- Chat endpoint: https://github.com/KickEngineering/KickDevDocs/blob/main/apis/chat.md
- Kick Events: https://github.com/KickEngineering/KickDevDocs/blob/main/events/event-types.md
- Webhook verification: https://github.com/KickEngineering/KickDevDocs/blob/main/events/webhook-security.md
- Channel rewards: https://github.com/KickEngineering/KickDevDocs/blob/main/apis/channel-rewards.md
- Vercel Node Functions: https://vercel.com/docs/functions/runtimes/node-js

## أمن وخصوصية

متحطش `Client Secret` أو `SESSION_SECRET` أو توكن شخصي في JavaScript أو GitHub العام. الكوكي مشفر AES-GCM وموسوم HttpOnly, Secure, SameSite=Lax؛ **ده مش بديل** لقاعدة جلسات خادم قابلة للإبطال عند الحاجة لتطبيق متعدد المستخدمين على نطاق كبير. فصل حساب من KAC يمسحه من جلستك؛ لا يلغيه عند Kick تلقائيًا. لإبطال الصلاحيات من Kick استخدم إدارة التطبيقات المتصلة في حساب Kick. تخزين أحداث شات عام لمدة 48 ساعة يخضع لمراجعة سياسة البيانات والخصوصية قبل إطلاق خدمة عامة.
