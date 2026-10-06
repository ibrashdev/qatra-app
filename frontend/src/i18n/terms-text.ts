// S-03 «شروط الاستخدام وبيان الخصوصية»: the text of the page. It is owned by docs/Authentication-and-privacy.md, section
// «شروط الاستخدام وبيان الخصوصية», and by the rows of «البيانات المسموحة ومكانها» that the section points to ("as in the table above").
// The Arabic keeps the words of those bullets and rows. What is taken out: decision and task codes, table and column names, and the
// pointers to other places in the documents. The English is proposed (UI-tokens A7) and is not a legal review of either language.
// Left out until their features ship: the lesson-feedback row (D45), and the embedding provider, which this build does not have (D69).
// The downloaded-plan row and the offline paragraph (D46, D58) are here, since the offline plan ships with this build (option C, F13).
// This file is loaded with the S-03 route only (and later S-26), not with every page: the shell strings stay in messages.ts.
import type { Locale } from "./messages";
import type { TermsOpener } from "@/lib/nav/terms-opener";

export type TermsBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: readonly string[] };

export interface TermsTopic {
  title: string; // H3
  blocks: readonly TermsBlock[];
}

export interface TermsText {
  versionLine: string; // c3; {version} is filled with a left-to-right version
  termsHeading: string; // H2, id="terms"
  privacyHeading: string; // H2, id="privacy"
  terms: readonly TermsTopic[];
  privacy: readonly TermsTopic[];
  returnButton: Record<TermsOpener, string>; // c6
}

// The fixed sentences that the page quotes (c5). Each is kept apart so a test can compare it with its source.
export const D53_NOTICE_AR = "تنبيه: نُقل هذا النص حرفيًا عن الكتاب، ولم يُتحقق من صحة الحديث.";
// The transparency line of P-15 (owner-approved on 4 October 2026): it takes the place of the earlier sentence about the rules engine.
export const TRANSPARENCY_LINE_AR =
  "تُبنى خطتك وتُعدَّل في محادثة مع مساعد ذكاء اصطناعي يستقبل وصف هدفك وخيارات الخطة، وعند التعديل ملخص تعلمك وإجاباتك، تحت معرّف مؤقت لا يكشف حسابك؛ وتُحسب الأرقام بمحرك القواعد داخل التطبيق.";
// The plan-conversation paragraph of the privacy statement (owner-approved wording of 4 October 2026).
export const PLAN_CONVERSATION_AR =
  "عند بناء خطتك أو تعديلها في المحادثة يُرسل نص هدفك ورسائلك في المحادثة وخيارات الخطة وبيانات الكتاب العامة إلى مزود نموذج ذكاء اصطناعي خارجي (OpenRouter، نماذج مجانية) لصياغة الخطة؛ وعند تعديل الخطة يُرسل أيضًا ملخص سجل تعلمك وإجاباتك (حالات الحفظ والمراجعات والأخطاء) تحت معرّف مؤقت للمحادثة لا يرتبط بحسابك. لا يُرسل اسم حسابك ولا معرّفه. تُحسب أرقام الخطة داخل التطبيق. يمكنك إكمال الخطة أو تعديلها بالخيارات الجاهزة دون كتابة نص حر.";

export const D53_NOTICE_EN = "Note: this text was transcribed verbatim from the book, and the hadith's authenticity has not been verified.";
export const TRANSPARENCY_LINE_EN =
  "Your plan is built and revised in a conversation with an AI assistant that receives the description of your goal and the plan options, and, when you revise, a summary of your learning and answers, under a temporary identifier that does not reveal your account; the numbers are computed by the rules engine inside the app.";
export const PLAN_CONVERSATION_EN =
  "When you build or revise your plan in the conversation, the text of your goal, your messages in the conversation, the plan options and the public data of the book are sent to an external AI model provider (OpenRouter, free models) to draft the plan. When you revise the plan, a summary of your learning record and your answers (memorization states, reviews and mistakes) is also sent, under a temporary conversation identifier that is not linked to your account. Neither your account name nor its identifier is sent. The numbers of the plan are computed inside the app. You can complete or revise the plan with the ready-made options, without writing free text.";

