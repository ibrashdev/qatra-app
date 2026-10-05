"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { RecoveryCodeUnavailableBanner } from "@/components/auth/RecoveryCodeUnavailableBanner";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { ErrorSummary, type ErrorSummaryItem } from "@/components/ui/ErrorSummary";
import { FocusShell } from "@/components/ui/FocusShell";
import { LanguageSwitch } from "@/components/ui/LanguageSwitch";
import { Notice } from "@/components/ui/Notice";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { TextArea } from "@/components/ui/TextArea";
import { TEXT_BUTTON_CLASS, TextButton } from "@/components/ui/TextButton";
import { TextField } from "@/components/ui/TextField";
import { formatInteger } from "@/i18n/format";
import { useLocale } from "@/i18n/LocaleProvider";
import { getStartMessages } from "@/i18n/start-messages";
import { raiseLoginArrival } from "@/lib/auth/flash";
import { browserTimeZone } from "@/lib/browser";
import { getStartDraft, setStartDraft } from "@/lib/plan/start-selection";
import { CascadeSection } from "./CascadeSection";
import { composeGoal } from "./goal-sentence";
import {
  buildSelection,
  checkedPaths,
  chooseBook,
  chooseCategory,
  chooseView,
  clearOrdinals,
  countCodePoints,
  countState,
  DEFAULT_MINUTES,
  EMPTY_FORM,
  GOAL_MAX_CODE_POINTS,
  GOAL_WARN_CODE_POINTS,
  groupCategories,
  isDateRejected,
  JUZ_AMMA_NUMBER,
  listKind,
  MINUTE_CHOICES,
  nextStep,
  readStartForm,
  removeOrdinals,
  resolveCascade,
  selectAll,
  selectedOrdinals,
  todayIn,
  toggleJuz,
  toggleOrdinal,
  togglePath,
  type HadithPath,
  type Minutes,
  type StartForm,
} from "./start-model";
import { useAnnouncer } from "./use-announcer";
import { useCatalog, useStartContext } from "./use-start-data";

const SELECTION_DEBOUNCE_MS = 500;

type GoalBand = "ok" | "near" | "over";
const goalBand = (count: number): GoalBand => (count > GOAL_MAX_CODE_POINTS ? "over" : count >= GOAL_WARN_CODE_POINTS ? "near" : "ok");

