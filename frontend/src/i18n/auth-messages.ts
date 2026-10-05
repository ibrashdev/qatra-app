// Strings of the account screens (UI-screens Batch 1). Arabic is verbatim where the spec fixes it; English is proposed (UI-tokens A7).
import type { UsernameRule } from "@/lib/auth/account-rules";

export interface LoginMessages {
  usernameLabel: string; // c3
  passwordLabel: string; // c4
  usernameRequired: string; // validation, on submit only
  passwordRequired: string;
  submit: string; // c6
  submitting: string;
  submittingStatus: string; // the polite announcement while E04 is in flight
  forgotPassword: string; // c7
  noAccount: string; // c8 text
  createAccount: string; // c8 link
  invalidCredentials: string; // G-04
  arrival: { sessionEnded: string; resetDone: string; accountDeleted: string }; // P-09
}

// S-02. The label and the helper of a field are separate strings: the spec joins them with a dash, which is never written on screen.
export interface RegisterMessages {
  backDestination: string; // c1: the screen the arrow names, in "Back to {destination}"
  lead: string; // c3
  termsLink: string; // c4
  usernameLabel: string; // c5
  usernameHelper: string;
  passwordLabel: string; // c6
  passwordHelper: string;
  confirmationLabel: string; // c8
  recoveryNotice: string; // c10
  consentLabel: string; // c11
  termsOfUse: string; // c12
  privacyStatement: string; // c13
  submit: string; // c14
  submitting: string;
  submittingStatus: string; // the polite announcement while E03 is in flight
  haveAccount: string; // c15 text
  loginLink: string; // c15 link
  usernameErrors: Record<UsernameRule | "taken", string>; // P-03 and G-08
  consentRequired: string; // G-18
  takenHint: string; // P-10, after a taken name that follows an uncertain outcome
  uncertain: string; // P-10
}

export interface AuthMessages {
  login: LoginMessages;
  register: RegisterMessages;
}

export const authAr: AuthMessages = {
  login: {
    usernameLabel: "اسم المستخدم",
    passwordLabel: "كلمة المرور",
    usernameRequired: "أدخل اسم المستخدم.",
    passwordRequired: "أدخل كلمة المرور.",
    submit: "دخول",
    submitting: "جارٍ الدخول…",
    submittingStatus: "جارٍ الدخول",
    forgotPassword: "نسيت كلمة المرور",
    noAccount: "ليس لديك حساب؟",
    createAccount: "إنشاء حساب",
    invalidCredentials: "اسم المستخدم أو كلمة المرور غير صحيحة.",
    arrival: {
      sessionEnded: "انتهت جلستك. سجّل الدخول للمتابعة.",
      resetDone: "تم تعيين كلمة مرور جديدة. سجّل الدخول بها.",
      accountDeleted: "تم حذف حسابك.",
    },
  },
  register: {
    backDestination: "تصفّح الكتب",
    lead: "لا نطلب بريدًا إلكترونيًا ولا رقم هاتف ولا تاريخ ميلاد؛ اسم مستخدم وكلمة مرور فقط. جميع الحقول مطلوبة.",
    termsLink: "شروط الاستخدام وبيان الخصوصية",
    usernameLabel: "اسم المستخدم",
    usernameHelper: "من ٣ إلى ٢٤ حرفًا: حروف عربية أو إنجليزية وأرقام وشرطة سفلية (_).",
    passwordLabel: "كلمة المرور",
    passwordHelper: "١٥ حرفًا على الأقل. يمكنك استخدام عبارة طويلة، ومدير كلمات المرور مقبول.",
    confirmationLabel: "تأكيد كلمة المرور",
    recoveryNotice: "بعد إنشاء الحساب نعرض لك رمز استرجاع مرة واحدة. إن فقدت كلمة المرور والرمز معًا فلا يمكننا استرجاع حسابك.",
    consentLabel: "قرأت شروط الاستخدام وبيان الخصوصية وأوافق عليها",
    termsOfUse: "شروط الاستخدام",
    privacyStatement: "بيان الخصوصية",
    submit: "إنشاء الحساب",
    submitting: "جارٍ إنشاء الحساب…",
    submittingStatus: "جارٍ إنشاء الحساب",
    haveAccount: "لديك حساب؟",
    loginLink: "تسجيل الدخول",
    usernameErrors: {
      empty: "أدخل اسم المستخدم.",
      username_invisible_or_space: "لا يقبل اسم المستخدم مسافات أو محارف غير مرئية.",
      username_chars: "يقبل اسم المستخدم حروفًا عربية أو إنجليزية وأرقامًا وشرطة سفلية فقط.",
      username_length: "اسم المستخدم من ٣ إلى ٢٤ حرفًا.",
      taken: "اسم المستخدم غير متاح. اختر اسمًا آخر.",
    },
    consentRequired: "يلزم الموافقة على شروط الاستخدام وبيان الخصوصية لإنشاء الحساب.",
    takenHint: "إن كنت قد أنشأت هذا الحساب قبل لحظات فسجّل الدخول بدل ذلك.",
    uncertain: "تعذّر تأكيد إنشاء الحساب. إن كان قد أُنشئ فسجّل الدخول بالاسم وكلمة المرور ثم أنشئ رمز استرجاع جديدًا من الإعدادات؛ وإلا أعد المحاولة.",
  },
};

export const authEn: AuthMessages = {
  login: {
    usernameLabel: "Username",
    passwordLabel: "Password",
    usernameRequired: "Enter your username.",
    passwordRequired: "Enter your password.",
    submit: "Log in",
    submitting: "Logging in…",
    submittingStatus: "Logging in",
    forgotPassword: "Forgot your password?",
    noAccount: "Don't have an account?",
    createAccount: "Create an account",
    invalidCredentials: "The username or password is not correct.",
    arrival: {
      sessionEnded: "Your session ended. Log in to continue.",
      resetDone: "Your new password is set. Log in with it.",
      accountDeleted: "Your account was deleted.",
    },
  },
  register: {
    backDestination: "Browse books",
    lead: "We do not ask for an email address, phone number or date of birth; only a username and a password. All fields are required.",
    termsLink: "Terms of use and privacy statement",
    usernameLabel: "Username",
    usernameHelper: "3 to 24 characters: Arabic or English letters, digits and underscore (_).",
    passwordLabel: "Password",
    passwordHelper: "At least 15 characters. A long phrase works well and a password manager is welcome.",
    confirmationLabel: "Confirm password",
    recoveryNotice: "After you create the account we show you a recovery code once. If you lose both your password and the code, we cannot recover your account.",
    consentLabel: "I have read the terms of use and privacy statement and I agree to them.",
    termsOfUse: "Terms of use",
    privacyStatement: "Privacy statement",
    submit: "Create account",
    submitting: "Creating your account…",
    submittingStatus: "Creating your account",
    haveAccount: "Already have an account?",
    loginLink: "Log in",
    usernameErrors: {
      empty: "Enter a username.",
      username_invisible_or_space: "A username cannot contain spaces or invisible characters.",
      username_chars: "A username can contain only Arabic or English letters, digits and underscore.",
      username_length: "The username must be 3 to 24 characters.",
      taken: "This username is not available. Choose another.",
    },
    consentRequired: "You must agree to the terms of use and privacy statement to create an account.",
    takenHint: "If you created this account a moment ago, log in instead.",
    uncertain:
      "We could not confirm that the account was created. If it was, log in with your username and password and create a new recovery code in Settings; otherwise try again.",
  },
};
