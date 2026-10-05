// Strings of S-34, the plan review with the assistant (docs/UI-screens.md S-34). Arabic is verbatim from the spec where it fixes the words;
// the rest is proposed copy, so the English wording is not sourced (UI-tokens A7). The assistant's own texts (the refusal, the redirect and the
// fallback notice, the replies) come from the server and are never written here.
import type { PlanSections } from "@/lib/api/types";
import type { Locale } from "./messages";

export interface PlanChatMessages {
  title: string; // H1
  backNew: string; // destination of the back control for a new plan
  backRevision: string; // destination of the back control for a revision
  transparency: string; // P-15, the owner-approved line
  thread: { label: string; assistant: string; you: string; assistantReply: string; earlierProposal: (formatted: string) => string };
  card: { current: (formatted: string) => string; earlier: string; labels: Record<keyof PlanSections, string> };
  quickGroup: string;
  replying: string; // G-34
  confirm: { button: string; confirming: string; hintNoProposal: string; hintUnchanged: string };
  composer: {
    label: string;
    send: string;
    helper: string;
    counter: (used: string, max: string) => string;
    tooLong: string;
    demoNote: string;
    lastReply: string;
  };
  sendFailed: { line: string; retry: string };
  banners: {
    caps: string;
    stale: string;
    planMoved: string;
    startOver: string;
    race: string;
    refresh: string;
    notActive: string;
    notActiveCompleted: string;
  };
  closed: { notFound: string; closed: string; confirmed: string; startOver: string; backToPlan: string; openToday: string };
  fallbackModel: string;
  dialogs: {
    cancel: string;
    replaceTitle: string;
    replaceBody: string; // {title} is the title of the plan that pauses
    replaceConfirm: string;
    reviseTitle: string;
    reviseBody: string;
    revisePaused: string;
    reviseConfirm: string;
  };
  toast: { created: string; revised: string };
}

export const planChatAr: PlanChatMessages = {
  title: "مراجعة الخطة مع المساعد",
  backNew: "ما هي خطتك؟",
  backRevision: "تعديل الوقت والهدف",
  transparency:
    "تُبنى خطتك وتُعدَّل في محادثة مع مساعد ذكاء اصطناعي يستقبل وصف هدفك وخيارات الخطة، وعند التعديل ملخص تعلمك وإجاباتك، تحت معرّف مؤقت لا يكشف حسابك؛ وتُحسب الأرقام بمحرك القواعد داخل التطبيق.",
  thread: { label: "المحادثة مع المساعد", assistant: "المساعد", you: "أنت", assistantReply: "رد المساعد", earlierProposal: (n) => `اقتراح سابق (${n})` },
  card: {
    current: (n) => `الاقتراح ${n} · الحالي`,
    earlier: "سابق",
    labels: { goal: "الهدف الكلي", totalTime: "الزمن الكلي", dailyTime: "الزمن اليومي", stages: "المراحل", reviews: "المراجعات", nextStep: "الخطوة التالية" },
  },
  quickGroup: "اختصارات التعديل",
  replying: "يرد المساعد…",
  confirm: {
    button: "اعتماد الخطة",
    confirming: "جارٍ الاعتماد…",
    hintNoProposal: "اطلب خطة أو اختر اختصارًا أولًا.",
    hintUnchanged: "لم يتغير شيء بعد؛ اطلب تعديلًا أو اختر اختصارًا.",
  },
  composer: {
    label: "رسالتك إلى المساعد",
    send: "إرسال",
    helper: "لا تكتب اسمك أو أي بيانات شخصية.",
    counter: (used, max) => `${used}/${max}`,
    tooLong: "الرسالة حتى ٥٠٠ حرف.",
    demoNote: "في حساب العرض تُعدَّل الخطة بالخيارات الجاهزة فقط.",
    lastReply: "بقي رد واحد للمساعد في هذه المحادثة.",
  },
  sendFailed: { line: "لم تُرسل الرسالة.", retry: "إعادة المحاولة" },
  banners: {
    caps: "بلغت حد ردود المساعد في هذه المحادثة؛ نتابع بالاختصارات.",
    stale: "تغيّرت الخطة المقترحة. راجع البطاقة الجديدة ثم أكّد.",
    planMoved: "عُدّلت خطتك في مكان آخر. ابدأ التعديل من جديد على النسخة الحالية.",
    startOver: "ابدأ من جديد",
    race: "بدأت خطة أخرى للتو. حدّث الصفحة ثم أعد المحاولة.",
    refresh: "تحديث",
    notActive: "هذه الخطة غير نشطة.",
    notActiveCompleted: "اكتملت هذه الخطة؛ لا يمكن تعديلها أو استئنافها.",
  },
  closed: {
    notFound: "لم نعثر على هذه المحادثة.",
    closed: "أُغلقت هذه المحادثة.",
    confirmed: "اعتُمدت هذه الخطة.",
    startOver: "ابدأ من جديد",
    backToPlan: "العودة إلى الخطة الكبرى",
    openToday: "افتح اليوم",
  },
  fallbackModel: "تعديل بالنموذج",
  dialogs: {
    cancel: "إلغاء",
    replaceTitle: "بدء خطة جديدة؟",
    replaceBody: "ستتوقف خطتك الحالية «{title}» مؤقتًا ويبقى تقدمها محفوظًا، وتبدأ هذه الخطة مكانها. يمكنك استئناف السابقة لاحقًا من «الخطة الكبرى».",
    replaceConfirm: "اعتماد الخطة الجديدة",
    reviseTitle: "اعتماد التعديل؟",
    reviseBody: "يسري هذا التعديل من يوم التعلم التالي. ما أنجزته اليوم يبقى كما هو، وتبقى أدلة الخطة السابقة محفوظة.",
    revisePaused: "وتبقى الخطة متوقفة مؤقتًا.",
    reviseConfirm: "اعتماد التعديل",
  },
  toast: { created: "تم اعتماد خطتك.", revised: "تم اعتماد التعديل." },
};