// S-08 (UI-screens Batch 2): what to memorize, the daily time, an optional date and an editable goal sentence. Nothing is saved and nothing
// is sent from here (R02, D34): the choices go to S-09 in memory (guard 5) and E31 runs at the end of S-09.
export function StartScreen() {
  const router = useRouter();
  const { locale, messages } = useLocale();
  const t = getStartMessages(locale);
  const { state: catalog, retry } = useCatalog();
  const { profile, openPlanChatId, hasActivePlan } = useStartContext();
  const announcer = useAnnouncer();
  const { say, sayAfter, cancelPending } = announcer;

  // Returning from S-09 restores every level from memory (a reload loses it, UG-01).
  const [form, setForm] = useState<StartForm>(() => readStartForm(getStartDraft()?.form) ?? EMPTY_FORM);
  const [dateFlagged, setDateFlagged] = useState(false);
  const [goalEmptyFlagged, setGoalEmptyFlagged] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const dateId = useId();
  const goalId = useId();
  const helperId = useId();
  const pathsHelperId = useId();
  const pathBoxId = useId();
  const dateRef = useRef<HTMLInputElement>(null);
  const goalRef = useRef<HTMLTextAreaElement>(null);
  // Nothing is announced for what the screen restores or loads on its own: only for what the learner changed.
  const interacted = useRef(false);

  const groups = useMemo(() => (catalog.status === "ready" ? groupCategories(catalog.editions) : []), [catalog]);
  const cascade = resolveCascade(form, groups);
  const selected = selectedOrdinals(form, cascade);
  const minutes: Minutes = form.minutes ?? profile?.sessionMinutes ?? DEFAULT_MINUTES;
  const today = todayIn(profile?.timeZone ?? browserTimeZone());
  const missing = nextStep(form, cascade);
  const canStart = missing === null;

  // The goal box: the composed sentence until the learner edits it, then their text (UA-13).
  const composed = composeGoal({ locale, form, cascade, selected, minutes });
  const goalValue = form.goalEdited ? form.goalText : composed;
  const goalCount = countCodePoints(goalValue);
  const goalOver = goalCount > GOAL_MAX_CODE_POINTS;
  const goalEmptyShown = goalEmptyFlagged && goalValue.trim() === "";
  const goalError = goalOver ? t.goal.tooLong : goalEmptyShown ? t.goal.empty : undefined;
  const dateError = dateFlagged && isDateRejected(form.date, today) ? t.date.past : undefined;

  // A session that ended answers E14 with 401 (G-03): back to the login screen, which says so once.
  const sessionEnded = catalog.status === "error" && catalog.sessionEnded;
  useEffect(() => {
    if (!sessionEnded) return;
    raiseLoginArrival("session_ended");
    router.replace("/login");
  }, [sessionEnded, router]);

  // A level that appears is announced once, politely, and never takes focus (6.26).
  const levelKeys = [cascade.showBooks ? "books" : "", cascade.showView ? "view" : "", cascade.mode !== null ? "list" : ""].filter(Boolean);
  const kind = listKind(cascade);
  const deepestLegend = cascade.mode !== null && kind !== null ? t.list.legends[kind] : cascade.showView ? t.view.legend : t.books.legend;
  const levelSignature = levelKeys.join("|");
  const hasPaths = cascade.pathChoices.length > 0;
  const previous = useRef({ signature: "", hasPaths: false });
  useEffect(() => {
    const before = previous.current;
    previous.current = { signature: levelSignature, hasPaths };
    if (!interacted.current) return;
    const appeared = levelSignature !== "" && levelSignature.split("|").some((key) => !before.signature.split("|").includes(key));
    const parts: string[] = [];
    if (appeared) parts.push(t.announce.listAppeared(deepestLegend));
    if (hasPaths && !before.hasPaths) parts.push(t.paths.added);
    if (parts.length > 0) say(parts.join(" "));
  }, [levelSignature, deepestLegend, hasPaths, t, say]);

  function change(next: StartForm) {
    interacted.current = true;
    setForm(next);
  }

  // The count, then the sentence, each after the debounce, so a select-all is announced once (6.26).
  function announceSelection(next: StartForm, removedTitle?: string) {
    const nextCascade = resolveCascade(next, groups);
    const n = selectedOrdinals(next, nextCascade).length;
    const state = countState(n, nextCascade.sections.length);
    const fmt = (value: number) => formatInteger(locale, value);
    const count = state.kind === "none" ? t.count.none : state.kind === "all" ? t.count.all(fmt(state.m)) : t.count.some(fmt(state.n), fmt(state.m));
    cancelPending();
    if (removedTitle !== undefined) say(t.chips.removed(removedTitle, count));
    else sayAfter(count, SELECTION_DEBOUNCE_MS);
    if (!next.goalEdited && n > 0) sayAfter(t.goal.updated, removedTitle !== undefined ? SELECTION_DEBOUNCE_MS : 2 * SELECTION_DEBOUNCE_MS);
  }

  function applySelection(next: StartForm, removedTitle?: string) {
    change(next);
    announceSelection(next, removedTitle);
  }

  function ordinalsOfRow(id: string): number[] {
    return id === "juz" ? cascade.sections.map((section) => section.ordinal) : [Number(id)];
  }

  function toggleRow(id: string) {
    applySelection(id === "juz" ? toggleJuz(form, cascade.sections) : toggleOrdinal(form, Number(id)));
  }

  function removeChip(id: string) {
    const section = cascade.sections.find((entry) => String(entry.ordinal) === id);
    const title =
      id === "juz" ? t.list.juzTitle(formatInteger(locale, JUZ_AMMA_NUMBER)) : section ? (locale === "ar" ? section.titleAr : section.titleEn) : "";
    applySelection(removeOrdinals(form, ordinalsOfRow(id)), title);
  }

  function pickPath(path: HadithPath) {
    const result = togglePath(form, cascade, path);
    if (result.kept) {
      interacted.current = true;
      say(t.paths.helper);
      return;
    }
    change(result.form);
  }

  function handleGoalInput(text: string) {
    const before = goalBand(goalCount);
    const count = countCodePoints(text);
    const after = goalBand(count);
    change({ ...form, goalEdited: true, goalText: text });
    // Polite at 450 and at 500 only: when the text crosses into the band, not on every keystroke.
    if (after !== before) {
      if (after === "near") say(t.goal.counter(formatInteger(locale, count), formatInteger(locale, GOAL_MAX_CODE_POINTS)));
      else if (after === "over") say(t.goal.tooLong);
    }
  }

  function restoreGoal() {
    change({ ...form, goalEdited: false, goalText: "" });
    say(t.goal.restored);
    goalRef.current?.focus();
  }

  const checked = checkedPaths(form, cascade);
  const onlyOnePath = checked.length === 1;

  const errorItems: ErrorSummaryItem[] = [];
  if (dateError) errorItems.push({ fieldId: dateId, message: dateError });
  if (goalError) errorItems.push({ fieldId: goalId, message: goalError });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canStart) return;
    const dateRejected = isDateRejected(form.date, today);
    const goalTrimmed = goalValue.trim();
    const goalRejected = goalTrimmed === "" || goalOver;
    setDateFlagged(true);
    setGoalEmptyFlagged(true);
    if (dateRejected || goalRejected) {
      setAttempted(true);
      // Focus goes to the first invalid field in page order; two or more errors also raise the summary.
      (dateRejected ? dateRef : goalRef).current?.focus();
      return;
    }
    const selection = buildSelection({ form, cascade, minutes, goalText: goalTrimmed });
    if (selection === null) return;
    setStartDraft({ selection, form });
    router.push("/placement");
  }

  const helperText = missing === null ? t.action.helper : t.action.next[missing];

  return (
    <FocusShell
      title={messages.screens.start}
      back={hasActivePlan ? { destination: t.planOverview, href: "/plan" } : undefined}
      actions={<LanguageSwitch />}
    >
      <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-q24">
        {/* Slot T: the note of S-04, the open conversation, the error summary. */}
        <RecoveryCodeUnavailableBanner />
        {openPlanChatId ? (
          <Banner
            variant="info"
            action={
              <Link href={`/plan/chat/${encodeURIComponent(openPlanChatId)}`} className={TEXT_BUTTON_CLASS}>
                {t.openChat.action}
              </Link>
            }
          >
            {t.openChat.text}
          </Banner>
        ) : null}
        {attempted && errorItems.length >= 2 ? <ErrorSummary title={messages.form.errorSummary(errorItems.length, formatInteger(locale, errorItems.length))} items={errorItems} /> : null}

        <p className="text-body text-ink-secondary">{t.subtitle}</p>

        <CascadeSection
          catalog={catalog}
          groups={groups}
          form={form}
          cascade={cascade}
          handlers={{
            onCategory: (slug) => change(chooseCategory(form, slug)),
            onBook: (editionId) => change(chooseBook(form, editionId)),
            onView: (view) => change(chooseView(form, view)),
            onToggleRow: toggleRow,
            onSelectAll: () => applySelection(selectAll(form, cascade.sections)),
            onClear: () => applySelection(clearOrdinals(form)),
            onRemoveChip: removeChip,
            onRetry: retry,
          }}
        />

        <SegmentedControl
          legend={t.minutes.legend}
          value={minutes}
          onChange={(value) => change({ ...form, minutes: value })}
          options={MINUTE_CHOICES.map((value) => ({ value, label: t.minutes.label(formatInteger(locale, value), value) }))}
        />

        <div className="flex flex-col gap-q8">
          <TextField
            id={dateId}
            inputRef={dateRef}
            type="date"
            dir="auto"
            label={t.date.label}
            helper={t.date.helper}
            error={dateError}
            min={today}
            value={form.date}
            onChange={(event) => change({ ...form, date: event.target.value })}
            onBlur={() => {
              if (form.date !== "") setDateFlagged(true);
            }}
          />
          {form.date !== "" ? (
            <div>
              <TextButton
                onClick={() => {
                  change({ ...form, date: "" });
                  setDateFlagged(false);
                  dateRef.current?.focus();
                }}
              >
                {t.date.clear}
              </TextButton>
            </div>
          ) : null}
        </div>

        {hasPaths ? (
          <fieldset aria-describedby={pathsHelperId} className="min-w-0">
            <legend className="mb-q8 text-body-compact font-semibold text-ink">{t.paths.legend}</legend>
            {cascade.pathChoices.map((path) => {
              const isChecked = checked.includes(path);
              return (
                <Checkbox
                  key={path}
                  id={`${pathBoxId}-${path}`}
                  label={t.paths[path]}
                  checked={isChecked}
                  aria-disabled={isChecked && onlyOnePath ? true : undefined}
                  onChange={() => pickPath(path)}
                />
              );
            })}
            <p id={pathsHelperId} className="mt-q8 text-small text-ink-secondary">
              {t.paths.helper}
            </p>
          </fieldset>
        ) : null}

        <TextArea
          id={goalId}
          inputRef={goalRef}
          label={t.goal.label}
          helper={t.goal.helper}
          placeholder={t.goal.placeholder}
          counter={{
            text: t.goal.counter(formatInteger(locale, goalCount), formatInteger(locale, GOAL_MAX_CODE_POINTS)),
            tone: goalOver ? "error" : goalCount >= GOAL_WARN_CODE_POINTS ? "warning" : "normal",
          }}
          error={goalError}
          value={goalValue}
          onChange={(event) => handleGoalInput(event.target.value)}
          action={form.goalEdited ? <TextButton onClick={restoreGoal}>{t.goal.restore}</TextButton> : null}
        />

        <Notice>{t.notice}</Notice>

        <div>
          <Button type="submit" fullWidth aria-disabled={!canStart} aria-describedby={helperId}>
            {t.action.start}
          </Button>
          <p id={helperId} className="mt-q8 text-small text-ink-secondary">
            {helperText}
          </p>
        </div>
      </form>

      <p role="status" aria-live="polite" className="sr-only">
        {announcer.message}
      </p>
    </FocusShell>
  );
}
