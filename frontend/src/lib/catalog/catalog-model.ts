import type { Locale } from "@/i18n/messages";
import type { CatalogEdition, CatalogSection } from "@/lib/api/types";

// The two titles every catalog record carries (S-07 c7, S-25 c3): the interface language picks one, the other is never shown beside it (O-19).
export const editionTitle = (locale: Locale, edition: Pick<CatalogEdition, "titleAr" | "titleEn">): string => (locale === "ar" ? edition.titleAr : edition.titleEn);

export const sectionTitle = (locale: Locale, section: Pick<CatalogSection, "titleAr" | "titleEn">): string => (locale === "ar" ? section.titleAr : section.titleEn);

export const categoryLabel = (locale: Locale, category: CatalogEdition["category"]): string => (locale === "ar" ? category.labelAr : category.labelEn);

export interface CategoryGroup {
  slug: string;
  category: CatalogEdition["category"];
  editions: CatalogEdition[];
}

// E14 returns editions by category display order, then editionKey (API-spec 1.13), so the editions of one category are side by side and
// one heading serves them all. The order received is kept; nothing is sorted here.
export function groupByCategory(editions: readonly CatalogEdition[]): CategoryGroup[] {
  const groups: CategoryGroup[] = [];
  for (const edition of editions) {
    const last = groups.at(-1);
    if (last !== undefined && last.slug === edition.category.slug) {
      last.editions.push(edition);
    } else {
      groups.push({ slug: edition.category.slug, category: edition.category, editions: [edition] });
    }
  }
  return groups;
}

// The book of the learner's plan, as E18 names it. E14 has no row for an edition it no longer lists, so the plan carries the titles (S-25 O-49).
export interface PlanEdition {
  editionId: string;
  titleAr: string;
  titleEn: string;
}

export const planEditionOf = (plan: PlanEdition | null | undefined): PlanEdition | null =>
  plan === null || plan === undefined ? null : { editionId: plan.editionId, titleAr: plan.titleAr, titleEn: plan.titleEn };

// S-25 c8: true when E18 names an edition that E14 does not list any more.
export const isPlanEditionUnavailable = (editions: readonly CatalogEdition[], plan: PlanEdition | null): boolean =>
  plan !== null && !editions.some((edition) => edition.editionId === plan.editionId);
