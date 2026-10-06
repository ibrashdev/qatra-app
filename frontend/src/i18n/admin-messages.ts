// Content manager screens AD-00 to AD-06 (docs/Content-admin.md, D91). Arabic is the primary text and follows the owner's wording where the
// brief fixed it (the statuses, the rights states, the withdrawal reasons and the six notices); the rest is written in the same calm style.
// English is proposed. No dash is written in any line (D80). The failure lines are fixed copy: the `message` of the server is never shown.
import type { EditionStatus, RightsStatus, WithdrawReason } from "@/lib/api/admin-types";
import type { Locale } from "./messages";

export interface AdminMessages {
  screenName: string; // AD-01, the H1 and the document title; also the label of the row in settings (AD-00)
  screens: { edition: string; section: string; books: string; categories: string; sources: string };
  notManager: string; // a 403 on any admin read
  backToSettings: string;
  displayOnlyNote: string; // AD-01
  sourceTextNote: string; // AD-03
  statuses: Record<EditionStatus, string>;
  rights: Record<RightsStatus, string>;
  withdrawReasons: Record<WithdrawReason, string>;
  languages: Record<string, string>; // by language code; an unknown code is shown as it is
  contentFormats: Record<string, string>;
  hiddenMark: string;
  notAvailable: string; // a counter or a date the server could not give
  none: string;
  failures: {
    stale: string;
    inUse: string;
    state: string;
    notFound: string;
    invalid: string;
    reload: string; // the button that reads the data again
    backToList: string; // the link under a row that no longer exists
  };
  rules: {
    required: string;
    tooLong: (max: string) => string;
    control: string;
    https: string;
    notInteger: string;
    outOfRange: (min: string, max: string) => string;
    chooseReason: string;
    noChange: string;
  };
  buttons: { edit: string; delete: string; cancel: string; save: string; saving: string; view: string };
  names: {
    edit: (name: string) => string; // the accessible name of an Edit button
    delete: (name: string) => string;
    rename: (name: string) => string;
    view: (name: string) => string;
  };
  toasts: { saved: string; deleted: string; hidden: string; shown: string; withdrawn: string };
  home: {
    manageHeading: string;
    rows: { books: string; categories: string; sources: string };
    editionsByStatus: string;
    aiHeading: string;
    aiNote: string;
    ai: {
      chat: string;
      chatOn: string;
      chatOff: string;
      provider: string;
      providerOn: string;
      providerOff: string;
      models: string;
      noModels: string;
      dailyCap: string;
      usedToday: string;
      usedLastMinute: string;
      footnote: string;
    };
    editionsHeading: string;
    editionsEmpty: string;
    version: (formatted: string) => string;
  };
  edition: {
    detailsHeading: string;
    fields: {
      key: string;
      label: string;
      book: string;
      language: string;
      version: string;
      bankVersion: string;
      status: string;
      visibility: string;
      visible: string;
      hiddenSince: string;
      source: string;
      provider: string;
      rights: string;
      hash: string;
      updated: string;
    };
    approvalHeading: string;
    approval: { who: string; at: string; scope: string; words: string; source: string };
    withdrawalHeading: string;
    withdrawal: { reason: string; note: string; at: string };
    countsHeading: string;
    counts: { sections: string; units: string; passages: string; lessons: string; questions: string };
    actionsHeading: string;
    actions: { rename: string; hide: string; show: string; withdraw: string; deleteDraft: string };
    noActions: string;
    reversibleNote: string;
    sectionsHeading: string;
    sectionsEmpty: string;
    renameSection: string;
    reference: string;
    jobsHeading: string;
    jobsEmpty: string;
    publishedAt: string;
    renameDialog: { title: string; label: string };
    withdrawDialog: { title: string; warning: string; reasonLegend: string; noteLabel: string; noteHelper: string; confirm: string };
    deleteDialog: { title: string; body: string; confirm: string }; // body has {name}
  };
  section: {
    titlesHeading: string;
    titleAr: string;
    titleEn: string;
    rename: string;
    renameDialogTitle: string;
    renameBlocked: string;
    infoHeading: string;
    fields: { ordinal: string; kind: string; reference: string; edition: string };
    questionsHeading: string;
    questionTypes: { wordOrder: string; wordChoice: string; wordRecall: string; similarDistinction: string };
    unitsHeading: string;
    unitsEmpty: string;
  };
  books: {
    empty: string;
    fields: { titleAr: string; titleEn: string; author: string; category: string; format: string; editions: string };
    dialogTitle: string;
    deleteDialog: { title: string; body: string; confirm: string };
  };
  categories: {
    empty: string;
    fields: { labelAr: string; labelEn: string; order: string; slug: string; books: string };
    orderHelper: string;
    dialogTitle: string;
    deleteDialog: { title: string; body: string; confirm: string };
  };
  sources: {
    empty: string;
    fields: { title: string; provider: string; licenseUrl: string; rights: string; sourceUrl: string; checkedAt: string; editions: string };
    licenseHelper: string;
    dialogTitle: string;
    deleteDialog: { title: string; body: string; confirm: string };
  };
}

