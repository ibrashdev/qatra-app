"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { cx } from "@/lib/cx";
import { Icon } from "./Icon";
import { TextButton } from "./TextButton";

export type MultiSelectRowState = "unchecked" | "checked" | "mixed";

export interface MultiSelectRow {
  id: string;
  title: string;
  // The reference after the title, in small secondary text (a surah number, a hadith number).
  reference?: string;
  // A line under the title (the count of a group row: «١٠ أحاديث»).
  note?: string;
  state: MultiSelectRowState;
  // At the limit the unchecked rows lock with aria-disabled; a locked row ignores its press.
  locked?: boolean;
  lang?: string;
  // A group row (D88) carries a tertiary disclosure button, collapsed at first, that reveals `childRows` as indented rows directly under it.
  // `label` is the visible text of the button («تخصيص»), `name` its accessible name («تخصيص» and the group label).
  disclosure?: { label: string; name: string; childRows: readonly MultiSelectRow[] };
}

// One chip: a row, or a group, that is checked. The caller decides what a chip stands for (a whole group is one chip, D88).
export interface MultiSelectChip {
  id: string;
  title: string;
  lang?: string;
}

// The chips row shows while one to six chips result; from seven the count and the checked rows are the summary (6.26).
export const MAX_CHIPS = 6;

export interface MultiSelectProps {
  legend: string;
  countText: string;
  rows: readonly MultiSelectRow[];
  // Optional: the chips the caller computed. Without it, one chip stands for each row that is not unchecked.
  chips?: readonly MultiSelectChip[];
  selectAll: { label: string; inert: boolean; hidden: boolean };
  clear: { label: string; inert: boolean };
  chipsLabel: string;
  // All checked: the count line says it, so no chip repeats it.
  chipsHidden?: boolean;
  removeLabel: (title: string) => string;
  limitHelper: string | null;
  onToggleRow: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  // A chip's remove button: the row or group it belongs to is unchecked (the caller owns the selection).
  onRemoveChip: (id: string) => void;
}