export const planChatEn: PlanChatMessages = {
  title: "Plan review with the assistant",
  backNew: "What is your plan?",
  backRevision: "Change time and goal",
  transparency:
    "Your plan is built and revised in a conversation with an AI assistant that receives the description of your goal and the plan options, and, when you revise, a summary of your learning and answers, under a temporary identifier that does not reveal your account; the numbers are computed by the rules engine inside the app.",
  thread: { label: "Conversation with the assistant", assistant: "Assistant", you: "You", assistantReply: "Assistant reply", earlierProposal: (n) => `Earlier proposal (${n})` },
  card: {
    current: (n) => `Proposal ${n} · Current`,
    earlier: "Earlier",
    labels: { goal: "Overall goal", totalTime: "Overall time", dailyTime: "Daily time", stages: "Stages", reviews: "Reviews", nextStep: "Next step" },
  },
  quickGroup: "Edit shortcuts",
  replying: "The assistant is replying…",
  confirm: {
    button: "Confirm the plan",
    confirming: "Confirming…",
    hintNoProposal: "Ask for a plan or choose a shortcut first.",
    hintUnchanged: "Nothing has changed yet; ask for a change or choose a shortcut.",
  },
  composer: {
    label: "Your message to the assistant",
    send: "Send",
    helper: "Do not type your name or personal data.",
    counter: (used, max) => `${used}/${max}`,
    tooLong: "The message can be up to 500 characters.",
    demoNote: "In a demo account the plan is changed with the ready-made options only.",
    lastReply: "One assistant reply is left in this conversation.",
  },
  sendFailed: { line: "The message was not sent.", retry: "Try again" },
  banners: {
    caps: "You reached the assistant's reply limit for this conversation; we continue with the shortcuts.",
    stale: "The proposed plan changed. Review the new card, then confirm.",
    planMoved: "Your plan was changed elsewhere. Start the change again on the current version.",
    startOver: "Start over",
    race: "Another plan just started. Refresh the page and try again.",
    refresh: "Refresh",
    notActive: "This plan is not active.",
    notActiveCompleted: "This plan is completed; it cannot be changed or resumed.",
  },
  closed: {
    notFound: "We could not find this conversation.",
    closed: "This conversation was closed.",
    confirmed: "This plan was confirmed.",
    startOver: "Start over",
    backToPlan: "Back to the overall plan",
    openToday: "Open today",
  },
  fallbackModel: "Edit with the model",
  dialogs: {
    cancel: "Cancel",
    replaceTitle: "Start a new plan?",
    replaceBody: "Your current plan “{title}” pauses with its progress kept and this plan starts in its place. You can resume the previous one later from “Overall plan”.",
    replaceConfirm: "Confirm the new plan",
    reviseTitle: "Confirm the change?",
    reviseBody: "It takes effect from the next learning day. What you did today stays, and the evidence of the previous plan is kept.",
    revisePaused: "The plan stays paused.",
    reviseConfirm: "Confirm the change",
  },
  toast: { created: "Your plan is confirmed.", revised: "The change is confirmed." },
};

export function planChatMessages(locale: Locale): PlanChatMessages {
  return locale === "ar" ? planChatAr : planChatEn;
}
