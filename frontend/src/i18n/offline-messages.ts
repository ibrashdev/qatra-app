// Offline plan (S-31 shell, S-32 download card, S-33 install, update and revalidation states) strings. A standalone catalog like settings-messages.ts:
// messages.ts is not touched. Arabic marked "fixed" is verbatim from the documents (offline-spec 4.5: PWA-design, API-spec, UI-screens, UI-design); every
// other line is a proposed best-practice text (decision D93). English is proposed everywhere (UI-tokens A7). New text has no em dash (R-02): the one in
// `offlinePending` belongs to the approved fixed Arabic string, so the English line is written without it. No machine translation of a religious label.
import type { Locale } from "./messages";

export interface OfflineMessages {
  // ----- S-31 the shell -----
  shell: {
    screenName: string; // the H1 and the document title
    booting: string; // polite status while the local copy is read
    offlinePending: string; // fixed: the offline-pending line (offline-spec 4.5)
    ready: string; // fixed: «الخطة جاهزة دون اتصال»
    serverWaking: string; // fixed: G-01 line
    retry: string; // fixed: «إعادة المحاولة»
    sessionEnded: string; // fixed: G-03, for a device that holds an owner or a plan (a real ended session)
    signInPrompt: string; // a visitor who never signed in on this device: a neutral invitation, not "session ended"
    login: string;
    launcherOpening: string; // online: the app is opening
    unsupported: string; // no IndexedDB or no service worker in this browser
    noPlan: { title: string; body: string };
    incomplete: { title: string; body: string };
    locked: { title: string; body: string; action: string };
    schemaIncompatible: { title: string; body: string };
    storageError: { title: string; body: string };
    ownerMismatch: { title: string; body: string; action: string; clearing: string };
  };
  // ----- the local day (S-31 "local ready") -----
  home: {
    sessionsHeading: string;
    daily: string; // the prepared daily session
    dailyHint: string;
    start: string; // the button; the row name follows it for assistive technology
    startLabel: (name: string) => string;
    needsConnection: string; // fixed: «هذه اللعبة تحتاج اتصالًا لتجهيزها مجددًا», for a game the material has but whose prepared session is gone
    notAvailable: string; // «لا تتوفر هذه اللعبة لهذا الجزء», for a game the material has no question for: a connection would not help
    progressHeading: string;
    provisionalMinutes: (done: string, goal: string) => string;
    provisionalNote: string;
    lessonsHeading: string;
    lessonsOpen: string;
    lessonsHide: string;
    lessonsEmpty: string;
  };
  // ----- a run on the device -----
  run: { starting: string; storageFailed: string; startFailed: string };
  // ----- the local result of a run -----
  result: {
    title: string;
    answered: (n: string) => string;
    correct: (n: string) => string;
    activeTime: (clock: string) => string;
    note: string;
    back: string;
  };
  // ----- S-32 the download card -----
  download: {
    heading: string;
    body: string;
    cta: string;
    update: string;
    privacy: string;
    phases: { checking_storage: string; waking_server: string; preparing: string; validating: string; saving: string; done: string };
    readyBody: string;
    shellPending: string; // the plan is saved but the app files are not all cached yet
    staleBody: string;
    failed: string; // G-10 proposed
    storageFull: string;
    storageFailed: string;
    unsupported: string;
    offline: string;
    planChanged: string;
    refresh: string;
    notAvailable: string;
    notAvailableBody: string;
    throttled: string;
    schemaTooNew: string;
    ownerMismatch: string;
    clear: string; // the control that removes the local copy
    clearNote: string; // beside it: it does not delete the account
  };
  // ----- S-33 install, update, revalidation, sync -----
  install: {
    cta: string; // «تثبيت التطبيق»
    iosInstructions: string;
    openInBrowser: string; // fixed: «افتح في المتصفح»
    openInBrowserHint: string;
    notProof: string; // an install alone does not prove the plan is ready
  };
  update: { title: string; body: string; apply: string; applying: string; blocked: string; failed: string };
  revalidation: {
    staleTitle: string;
    staleBody: string;
    revokedLabel: string; // fixed: «غير متاح»
    revokedBody: string;
    expiredBody: string;
    pendingVerification: string; // fixed: G-21
    notCounted: string; // fixed: G-21
    pendingCount: (n: string) => string;
    blockedCount: (n: string) => string;
    blockedKept: string;
  };
  sync: {
    label: string;
    synced: string; // fixed: «متزامن»
    savedOnDevice: string; // fixed: G-22 «محفوظ على الجهاز، بانتظار المزامنة»
    syncing: string;
    syncNow: string;
    lastSync: (time: string) => string;
    never: string;
    unreachable: string;
    throttled: string;
    lockedElsewhere: string;
    failed: string;
    done: string;
  };
  // ----- S-22 / S-27 / logout -----
  settings: {
    heading: string;
    planLabel: string;
    planReady: string;
    planNone: string;
    clearButton: string;
    clearTitle: string;
    clearBody: (n: string) => string;
    clearConfirm: string;
    clearCancel: string;
    clearing: string;
    cleared: string;
    clearFailed: string;
    logoutLine: string; // fixed, S-27
  };
  logoutDialog: {
    title: string; // fixed
    body: (n: string) => string; // fixed
    confirm: string; // fixed
    cancel: string; // fixed
  };
  // ----- the page that is open when the connection drops (PWA-design 6). Proposed best-practice text, not a fixed string of the documents. -----
  notice: {
    title: string; // the device has no connection
    body: string; // the page stays open; what was typed is kept on this page only and is not saved; what needs a connection; the plan works offline
    server: string; // the browser is online but the free server does not answer
    open: string; // the button that opens the downloaded plan
    return: string; // the control that goes back from the downloaded plan to the page
  };
}