// UI-tokens 6.26. A fieldset with a visible legend, described by the count line. In DOM and visual order: the tools row (count line, select all,
// clear), the chips, then the rows. Rows are native checkboxes, one tab stop each, the whole row is the target. The list stays in the page flow
// (no inner scroll area) and runs in two CSS columns from 768 px, so reading and tab order stay the DOM order. A group row is followed by its
// «تخصيص» button, and an open group's rows by that button. Which groups are open is state of this component only: it is not part of the
// selection, and the caller gives the component a new `key` when the list changes so no group stays open across books.
export function MultiSelect({
  legend,
  countText,
  rows,
  chips: chipsProp,
  selectAll,
  clear,
  chipsLabel,
  chipsHidden = false,
  removeLabel,
  limitHelper,
  onToggleRow,
  onSelectAll,
  onClear,
  onRemoveChip,
}: MultiSelectProps) {
  const countId = useId();
  const listId = useId();
  const rowInputs = useRef(new Map<string, HTMLInputElement>());
  const chipButtons = useRef(new Map<string, HTMLButtonElement>());
  // Where focus goes once the removed chip has left the page (set at the press, used after the render that drops the chip).
  const focusAfterRemoval = useRef<{ kind: "chip" | "row"; id: string } | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());

  const chips: readonly MultiSelectChip[] = chipsProp ?? rows.filter((row) => row.state !== "unchecked");
  const showChips = !chipsHidden && chips.length >= 1 && chips.length <= MAX_CHIPS;

  function removeChip(id: string) {
    const index = chips.findIndex((chip) => chip.id === id);
    // The next chip's remove button, else the previous one, else the first row (UI-tokens 6.26).
    const neighbour = chips[index + 1] ?? chips[index - 1];
    focusAfterRemoval.current = neighbour ? { kind: "chip", id: neighbour.id } : { kind: "row", id: rows[0]?.id ?? "" };
    onRemoveChip(id);
  }

  function toggleOpen(id: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useLayoutEffect(() => {
    const target = focusAfterRemoval.current;
    if (!target) return;
    focusAfterRemoval.current = null;
    (target.kind === "chip" ? chipButtons.current.get(target.id) : rowInputs.current.get(target.id))?.focus();
  });

  const registerRow = (id: string) => (node: HTMLInputElement | null) => {
    if (node) rowInputs.current.set(id, node);
    else rowInputs.current.delete(id);
  };

  return (
    <fieldset aria-describedby={countId} className="min-w-0">
      <legend className="mb-q8 text-body-compact font-semibold text-ink">{legend}</legend>

      <div className="mb-q8 flex flex-wrap items-center justify-between gap-x-q16 gap-y-q4">
        <p id={countId} className="text-small text-ink-secondary">
          {countText}
        </p>
        <div className="flex flex-wrap gap-q8">
          {selectAll.hidden ? null : (
            <TextButton aria-disabled={selectAll.inert} onClick={onSelectAll}>
              {selectAll.label}
            </TextButton>
          )}
          <TextButton aria-disabled={clear.inert} onClick={onClear}>
            {clear.label}
          </TextButton>
        </div>
      </div>

      {showChips ? (
        <div role="group" aria-label={chipsLabel} className="mb-q8 flex flex-wrap gap-q8">
          {chips.map((chip) => (
            <span
              key={chip.id}
              className="inline-flex min-h-target items-center rounded-sm border border-edge-selected bg-selection ps-q12 text-body-compact font-semibold text-ink-accent"
            >
              <bdi lang={chip.lang}>{chip.title}</bdi>
              <button
                type="button"
                aria-label={removeLabel(chip.title)}
                ref={(node) => {
                  if (node) chipButtons.current.set(chip.id, node);
                  else chipButtons.current.delete(chip.id);
                }}
                onClick={() => removeChip(chip.id)}
                className="inline-flex size-target shrink-0 items-center justify-center rounded-sm text-ink-accent hover:bg-selection"
              >
                <Icon name="close" size="md" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <ul className="tablet:columns-2 tablet:gap-x-q16">
        {rows.map((row) => {
          const disclosure = row.disclosure;
          if (!disclosure) {
            return (
              <li key={row.id} className="break-inside-avoid border-b border-divider">
                <RowControl row={row} onToggle={() => onToggleRow(row.id)} register={registerRow(row.id)} />
              </li>
            );
          }
          const expanded = open.has(row.id);
          const childListId = `${listId}-${row.id}`;
          return (
            <li key={row.id} className="break-inside-avoid border-b border-divider bg-surface">
              {/* The checkbox target is the whole row; the button sits beside it, 8 px away, so the two targets never touch. */}
              <div className="flex items-center gap-q8">
                <div className="min-w-0 flex-1">
                  <RowControl row={row} onToggle={() => onToggleRow(row.id)} register={registerRow(row.id)} />
                </div>
                <TextButton aria-label={disclosure.name} aria-expanded={expanded} aria-controls={childListId} onClick={() => toggleOpen(row.id)}>
                  {disclosure.label}
                </TextButton>
              </div>
              <ul id={childListId} hidden={!expanded} className="ps-q24">
                {disclosure.childRows.map((child) => (
                  <li key={child.id} className="border-t border-divider">
                    <RowControl row={child} onToggle={() => onToggleRow(child.id)} register={registerRow(child.id)} />
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>

      <div role="status" aria-live="polite" className={cx(limitHelper ? "mt-q8" : "")}>
        {limitHelper ? <p className="text-small text-ink-secondary">{limitHelper}</p> : null}
      </div>
    </fieldset>
  );
}

function RowControl({ row, onToggle, register }: { row: MultiSelectRow; onToggle: () => void; register: (node: HTMLInputElement | null) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const mixed = row.state === "mixed";
  const checked = row.state === "checked";
  const locked = row.locked === true && row.state === "unchecked";

  useEffect(() => {
    // The mixed state of a group row (some of its sections are checked) has no HTML attribute; the platform reads the property.
    if (inputRef.current) inputRef.current.indeterminate = mixed;
  }, [mixed]);

  return (
    <label
      className={cx(
        "group flex min-h-button items-center gap-q12 px-q16 py-q8 transition-[color,background-color] duration-(--q-duration-fast) has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-focus",
        locked ? "cursor-not-allowed bg-disabled text-ink-secondary" : "cursor-pointer",
        !locked && (checked || mixed ? "bg-selection text-ink-accent" : "bg-surface text-ink hover:bg-selection"),
      )}
    >
      <span
        className={cx(
          "relative flex size-checkbox shrink-0 items-center justify-center rounded-xs border-2 transition-[background-color,border-color] duration-(--q-duration-fast)",
          checked || mixed ? "border-primary bg-primary" : "border-edge bg-surface",
        )}
      >
        <input
          ref={(node) => {
            inputRef.current = node;
            register(node);
          }}
          type="checkbox"
          checked={checked}
          aria-checked={mixed ? "mixed" : undefined}
          aria-disabled={locked ? true : undefined}
          onChange={() => {
            if (!locked) onToggle();
          }}
          className="absolute inset-0 m-0 size-full cursor-[inherit] opacity-0"
        />
        {checked ? <Icon name="check" size="sm" className="pointer-events-none text-on-primary" /> : null}
        {mixed ? <span aria-hidden="true" className="pointer-events-none h-0.5 w-3 rounded-xs bg-on-primary" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-body">
          <bdi lang={row.lang}>{row.title}</bdi>
        </span>
        {row.reference ? (
          <>
            {" "}
            <bdi className="text-small text-ink-secondary">{row.reference}</bdi>
          </>
        ) : null}
        {row.note ? <span className="block text-small text-ink-secondary">{row.note}</span> : null}
      </span>
    </label>
  );
}
