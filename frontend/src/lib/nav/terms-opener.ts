// The screens that open S-03 (UI-screens S-03 "Entry"): the register form and the re-consent gate. Any other way in, or none, is "home".
export type TermsOpener = "register" | "consent" | "home";

export function termsOpener(route: string | null): TermsOpener {
  if (route === "/register") return "register";
  if (route === "/consent") return "consent";
  return "home";
}