const ar: TermsText = {
  versionLine: "إصدار الشروط: {version}",
  termsHeading: "شروط الاستخدام",
  privacyHeading: "بيان الخصوصية",
  terms: [
    {
      title: "الكتاب كما هو",
      blocks: [
        { kind: "paragraph", text: "التطبيق يحفظ الكتاب كما هو، بما فيه ما كتبه المؤلف من تخريج ودرجة، دون إضافة أو تعديل." },
        {
          kind: "paragraph",
          text: "يعرض تخريج الطبعة كما ورد؛ فإن نسبت الطبعة الحديث إلى البخاري أو مسلم أو كليهما (مثل «رواه البخاري ومسلم») أو ذكرت درجته يعرض ذلك النص فقط دون تنبيه.",
        },
        {
          kind: "paragraph",
          text: `والحديث الذي لا تذكر طبعته نسبة إلى الصحيحين ولا درجة ينشر كما هو مع التنبيه الثابت بجانبه: «${D53_NOTICE_AR}»`,
        },
        { kind: "paragraph", text: "ولا تعرض الواجهة نسبة حديث أو مرجعًا من خارج نسخة منشورة." },
      ],
    },
    {
      title: "صحة المراجع",
      blocks: [{ kind: "paragraph", text: "صحة المراجع ومطابقة النسخة مسؤولية مدير المحتوى الذي يضيف المصدر." }],
    },
    {
      title: "لا فتوى ولا شرح",
      blocks: [{ kind: "paragraph", text: "التطبيق لا يقدم فتوى أو شرحًا؛ للفتوى أو الشرح يرجى مراجعة أهل العلم والاختصاص." }],
    },
  ],
  privacy: [
    {
      title: "البيانات التي نجمعها",
      blocks: [
        { kind: "paragraph", text: "البيانات المجمعة، مع غرض كل منها وصلاحياتها ومدة الاحتفاظ المعتمدة:" },
        {
          kind: "list",
          items: [
            "اسم المستخدم والمعرف الداخلي: سجل حساب خاص؛ لتسجيل الدخول والملكية فقط.",
            "كلمة المرور: تتحقق منها خدمة Auth؛ لا يسجلها التطبيق ولا يحتفظ بنصها.",
            "رمز الاسترجاع: القيمة لدى المستخدم؛ بصمة فقط في جدول خاص غير مكشوف للواجهة.",
            "اللغة والوقت والمنطقة الزمنية والتذكير: تفضيلات الحساب اللازمة للجلسة وتاريخ الإنجاز؛ المنطقة الزمنية من المتصفح عند التسجيل؛ التذكير داخل التطبيق فقط.",
            "الموافقة على الشروط: إصدار «شروط الاستخدام وبيان الخصوصية» الذي وافق عليه ووقت الموافقة بتوقيت الخادم فقط؛ لإثبات الموافقة وطلب موافقة جديدة بعد تغيير جوهري؛ لا يحفظ معها IP أو بصمة جهاز أو نسخة من نص الشروط؛ تحذف مع الحساب.",
            "الخطة والمراحل والأخطاء والمراجعات: جداول شخصية؛ أخطاء كمعرفات وأنواع ونتائج، ونتيجة الاختبار الأولي والتقدير الذاتي الاختياري.",
            "محادثة الخطة: رسائل المتعلم والمساعد والحالة؛ وتحفظ رسائل المحادثة مع الحساب وتحذف معه في طلب الحذف نفسه؛ لا يحفظ ناتج النموذج الخام، ولا يسجل نص الهدف أو الرسائل في سجلات الطلبات.",
            "فترات النشاط والإنجاز اليومي ودليل الحفظ: فترات تعلم وألعاب نشطة متحقق منها؛ تجمع الفترات المحدودة اللازمة لحساب الوقت، ولا تحول إلى مراقبة عامة لاستعمال الجهاز أو بيانات شخصية إضافية؛ مدير المحتوى لا يقرأ هذه الصفوف لمجرد إدارة كتاب.",
            "لقطة الخطة المحملة والأحداث المحلية: IndexedDB بنطاق صاحب النسخة المحلية، مع مراجع الخطة/النسخة/البنك والجلسات المعدة خادميًا والأجوبة العابرة لحين إقرارها؛ سجل خادمي خاص مملوك؛ لا JWT أو رمز جلسة أو كلمة مرور أو أسرار في أي cache؛ المصادقة والتنزيل والمزامنة تحتاج اتصالًا.",
            "صفوف تحديد المحاولات: بصمات HMAC لاسم المستخدم المطبع ولبادئة IP مع عداد ونافذة زمنية بدقيقة واحدة؛ لمنع التخمين فقط؛ تحذف بعد ٢٤ ساعة بتنظيف انتهازي محدود.",
          ],
        },
      ],
    },
    {
      title: "بيانات الحساب والنموذج الخارجي",
      blocks: [
        {
          kind: "paragraph",
          text: "لا ترسل بيانات الحساب ولا معرّفه إلى النموذج الخارجي (OpenRouter بنماذج مجانية مؤهلة)؛ وما يرسل إلى النموذج الخارجي لبناء الخطة وتعديلها هو ما تذكره الفقرة التالية فقط.",
        },
        { kind: "paragraph", text: PLAN_CONVERSATION_AR },
        {
          kind: "paragraph",
          text: `لا مفتاح لتشغيل المساعد أو إيقافه؛ يظهر بدلًا منه في «ما هي خطتك؟» ومحادثة الخطة والإعدادات السطر الثابت: «${TRANSPARENCY_LINE_AR}»`,
        },
        {
          kind: "paragraph",
          text: "مقدمو الخدمة: Vercel للواجهة، وRender للخادم، وSupabase للحفظ والمصادقة، وOpenRouter لمساعد الخطة والمخطط المقيد بنماذج مجانية فقط.",
        },
      ],
    },
    {
      title: "الحذف والاحتفاظ",
      blocks: [
        {
          kind: "paragraph",
          text: "حذف الحساب حذف فوري نهائي لمستخدم Auth وكل الصفوف الشخصية، وتشمل محادثات الخطة، مع مسح النسخة المحلية على الجهاز الجاري.",
        },
        {
          kind: "paragraph",
          text: "لا نسخ احتياطية قابلة للتنزيل، ومدة احتفاظ المزود بنسخه الداخلية هي ما تتيحه الخطة المجانية، دون ادعاء مدة محددة الآن.",
        },
        { kind: "paragraph", text: "إعادة فتح الخطة المحملة دون اتصال وصول محلي مؤقت؛ جهاز مشترك قد يعرضها إن بقيت دون مسح، وسحب المحتوى/الحساب عن بعد لا يصل فورًا للأجهزة غير المتصلة؛ الخروج المحلي ومسح النسخة لا يساويان حذف الحساب أو إلغاء جلسة الخادم. لا وعد بالمزامنة والتطبيق مغلق، ولا يمنع التثبيت فقد غير المتزامن بسبب الطرد/مسح الجهاز." },
      ],
    },
    {
      title: "ما لا نستنتجه عنك",
      blocks: [{ kind: "paragraph", text: "لا يستنتج التطبيق ديانة أو سمات دينية عن المستخدم." }],
    },
  ],
  returnButton: { register: "العودة إلى إنشاء الحساب", consent: "العودة إلى الموافقة", demo: "العودة إلى رابط العرض التجريبي", home: "العودة إلى الصفحة الرئيسية" },
};

