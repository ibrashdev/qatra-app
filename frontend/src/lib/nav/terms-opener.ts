// The screens that open S-03 (UI-screens S-03 "Entry"): the register form, the re-consent gate and, in the demo build (option C), the demo entry form S-28,
// which is the register form with another call. Any other way in, or none, is "home".
export type TermsOpener = "register" | "consent" | "demo" | "home";

export function termsOpener(route: string | null): TermsOpener {
  if (route === "/register") return "register";
  if (route === "/consent") return "consent";
  if (route === "/demo") return "demo";
  return "home";
}
