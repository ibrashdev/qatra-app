import { Icon } from "@/components/ui/Icon";

// UI-tokens 6.14 empty state: a 32 px line icon, the title, at most one sentence, no illustration and no button here (the screen's own actions stay).
// Used by S-07 (title and sentence) and S-25 (title only). The announcement is made by the screen's status region, not by this block.
export function CatalogEmpty({ title, text }: { title: string; text?: string }) {
  return (
    <section aria-label={title} className="mt-q24 flex flex-col items-start gap-q12">
      <Icon name="droplet" size="xl" className="text-ink-secondary" />
      <h2 className="text-section text-ink">{title}</h2>
      {text !== undefined ? <p className="text-body text-ink-secondary">{text}</p> : null}
    </section>
  );
}