const en: TermsText = {
  versionLine: "Terms version: {version}",
  termsHeading: "Terms of use",
  privacyHeading: "Privacy statement",
  terms: [
    {
      title: "The book as it is",
      blocks: [
        {
          kind: "paragraph",
          text: "The app keeps the book as it is, including the sourcing note (takhrij) and the grade that the author wrote, without addition or change.",
        },
        {
          kind: "paragraph",
          text: "It shows the edition's takhrij as it appears. If the edition attributes a hadith to al-Bukhari or Muslim or both (for example “Narrated by al-Bukhari and Muslim”) or states its grade, only that text is shown, without a notice.",
        },
        {
          kind: "paragraph",
          text: `A hadith whose edition gives no attribution to the two Sahihs and no grade is published as it is, with this fixed notice beside it: “${D53_NOTICE_EN}”`,
        },
        { kind: "paragraph", text: "The interface does not show a hadith attribution or a reference from outside a published edition." },
      ],
    },
    {
      title: "Accuracy of references",
      blocks: [{ kind: "paragraph", text: "The accuracy of the references and the match with the edition are the responsibility of the content manager who adds the source." }],
    },
    {
      title: "No fatwa or explanation",
      blocks: [{ kind: "paragraph", text: "The app does not give a fatwa or an explanation; for a fatwa or an explanation, please consult people of knowledge and expertise." }],
    },
  ],
  privacy: [
    {
      title: "Data we collect",
      blocks: [
        { kind: "paragraph", text: "The data collected, with the purpose of each, who may access it and the approved retention period:" },
        {
          kind: "list",
          items: [
            "Username and internal identifier: a private account record; only for logging in and for ownership.",
            "Password: checked by the Auth service; the app does not record it or keep its text.",
            "Recovery code: the value is with the user; only a fingerprint of it is kept, in a private table that the interface cannot read.",
            "Language, time, time zone and reminder: account preferences needed for the session and for the date of your progress; the time zone comes from the browser when you register; the reminder is inside the app only.",
            "Agreement to the terms: only the version of the “Terms of use and privacy statement” that you agreed to and the time of agreement by server time; to prove the agreement and to ask for a new one after a material change; no IP address, device fingerprint or copy of the terms text is kept with it; deleted with the account.",
            "Plan, stages, mistakes and reviews: personal tables; mistakes as identifiers, types and results, and the placement test result and the optional self-assessment.",
            "Plan conversation: the messages of the learner and the assistant, and the state; the conversation messages are kept with the account and deleted with it in the same deletion request; the raw model output is not kept, and the text of the goal or of the messages is not written to request logs.",
            "Activity periods, daily progress and memorization evidence: verified periods of active learning and games; the limited periods needed to count time are collected and are not turned into general monitoring of device use or additional personal data; the content manager does not read these rows just to manage a book.",
            "Downloaded plan snapshot and local events: IndexedDB on the device, scoped to the owner of the local copy, with references to the plan, edition and question bank, the sessions prepared by the server and the answers held briefly until the server confirms them; a private server record owned by the account; no JWT, session token, password or secret in any cache; sign-in, downloading and syncing need a connection.",
            "Attempt-limiting records: HMAC fingerprints of the normalized username and of an IP prefix, with a counter and a one-minute time window; only to prevent guessing; deleted after 24 hours by limited opportunistic cleanup.",
          ],
        },
      ],
    },
    {
      title: "Account data and external models",
      blocks: [
        {
          kind: "paragraph",
          text: "Account data and its identifier are not sent to the external model (OpenRouter, eligible free models); what is sent to the external model to build and revise the plan is only what the next paragraph states.",
        },
        { kind: "paragraph", text: PLAN_CONVERSATION_EN },
        {
          kind: "paragraph",
          text: `There is no switch to turn the assistant on or off; instead, this fixed line appears in “What is your plan?”, in the plan conversation and in Settings: “${TRANSPARENCY_LINE_EN}”`,
        },
        {
          kind: "paragraph",
          text: "Service providers: Vercel serves the interface, Render runs the server, Supabase stores data and handles sign-in, and OpenRouter provides the plan assistant and the constrained planner with free models only.",
        },
      ],
    },
    {
      title: "Deletion and retention",
      blocks: [
        {
          kind: "paragraph",
          text: "Deleting the account is an immediate, permanent deletion of the Auth user and all personal rows, including plan conversations, together with wiping the local copy on the current device.",
        },
        {
          kind: "paragraph",
          text: "There are no downloadable backups, and how long the provider keeps its internal copies is whatever its free plan allows, without claiming a specific period for now.",
        },
        { kind: "paragraph", text: "Reopening the downloaded plan without a connection is temporary local access: a shared device may show it if it is left without being cleared, and a remote withdrawal of content or of the account does not reach devices that are offline at once; logging out locally and clearing the copy are not the same as deleting the account or ending the server session. Nothing is promised about syncing while the app is closed, and installing does not prevent losing what has not been synced when the browser evicts storage or the device is wiped." },
      ],
    },
    {
      title: "What we do not infer",
      blocks: [{ kind: "paragraph", text: "The app does not infer a religion or religious traits about the user." }],
    },
  ],
  returnButton: { register: "Back to create account", consent: "Back to consent", demo: "Back to try the demo", home: "Back to home" },
};

// A missing translation fails the build (NFR-14): the record needs both locales.
const CATALOGS: Record<Locale, TermsText> = { ar, en };

export function getTermsText(locale: Locale): TermsText {
  return CATALOGS[locale];
}