const ar: OfflineMessages = {
  shell: {
    screenName: "التعلم دون اتصال",
    booting: "جارٍ التحميل",
    offlinePending: "غير متصل \u2014 النتائج بانتظار التحقق",
    ready: "الخطة جاهزة دون اتصال",
    serverWaking: "جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.",
    retry: "إعادة المحاولة",
    sessionEnded: "انتهت جلستك. سجّل الدخول للمتابعة.",
    signInPrompt: "سجّل الدخول لتنزيل خطتك واستعمالها دون اتصال",
    login: "تسجيل الدخول",
    launcherOpening: "جارٍ فتح التطبيق",
    unsupported: "هذا المتصفح لا يدعم الاستخدام دون اتصال. افتح التطبيق في متصفح حديث.",
    noPlan: {
      title: "لا توجد خطة محمّلة على هذا الجهاز",
      body: "للتعلم دون اتصال، نزّل خطتك من شاشة «اليوم» وأنت متصل بالإنترنت.",
    },
    incomplete: {
      title: "لم يكتمل تنزيل الخطة",
      body: "اتصل بالإنترنت وأعد التنزيل من شاشة «اليوم». لا تُفتح خطة غير مكتملة.",
    },
    locked: {
      title: "الخطة المحفوظة مغلقة",
      body: "تعذّر مسح النسخة المحلية السابقة، لذلك أُغلق العرض الشخصي على هذا الجهاز. أعد المحاولة، وإن استمر ذلك فأعد تشغيل المتصفح.",
      action: "إعادة المحاولة",
    },
    schemaIncompatible: {
      title: "يلزم تحديث التطبيق",
      body: "هذه النسخة من التطبيق أقدم من البيانات المحفوظة على الجهاز. اتصل بالإنترنت وحدّث التطبيق. إجاباتك المحفوظة باقية ولن تُحذف.",
    },
    storageError: {
      title: "تعذّر الوصول إلى التخزين",
      body: "تعذّر قراءة الخطة المحفوظة على هذا الجهاز. حرّر مساحة أو أعد تشغيل المتصفح ثم أعد المحاولة.",
    },
    ownerMismatch: {
      title: "هذا الجهاز يحمل خطة حساب آخر",
      body: "الدخول الحالي بحساب مختلف عن الحساب الذي نُزّلت له الخطة المحفوظة على هذا الجهاز. لن تُرسل تلك الإجابات إلى هذا الحساب. لمتابعة حسابك الحالي احذف النسخة المحلية.",
      action: "احذف النسخة المحلية وتابع",
      clearing: "جارٍ الحذف",
    },
  },
  home: {
    sessionsHeading: "جلسات جاهزة على هذا الجهاز",
    daily: "جلسة اليوم",
    dailyHint: "تعلّم ومراجعة ضمن المقاطع المحمّلة",
    start: "ابدأ",
    startLabel: (name) => `ابدأ: ${name}`,
    needsConnection: "هذه اللعبة تحتاج اتصالًا لتجهيزها مجددًا",
    notAvailable: "لا تتوفر هذه اللعبة لهذا الجزء",
    progressHeading: "وقتك اليوم",
    provisionalMinutes: (done, goal) => `${done} من ${goal} دقيقة (مؤقت)`,
    provisionalNote: "رقم مؤقت من هذا الجهاز. يحلّ محلّه رقم الخادم بعد المزامنة.",
    lessonsHeading: "النصوص المحمّلة",
    lessonsOpen: "اعرض النصوص",
    lessonsHide: "أخفِ النصوص",
    lessonsEmpty: "لا توجد نصوص في هذه النسخة.",
  },
  run: {
    starting: "جارٍ تجهيز الجلسة",
    storageFailed: "تعذّر حفظ إجابتك على هذا الجهاز، فلم تُسجَّل. حرّر مساحة ثم اضغط «تحقق» مرة أخرى.",
    startFailed: "تعذّر فتح الجلسة على هذا الجهاز. ارجع إلى الجلسات وأعد المحاولة.",
  },
  result: {
    title: "انتهت الجلسة على هذا الجهاز",
    answered: (n) => `أجبتَ عن ${n} من الأسئلة`,
    correct: (n) => `الصحيح مؤقتًا: ${n}`,
    activeTime: (clock) => `وقت التعلم: ${clock}`,
    note: "هذه نتيجة مؤقتة محفوظة على جهازك. لا تُحتسب رسميًا ولا تُحتسب إنجازًا لليوم إلا بعد التحقق منها في الخادم عند الاتصال.",
    back: "العودة إلى الجلسات",
  },
  download: {
    heading: "التعلم دون اتصال",
    body: "نزّل خطتك لتتابع التعلم دون اتصال بالإنترنت. تُحمَّل النصوص والأسئلة الخاصة بخطتك فقط.",
    cta: "نزّل الخطة للاستخدام دون اتصال",
    update: "حدّث التنزيل",
    privacy:
      "تُحفظ الخطة على هذا الجهاز دون تشفير ودون قفل، ويستطيع من يستخدم الجهاز رؤية ما حُفظ عليه. أي تغيير في كلمة المرور أو حذف للحساب أو خروج من جهاز آخر يسري على هذا الجهاز بعد أن يعود متصلًا.",
    phases: {
      checking_storage: "جارٍ فحص مساحة التخزين",
      waking_server: "جارٍ تشغيل الخادم المجاني، قد يستغرق ذلك دقيقة.",
      preparing: "جارٍ تجهيز الخطة على الخادم",
      validating: "جارٍ التحقق من الخطة",
      saving: "جارٍ الحفظ على هذا الجهاز",
      done: "اكتمل التنزيل",
    },
    readyBody: "الخطة محفوظة على هذا الجهاز، ويمكنك فتح التطبيق وتعلّمها دون اتصال.",
    shellPending: "الخطة محفوظة، لكن ملفات التطبيق لم تُجهَّز بعد للعمل دون اتصال. أبقِ التطبيق مفتوحًا ومتصلًا قليلًا ثم أعد فتحه.",
    staleBody: "تغيّرت خطتك بعد التنزيل. حدّث التنزيل لتتابع دون اتصال.",
    failed: "تعذّر إكمال التنزيل. أعد المحاولة.",
    storageFull: "لا توجد مساحة كافية على هذا الجهاز. حرّر مساحة ثم أعد المحاولة.",
    storageFailed: "تعذّر الحفظ على هذا الجهاز. أعد المحاولة.",
    unsupported: "هذا المتصفح لا يدعم الحفظ على الجهاز.",
    offline: "يحتاج التنزيل إلى اتصال بالإنترنت.",
    planChanged: "تغيّرت خطتك. حدّث الصفحة ثم أعد المحاولة.",
    refresh: "تحديث",
    notAvailable: "غير متاح",
    notAvailableBody: "هذا الكتاب غير متاح للتنزيل الآن.",
    throttled: "محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.",
    schemaTooNew: "هذه النسخة من التطبيق أقدم من البيانات المحفوظة. حدّث التطبيق ثم أعد المحاولة.",
    ownerMismatch: "يحمل هذا الجهاز نسخة محلية لحساب آخر. احذفها من الإعدادات ثم أعد التنزيل.",
    clear: "احذف النسخة المحلية",
    clearNote: "يُحذف المحفوظ على هذا الجهاز فقط ولا يُحذف حسابك. أي إجابات لم تُزامن بعد تُحذف دون أن تُحفظ.",
  },
  install: {
    cta: "تثبيت التطبيق",
    iosInstructions: "لتثبيت التطبيق: اضغط زر المشاركة ثم اختر «إضافة إلى الشاشة الرئيسية».",
    openInBrowser: "افتح في المتصفح",
    openInBrowserHint: "المتصفحات المدمجة في بعض التطبيقات لا تدعم التثبيت ولا الاستخدام دون اتصال.",
    notProof: "التثبيت وحده لا يعني أن الخطة جاهزة دون اتصال. نزّل الخطة أيضًا.",
  },
  update: {
    title: "تحديث متاح",
    body: "يتوفر إصدار أحدث من التطبيق. يمكنك تطبيقه عندما لا تكون في جلسة.",
    apply: "حدّث الآن",
    applying: "جارٍ التحديث",
    blocked: "أنهِ الجلسة الجارية أولًا ثم حدّث.",
    failed: "تعذّر التحديث. أعد المحاولة.",
  },
  revalidation: {
    staleTitle: "الخطة المحمّلة قديمة",
    staleBody: "تغيّرت خطتك على الخادم. اتصل بالإنترنت وحدّث التنزيل لتتعلّم دون اتصال. إجاباتك المحفوظة باقية.",
    revokedLabel: "غير متاح",
    revokedBody: "لم يعد هذا المحتوى متاحًا، وحُذفت نسخته من هذا الجهاز. تبقى إجاباتك المحفوظة ظاهرة دون إرسال نص المحتوى.",
    expiredBody: "انتهت صلاحية هذه النسخة، وحُذفت من هذا الجهاز. اتصل بالإنترنت لتنزيل نسخة جديدة.",
    pendingVerification: "ما زالت هذه الإجابة قيد التحقق.",
    notCounted: "لم تُحتسب هذه الإجابة.",
    pendingCount: (n) => `إجابات قيد التحقق: ${n}`,
    blockedCount: (n) => `إجابات لم تُحتسب: ${n}`,
    blockedKept: "تبقى مسجّلة على هذا الجهاز ولا تُرسل مرة أخرى.",
  },
  sync: {
    label: "حالة المزامنة:",
    synced: "متزامن",
    savedOnDevice: "محفوظ على الجهاز، بانتظار المزامنة",
    syncing: "جارٍ المزامنة",
    syncNow: "زامن الآن",
    lastSync: (time) => `آخر مزامنة: ${time}`,
    never: "لم تُجرَ مزامنة بعد",
    unreachable: "تعذّر الوصول إلى الخادم. تبقى إجاباتك محفوظة على الجهاز.",
    throttled: "محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.",
    lockedElsewhere: "المزامنة جارية في نافذة أخرى.",
    failed: "تعذّرت المزامنة. تبقى إجاباتك محفوظة على الجهاز.",
    done: "اكتملت المزامنة",
  },
  settings: {
    heading: "الاستخدام دون اتصال",
    planLabel: "الخطة على هذا الجهاز:",
    planReady: "جاهزة",
    planNone: "غير محمّلة",
    clearButton: "احذف النسخة المحلية",
    clearTitle: "حذف النسخة المحلية؟",
    clearBody: (n) => `تُحذف الخطة المحفوظة من هذا الجهاز فقط ولا يُحذف حسابك. الإجابات التي لم تُزامن بعد (${n}) تُحذف دون أن تُحفظ.`,
    clearConfirm: "احذف النسخة المحلية",
    clearCancel: "إلغاء",
    clearing: "جارٍ الحذف",
    cleared: "حُذفت النسخة المحلية",
    clearFailed: "تعذّر حذف النسخة المحلية. أعد المحاولة.",
    logoutLine: "أي إجابات لم تُزامن بعد على هذا الجهاز ستُحذف دون أن تُحفظ.",
  },
  logoutDialog: {
    title: "تسجيل الخروج؟",
    body: (n) => `لديك ${n} إجابات لم تُزامن بعد. إن خرجت الآن فستُحذف من هذا الجهاز.`,
    confirm: "تسجيل الخروج",
    cancel: "إلغاء",
  },
  // Proposed best-practice text (D93), not a fixed string.
  notice: {
    title: "أنت غير متصل بالإنترنت",
    body: "تبقى هذه الصفحة مفتوحة، وما أدخلته فيها باقٍ في هذه الصفحة فقط ولم يُحفظ بعد. الحفظ وتسجيل الدخول وإنشاء خطة والتنزيل والمزامنة تحتاج اتصالًا. الخطة المحمّلة تعمل دون اتصال.",
    server: "الخادم غير متاح الآن. يمكنك متابعة التعلم بالخطة المحمّلة على هذا الجهاز.",
    open: "افتح الخطة المحمّلة",
    return: "العودة إلى الصفحة",
  },
};

