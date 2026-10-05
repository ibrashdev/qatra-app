import { Icon } from "@/components/ui/Icon";

// The Error recipe of UI-screens P-03 at a piece: glyph and text in the error colour, tied to the control by aria-describedby. No live region:
// the control takes focus and reads the description (S-15 4, "via the description").
export function ErrorLine({ id, message }: { id: string; message: string }) {
  return (
    <p id={id} className="flex items-start gap-q8 text-small text-error-ink">
      <Icon name="error" size="sm" className="mt-1" />
      {message}
    </p>
  );
}
