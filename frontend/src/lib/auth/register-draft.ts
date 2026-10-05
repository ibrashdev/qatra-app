// What S-02 keeps while the visitor reads S-03 (UI-screens S-02 "Dialogs"): the typed values, passwords included, and the box, in memory only.
// Never storage, never the URL. Gone on a reload (the module is new), and wiped on a successful registration, a login and a logout.

export interface RegisterDraft {
  username: string;
  password: string;
  confirmation: string;
  consent: boolean;
}

let draft: RegisterDraft | null = null;

export function saveRegisterDraft(values: RegisterDraft): void {
  draft = { ...values };
}

// A copy, so a caller cannot change what is kept.
export function readRegisterDraft(): RegisterDraft | null {
  return draft === null ? null : { ...draft };
}

export function clearRegisterDraft(): void {
  draft = null;
}