const en: OfflineMessages = {
  shell: {
    screenName: "Learning offline",
    booting: "Loading",
    offlinePending: "Offline. Results are waiting to be verified.",
    ready: "Plan ready offline",
    serverWaking: "Starting the free server, this may take about a minute.",
    retry: "Try again",
    sessionEnded: "Your session has ended. Log in to continue.",
    signInPrompt: "Log in to download your plan and use it offline",
    login: "Log in",
    launcherOpening: "Opening the app",
    unsupported: "This browser does not support offline use. Open the app in a modern browser.",
    noPlan: {
      title: "No plan is downloaded on this device",
      body: "To learn offline, download your plan from the Today screen while you are connected to the internet.",
    },
    incomplete: {
      title: "The plan download is not complete",
      body: "Connect to the internet and download it again from the Today screen. An incomplete plan is never opened.",
    },
    locked: {
      title: "The saved plan is locked",
      body: "The previous local copy could not be cleared, so the personal view is locked on this device. Try again, and if it keeps failing, restart the browser.",
      action: "Try again",
    },
    schemaIncompatible: {
      title: "The app needs an update",
      body: "This version of the app is older than the data saved on this device. Connect to the internet and update the app. Your saved answers stay and are not deleted.",
    },
    storageError: {
      title: "Storage is not reachable",
      body: "The plan saved on this device could not be read. Free some space or restart the browser, then try again.",
    },
    ownerMismatch: {
      title: "This device holds another account's plan",
      body: "You are signed in with a different account from the one the saved plan on this device was downloaded for. Those answers will not be sent to this account. To continue with your current account, delete the local copy.",
      action: "Delete the local copy and continue",
      clearing: "Deleting",
    },
  },
  home: {
    sessionsHeading: "Sessions ready on this device",
    daily: "Today's session",
    dailyHint: "Learning and review within the downloaded passages",
    start: "Start",
    startLabel: (name) => `Start: ${name}`,
    needsConnection: "This game needs a connection to be prepared again",
    notAvailable: "This game is not available for this part",
    progressHeading: "Your time today",
    provisionalMinutes: (done, goal) => `${done} of ${goal} minutes (provisional)`,
    provisionalNote: "A provisional figure from this device. The server's figure replaces it after syncing.",
    lessonsHeading: "Downloaded texts",
    lessonsOpen: "Show the texts",
    lessonsHide: "Hide the texts",
    lessonsEmpty: "This copy has no texts.",
  },
  run: {
    starting: "Preparing the session",
    storageFailed: "Your answer could not be saved on this device, so it was not recorded. Free some space and press “Check” again.",
    startFailed: "The session could not be opened on this device. Go back to the sessions and try again.",
  },
  result: {
    title: "The session ended on this device",
    answered: (n) => `You answered ${n} questions`,
    correct: (n) => `Correct, provisionally: ${n}`,
    activeTime: (clock) => `Learning time: ${clock}`,
    note: "This is a provisional result saved on your device. It is not official and does not count toward the day until the server verifies it when you are connected.",
    back: "Back to the sessions",
  },
  download: {
    heading: "Learning offline",
    body: "Download your plan to keep learning without an internet connection. Only the texts and questions of your plan are downloaded.",
    cta: "Download the plan for offline use",
    update: "Update the download",
    privacy:
      "The plan is saved on this device without encryption and without a lock, and whoever uses the device can see what is saved on it. A password change, an account deletion or a logout from another device takes effect on this device after it is connected again.",
    phases: {
      checking_storage: "Checking storage space",
      waking_server: "Starting the free server, this may take about a minute.",
      preparing: "Preparing the plan on the server",
      validating: "Checking the plan",
      saving: "Saving on this device",
      done: "Download complete",
    },
    readyBody: "The plan is saved on this device. You can open the app and learn it offline.",
    shellPending: "The plan is saved, but the app files are not ready to work offline yet. Keep the app open and connected for a moment, then reopen it.",
    staleBody: "Your plan changed after the download. Update the download to keep going offline.",
    failed: "The download could not be completed. Try again.",
    storageFull: "There is not enough space on this device. Free some space and try again.",
    storageFailed: "Saving on this device failed. Try again.",
    unsupported: "This browser cannot save on the device.",
    offline: "Downloading needs an internet connection.",
    planChanged: "Your plan changed. Refresh the page and try again.",
    refresh: "Refresh",
    notAvailable: "Unavailable",
    notAvailableBody: "This book is not available to download right now.",
    throttled: "Too many attempts. Wait a moment and try again.",
    schemaTooNew: "This version of the app is older than the saved data. Update the app and try again.",
    ownerMismatch: "This device holds a local copy of another account. Delete it from Settings and download again.",
    clear: "Delete the local copy",
    clearNote: "Only what is saved on this device is deleted, not your account. Any answers that have not synced yet are deleted without being saved.",
  },
  install: {
    cta: "Install the app",
    iosInstructions: "To install the app: tap the Share button, then choose “Add to Home Screen”.",
    openInBrowser: "Open in the browser",
    openInBrowserHint: "Browsers built into some apps cannot install the app or run it offline.",
    notProof: "Installing alone does not mean the plan is ready offline. Download the plan too.",
  },
  update: {
    title: "Update available",
    body: "A newer version of the app is available. You can apply it when you are not in a session.",
    apply: "Update now",
    applying: "Updating",
    blocked: "Finish the current session first, then update.",
    failed: "The update failed. Try again.",
  },
  revalidation: {
    staleTitle: "The downloaded plan is out of date",
    staleBody: "Your plan changed on the server. Connect to the internet and update the download to learn offline. Your saved answers stay.",
    revokedLabel: "Unavailable",
    revokedBody: "This content is no longer available, and its copy was deleted from this device. Your saved answers stay without sending the content text.",
    expiredBody: "This copy has expired and was deleted from this device. Connect to the internet to download a new one.",
    pendingVerification: "This answer is still being verified.",
    notCounted: "This answer was not counted.",
    pendingCount: (n) => `Answers being verified: ${n}`,
    blockedCount: (n) => `Answers not counted: ${n}`,
    blockedKept: "They stay recorded on this device and are not sent again.",
  },
  sync: {
    label: "Sync status:",
    synced: "Synced",
    savedOnDevice: "Saved on the device, waiting to sync",
    syncing: "Syncing",
    syncNow: "Sync now",
    lastSync: (time) => `Last sync: ${time}`,
    never: "No sync yet",
    unreachable: "The server could not be reached. Your answers stay saved on this device.",
    throttled: "Too many attempts. Wait a moment and try again.",
    lockedElsewhere: "A sync is running in another window.",
    failed: "The sync failed. Your answers stay saved on this device.",
    done: "Sync complete",
  },
  settings: {
    heading: "Offline use",
    planLabel: "Plan on this device:",
    planReady: "Ready",
    planNone: "Not downloaded",
    clearButton: "Delete the local copy",
    clearTitle: "Delete the local copy?",
    clearBody: (n) => `The saved plan is deleted from this device only, not your account. The answers that have not synced yet (${n}) are deleted without being saved.`,
    clearConfirm: "Delete the local copy",
    clearCancel: "Cancel",
    clearing: "Deleting",
    cleared: "The local copy was deleted",
    clearFailed: "The local copy could not be deleted. Try again.",
    logoutLine: "Any answers that have not synced yet on this device will be deleted without being saved.",
  },
  logoutDialog: {
    title: "Log out?",
    body: (n) => `${n} answers have not synced yet. If you log out now they will be deleted from this device.`,
    confirm: "Log out",
    cancel: "Cancel",
  },
  // Proposed best-practice text (D93), not a fixed string.
  notice: {
    title: "You are offline",
    body: "This page stays open, and what you entered here is kept on this page only and is not saved yet. Saving, logging in, creating a plan, downloading and syncing need a connection. The downloaded plan works offline.",
    server: "The server is not available right now. You can keep learning with the plan downloaded on this device.",
    open: "Open the downloaded plan",
    return: "Back to the page",
  },
};

const CATALOGS: Record<Locale, OfflineMessages> = { ar, en };

export const offlineAr = ar;
export const offlineEn = en;

export function offlineMessages(locale: Locale): OfflineMessages {
  return CATALOGS[locale];
}
