"use client";

import Link from "next/link";
import { LinkButton } from "@/components/progress/LinkButton";
import { TEXT_BUTTON_CLASS } from "@/components/ui/TextButton";
import { useLocale } from "@/i18n/LocaleProvider";
import { catalogMessages } from "@/i18n/catalog-messages";

// S-07 c2: «إنشاء حساب» (Primary) then «تسجيل الدخول» (Tertiary), links styled as buttons. The screen renders the pair twice, in the header from 768 px
// and under the intro below it, and CSS shows one, so the hidden copy is out of the tab order.
export function AuthActions() {
  const { locale } = useLocale();
  const t = catalogMessages(locale);
  return (
    <>
      <LinkButton href="/register">{t.createAccount}</LinkButton>
      <Link href="/login" className={TEXT_BUTTON_CLASS}>
        {t.logIn}
      </Link>
    </>
  );
}
