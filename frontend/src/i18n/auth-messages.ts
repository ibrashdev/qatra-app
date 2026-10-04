// Strings of the account screens (UI-screens Batch 1). Arabic is verbatim where the spec fixes it; English is proposed (UI-tokens A7).

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

export interface AuthMessages {
  login: LoginMessages;
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
};