const ar: AdminMessages = {
  screenName: "إدارة المحتوى",
  screens: { edition: "تفاصيل الطبعة", section: "تفاصيل القسم", books: "الكتب", categories: "التصنيفات", sources: "مصادر المحتوى" },
  notManager: "هذه الصفحة لمدير المحتوى فقط.",
  backToSettings: "العودة إلى الإعدادات",
  displayOnlyNote: "التعديل هنا على بيانات العرض فقط. النص الأصلي لا يُعدَّل من هنا.",
  sourceTextNote: "النص معروض كما في المصدر ولا يمكن تعديله.",
  statuses: { draft: "مسودة", validated: "تم فحصها", published: "منشورة", superseded: "مستبدلة", revoked: "مسحوبة" },
  rights: { owner_accepted_pending_verification: "مقبول من المالك بانتظار التحقق", verified: "تم التحقق", rejected: "مرفوض" },
  withdrawReasons: { transmission: "خلل في النقل", rights: "حقوق النشر", accreditation: "الاعتماد العلمي" },
  languages: { ar: "العربية", en: "الإنجليزية" },
  contentFormats: { quran: "نص قرآني", hadith_collection: "مجموعة أحاديث" },
  hiddenMark: "مخفية من الفهرس",
  notAvailable: "غير متاح",
  none: "لا يوجد",
  failures: {
    stale: "تغيّرت البيانات منذ فتح الصفحة. أعد التحميل ثم حاول مرة أخرى.",
    inUse: "لا يمكن الحذف لأن عناصر أخرى تستخدم هذا العنصر.",
    state: "هذا الإجراء غير متاح في حالة الطبعة الحالية.",
    notFound: "لم يعد هذا العنصر موجودًا.",
    invalid: "تعذّر قبول القيم المدخلة. راجعها ثم حاول مرة أخرى.",
    reload: "إعادة التحميل",
    backToList: "العودة إلى القائمة",
  },
  rules: {
    required: "هذا الحقل مطلوب.",
    tooLong: (max) => `النص أطول من الحد المسموح (${max} حرفًا).`,
    control: "يحتوي النص على رموز غير مسموحة.",
    https: "يجب أن يبدأ الرابط بـ https://",
    notInteger: "أدخل رقمًا صحيحًا.",
    outOfRange: (min, max) => `أدخل رقمًا بين ${min} و${max}.`,
    chooseReason: "اختر سبب السحب.",
    noChange: "لا توجد تغييرات للحفظ.",
  },
  buttons: { edit: "تعديل", delete: "حذف", cancel: "إلغاء", save: "حفظ", saving: "جارٍ الحفظ…", view: "عرض" },
  names: {
    edit: (name) => `تعديل ${name}`,
    delete: (name) => `حذف ${name}`,
    rename: (name) => `تغيير اسم ${name}`,
    view: (name) => `عرض ${name}`,
  },
  toasts: { saved: "تم حفظ التعديل", deleted: "تم الحذف", hidden: "أُخفيت الطبعة من الفهرس", shown: "أُظهرت الطبعة في الفهرس", withdrawn: "سُحبت الطبعة" },
  home: {
    manageHeading: "الكتب والتصنيفات والمصادر",
    rows: { books: "الكتب", categories: "التصنيفات", sources: "مصادر المحتوى" },
    editionsByStatus: "الطبعات حسب الحالة",
    aiHeading: "حالة الذكاء الاصطناعي",
    aiNote: "للعرض فقط. الذكاء الاصطناعي لا يكتب المحتوى ولا يعدّله.",
    ai: {
      chat: "محادثة الخطة للمتعلمين",
      chatOn: "مفعّلة",
      chatOff: "معطّلة",
      provider: "مفتاح المزوّد",
      providerOn: "مضبوط",
      providerOff: "غير مضبوط",
      models: "النماذج المجانية",
      noModels: "لا توجد نماذج",
      dailyCap: "الحد اليومي للطلبات",
      usedToday: "طلبات اليوم",
      usedLastMinute: "طلبات آخر دقيقة",
      footnote: "العدّادات من ذاكرة الخادم وتُصفَّر عند إعادة تشغيله. القواعد الجاهزة تبقى البديل الدائم.",
    },
    editionsHeading: "الطبعات",
    editionsEmpty: "لا توجد طبعات.",
    version: (formatted) => `الإصدار ${formatted}`,
  },
  edition: {
    detailsHeading: "البيانات الأساسية",
    fields: {
      key: "معرّف الطبعة",
      label: "تسمية الطبعة",
      book: "الكتاب",
      language: "اللغة",
      version: "الإصدار",
      bankVersion: "إصدار بنك الأسئلة",
      status: "الحالة",
      visibility: "الظهور في الفهرس",
      visible: "ظاهرة",
      hiddenSince: "تاريخ الإخفاء",
      source: "المصدر",
      provider: "الجهة المزوّدة",
      rights: "حالة الحقوق",
      hash: "بصمة المحتوى",
      updated: "آخر تحديث",
    },
    approvalHeading: "سجل الاعتماد",
    approval: { who: "اعتمدها", at: "تاريخ الاعتماد", scope: "النطاق", words: "كلمات الاعتماد", source: "المصدر المعتمد" },
    withdrawalHeading: "سجل السحب",
    withdrawal: { reason: "السبب", note: "الملاحظة", at: "تاريخ السحب" },
    countsHeading: "محتوى الطبعة",
    counts: { sections: "الأقسام", units: "الوحدات", passages: "المقاطع", lessons: "الدروس", questions: "الأسئلة" },
    actionsHeading: "الإجراءات",
    actions: { rename: "تغيير تسمية الطبعة", hide: "إخفاء من الفهرس", show: "إظهار في الفهرس", withdraw: "سحب الطبعة", deleteDraft: "حذف المسودة" },
    noActions: "لا توجد إجراءات متاحة في حالة الطبعة الحالية.",
    reversibleNote: "الإخفاء من الفهرس يمكن التراجع عنه، أما سحب الطبعة فنهائي.",
    sectionsHeading: "الأقسام",
    sectionsEmpty: "لا توجد أقسام.",
    renameSection: "تغيير الاسم",
    reference: "المرجع",
    jobsHeading: "سجل المراحل",
    jobsEmpty: "لا توجد مراحل مسجّلة.",
    publishedAt: "تاريخ النشر",
    renameDialog: { title: "تغيير تسمية الطبعة", label: "تسمية الطبعة" },
    withdrawDialog: {
      title: "سحب الطبعة",
      warning: "سحب الطبعة نهائي ولا يمكن التراجع عنه. ستتوقف عن الظهور للمتعلمين.",
      reasonLegend: "سبب السحب",
      noteLabel: "ملاحظة السحب",
      noteHelper: "اكتب سبب السحب باختصار.",
      confirm: "سحب الطبعة نهائيًا",
    },
    deleteDialog: { title: "حذف المسودة", body: "ستُحذف المسودة {name} وكل أقسامها ووحداتها نهائيًا. لا يمكن التراجع عن ذلك.", confirm: "حذف المسودة" },
  },
  section: {
    titlesHeading: "العنوان",
    titleAr: "العنوان بالعربية",
    titleEn: "العنوان بالإنجليزية",
    rename: "تغيير الاسم",
    renameDialogTitle: "تغيير اسم القسم",
    renameBlocked: "لا يمكن تغيير الاسم لأن الطبعة مسحوبة.",
    infoHeading: "بيانات القسم",
    fields: { ordinal: "الترتيب", kind: "النوع", reference: "المرجع", edition: "الطبعة" },
    questionsHeading: "الأسئلة حسب اللعبة",
    questionTypes: { wordOrder: "ترتيب الكلمات", wordChoice: "اختيار كلمة أو جزء", wordRecall: "استرجاع كلمة", similarDistinction: "تمييز المتشابه" },
    unitsHeading: "النص الأصلي",
    unitsEmpty: "لا توجد وحدات.",
  },
  books: {
    empty: "لا توجد كتب.",
    fields: { titleAr: "العنوان بالعربية", titleEn: "العنوان بالإنجليزية (اختياري)", author: "المؤلف", category: "التصنيف", format: "نوع المحتوى", editions: "عدد الطبعات" },
    dialogTitle: "تعديل الكتاب",
    deleteDialog: { title: "حذف الكتاب", body: "سيُحذف الكتاب {name} نهائيًا. لا يمكن التراجع عن ذلك.", confirm: "حذف الكتاب" },
  },
  categories: {
    empty: "لا توجد تصنيفات.",
    fields: { labelAr: "الاسم بالعربية", labelEn: "الاسم بالإنجليزية (اختياري)", order: "ترتيب العرض", slug: "المعرّف", books: "عدد الكتب" },
    orderHelper: "رقم صحيح من ٠ إلى ٩٩٩٩.",
    dialogTitle: "تعديل التصنيف",
    deleteDialog: { title: "حذف التصنيف", body: "سيُحذف التصنيف {name} نهائيًا. لا يمكن التراجع عن ذلك.", confirm: "حذف التصنيف" },
  },
  sources: {
    empty: "لا توجد مصادر.",
    fields: {
      title: "العنوان",
      provider: "الجهة المزوّدة",
      licenseUrl: "رابط الترخيص (اختياري)",
      rights: "حالة الحقوق",
      sourceUrl: "رابط المصدر",
      checkedAt: "تاريخ الفحص",
      editions: "عدد الطبعات",
    },
    licenseHelper: "يبدأ الرابط بـ https://. اتركه فارغًا لمسحه.",
    dialogTitle: "تعديل المصدر",
    deleteDialog: { title: "حذف المصدر", body: "سيُحذف المصدر {name} نهائيًا. لا يمكن التراجع عن ذلك.", confirm: "حذف المصدر" },
  },
};

const en: AdminMessages = {
  screenName: "Content management",
  screens: { edition: "Edition details", section: "Section details", books: "Books", categories: "Categories", sources: "Content sources" },
  notManager: "This page is for the content manager only.",
  backToSettings: "Back to settings",
  displayOnlyNote: "Edits here change display data only. The original text is never edited from here.",
  sourceTextNote: "The text is shown as in the source and cannot be edited.",
  statuses: { draft: "Draft", validated: "Checked", published: "Published", superseded: "Superseded", revoked: "Withdrawn" },
  rights: { owner_accepted_pending_verification: "Accepted by the owner, pending verification", verified: "Verified", rejected: "Rejected" },
  withdrawReasons: { transmission: "Transmission fault", rights: "Copyright", accreditation: "Scholarly accreditation" },
  languages: { ar: "Arabic", en: "English" },
  contentFormats: { quran: "Quran text", hadith_collection: "Hadith collection" },
  hiddenMark: "Hidden from the catalog",
  notAvailable: "Not available",
  none: "None",
  failures: {
    stale: "The data changed since you opened the page. Reload it and try again.",
    inUse: "It cannot be deleted because other items use it.",
    state: "This action is not available in the current state of the edition.",
    notFound: "This item no longer exists.",
    invalid: "The values could not be accepted. Check them and try again.",
    reload: "Reload",
    backToList: "Back to the list",
  },
  rules: {
    required: "This field is required.",
    tooLong: (max) => `The text is longer than allowed (${max} characters).`,
    control: "The text contains characters that are not allowed.",
    https: "The link must start with https://",
    notInteger: "Enter a whole number.",
    outOfRange: (min, max) => `Enter a number from ${min} to ${max}.`,
    chooseReason: "Choose the reason for the withdrawal.",
    noChange: "There are no changes to save.",
  },
  buttons: { edit: "Edit", delete: "Delete", cancel: "Cancel", save: "Save", saving: "Saving…", view: "View" },
  names: {
    edit: (name) => `Edit ${name}`,
    delete: (name) => `Delete ${name}`,
    rename: (name) => `Rename ${name}`,
    view: (name) => `View ${name}`,
  },
  toasts: { saved: "Change saved", deleted: "Deleted", hidden: "The edition is hidden from the catalog", shown: "The edition is shown in the catalog", withdrawn: "The edition was withdrawn" },
  home: {
    manageHeading: "Books, categories and sources",
    rows: { books: "Books", categories: "Categories", sources: "Content sources" },
    editionsByStatus: "Editions by status",
    aiHeading: "AI status",
    aiNote: "Read only. AI never writes or edits content.",
    ai: {
      chat: "Plan conversation for learners",
      chatOn: "On",
      chatOff: "Off",
      provider: "Provider key",
      providerOn: "Configured",
      providerOff: "Not configured",
      models: "Free models",
      noModels: "No models",
      dailyCap: "Daily request cap",
      usedToday: "Requests today",
      usedLastMinute: "Requests in the last minute",
      footnote: "The counters come from the memory of the server and reset when it restarts. The rules engine stays the permanent fallback.",
    },
    editionsHeading: "Editions",
    editionsEmpty: "There are no editions.",
    version: (formatted) => `Version ${formatted}`,
  },
  edition: {
    detailsHeading: "Basic details",
    fields: {
      key: "Edition key",
      label: "Edition label",
      book: "Book",
      language: "Language",
      version: "Version",
      bankVersion: "Question bank version",
      status: "Status",
      visibility: "Catalog visibility",
      visible: "Shown",
      hiddenSince: "Hidden on",
      source: "Source",
      provider: "Provider",
      rights: "Rights status",
      hash: "Content hash",
      updated: "Last updated",
    },
    approvalHeading: "Approval record",
    approval: { who: "Approved by", at: "Approved on", scope: "Scope", words: "Approval words", source: "Approved source" },
    withdrawalHeading: "Withdrawal record",
    withdrawal: { reason: "Reason", note: "Note", at: "Withdrawn on" },
    countsHeading: "Edition content",
    counts: { sections: "Sections", units: "Units", passages: "Passages", lessons: "Lessons", questions: "Questions" },
    actionsHeading: "Actions",
    actions: { rename: "Rename the edition", hide: "Hide from the catalog", show: "Show in the catalog", withdraw: "Withdraw the edition", deleteDraft: "Delete the draft" },
    noActions: "No actions are available in the current state of the edition.",
    reversibleNote: "Hiding from the catalog can be undone. Withdrawing the edition is final.",
    sectionsHeading: "Sections",
    sectionsEmpty: "There are no sections.",
    renameSection: "Rename",
    reference: "Reference",
    jobsHeading: "Step history",
    jobsEmpty: "No steps are recorded.",
    publishedAt: "Published on",
    renameDialog: { title: "Rename the edition", label: "Edition label" },
    withdrawDialog: {
      title: "Withdraw the edition",
      warning: "Withdrawing an edition is final and cannot be undone. It will stop appearing to learners.",
      reasonLegend: "Reason for the withdrawal",
      noteLabel: "Withdrawal note",
      noteHelper: "Write the reason for the withdrawal briefly.",
      confirm: "Withdraw permanently",
    },
    deleteDialog: { title: "Delete the draft", body: "The draft {name} and all its sections and units will be deleted permanently. This cannot be undone.", confirm: "Delete the draft" },
  },
  section: {
    titlesHeading: "Title",
    titleAr: "Arabic title",
    titleEn: "English title",
    rename: "Rename",
    renameDialogTitle: "Rename the section",
    renameBlocked: "The name cannot be changed because the edition is withdrawn.",
    infoHeading: "Section details",
    fields: { ordinal: "Order", kind: "Kind", reference: "Reference", edition: "Edition" },
    questionsHeading: "Questions by game",
    questionTypes: { wordOrder: "Word order", wordChoice: "Word or segment choice", wordRecall: "Word recall", similarDistinction: "Similar distinction" },
    unitsHeading: "Original text",
    unitsEmpty: "There are no units.",
  },
  books: {
    empty: "There are no books.",
    fields: { titleAr: "Arabic title", titleEn: "English title (optional)", author: "Author", category: "Category", format: "Content type", editions: "Editions" },
    dialogTitle: "Edit the book",
    deleteDialog: { title: "Delete the book", body: "The book {name} will be deleted permanently. This cannot be undone.", confirm: "Delete the book" },
  },
  categories: {
    empty: "There are no categories.",
    fields: { labelAr: "Arabic name", labelEn: "English name (optional)", order: "Display order", slug: "Identifier", books: "Books" },
    orderHelper: "A whole number from 0 to 9999.",
    dialogTitle: "Edit the category",
    deleteDialog: { title: "Delete the category", body: "The category {name} will be deleted permanently. This cannot be undone.", confirm: "Delete the category" },
  },
  sources: {
    empty: "There are no sources.",
    fields: { title: "Title", provider: "Provider", licenseUrl: "License link (optional)", rights: "Rights status", sourceUrl: "Source link", checkedAt: "Checked on", editions: "Editions" },
    licenseHelper: "The link starts with https://. Leave it empty to clear it.",
    dialogTitle: "Edit the source",
    deleteDialog: { title: "Delete the source", body: "The source {name} will be deleted permanently. This cannot be undone.", confirm: "Delete the source" },
  },
};

const CATALOGS: Record<Locale, AdminMessages> = { ar, en };

export function adminMessages(locale: Locale): AdminMessages {
  return CATALOGS[locale];
}
