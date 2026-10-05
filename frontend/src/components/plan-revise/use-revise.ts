"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { raisePlanConfirmed } from "@/components/plan-chat/confirmed-flash";
import { classifyPlanError, type PlanFailure } from "@/components/plan-overview/plan-failure";
import { isDateRejected, todayIn } from "@/components/start/start-model";
import { monotonicNow } from "@/components/today/today-model";
import type { Locale } from "@/i18n/messages";
import { estimatePlan, revisePlan, type EstimateReason } from "@/lib/api/plan-endpoints";
import { useApiRuntime } from "@/lib/api/react";
import type { CatalogEdition, Estimate, ISODate, Plan } from "@/lib/api/types";
import {
  estimateRequest,
  fieldErrorsOf,
  formFromPlan,
  hasChange,
  reasonFor,
  revisionBody,
  startRequest,
  type FieldErrors,
  type ReviseField,
  type ReviseForm,
} from "./revise-model";

// What closes the screen for good: the plan cannot be revised, is gone, or its edition left (G-11, G-07, G-20). The start button and the form go away.
export type Closed = "not_active" | "not_found" | "revoked";

export interface EstimateView {
  estimate: Estimate;
  reason: EstimateReason;
}

export interface Throttle {
  retryAfterSec: number;
  endsAt: number; // a performance.now() value
}

export interface ReviseInputs {
  plan: Plan | null;
  edition: CatalogEdition | null;
  locale: Locale;
  learningDate: ISODate | null;
  timeZone: string;
  revealForm: boolean; // arrival from the link under S-34's G-35 notice
  refresh: () => void;
}

export interface Revise {
  form: ReviseForm | null;
  setField: <K extends ReviseField>(field: K, value: ReviseForm[K]) => void;
  changed: boolean;
  formOpen: boolean;
  openForm: () => void;
  closed: Closed | null;
  starting: boolean;
  startFailure: PlanFailure | null;
  throttle: Throttle | null;
  throttleOver: boolean;
  endThrottle: () => void;
  start: () => Promise<void>;
  estimate: EstimateView | null;
  calculating: boolean;
  confirming: boolean;
  calculate: () => Promise<void>;
  fieldErrors: FieldErrors;
  formFailure: PlanFailure | null;
  refreshPlan: () => void;
  dialogOpen: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  confirm: () => Promise<void>;
  // The focus targets of the form: the screen moves focus to them when these change.
  formHeadingTick: number;
  previewTick: number;
  firstInvalid: ReviseField | null;
}

const FIELD_ORDER: readonly ReviseField[] = ["minutes", "date", "paths", "order"];

// The behaviour of S-13 (UI-screens S-13 section 4): E31 once per press (P-14), and the structured fallback with E15 and E17.
export function useRevise({ plan, edition, locale, learningDate, timeZone, revealForm, refresh }: ReviseInputs): Revise {
  const router = useRouter();
  const { api, client } = useApiRuntime();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [edits, setEdits] = useState<Partial<ReviseForm>>({});
  const [formOpen, setFormOpen] = useState(revealForm);
  const [closed, setClosed] = useState<Closed | null>(null);
  const [starting, setStarting] = useState(false);
  const [startFailure, setStartFailure] = useState<PlanFailure | null>(null);
  const [throttle, setThrottle] = useState<Throttle | null>(null);
  const [throttleOver, setThrottleOver] = useState(false);
  const [estimate, setEstimate] = useState<EstimateView | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formFailure, setFormFailure] = useState<PlanFailure | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formHeadingTick, setFormHeadingTick] = useState(0);
  const [previewTick, setPreviewTick] = useState(0);
  const [firstInvalid, setFirstInvalid] = useState<ReviseField | null>(null);

  const form: ReviseForm | null = plan === null ? null : { ...formFromPlan(plan), ...edits };
  const changed = plan !== null && form !== null && hasChange(plan, form);

  const setField = useCallback(<K extends ReviseField>(field: K, value: ReviseForm[K]) => {
    setEdits((current) => ({ ...current, [field]: value }));
    setEstimate(null);
    setFormFailure(null);
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  }, []);

  const openForm = useCallback(() => {
    setFormOpen(true);
    setFormHeadingTick((value) => value + 1);
  }, []);

  function closeFor(failure: PlanFailure): boolean {
    if (failure.kind === "plan_not_active") setClosed("not_active");
    else if (failure.kind === "not_found") setClosed("not_found");
    else if (failure.kind === "revoked") setClosed("revoked");
    else return false;
    return true;
  }

  async function start() {
    if (plan === null || learningDate === null || starting || throttle !== null) return;
    setStartFailure(null);
    setThrottleOver(false);
    setStarting(true);
    let leaving = false;
    try {
      const chat = await api.createPlanChat(startRequest(locale, plan, edition, learningDate));
      if (!mounted.current) return;
      if (typeof chat?.chatId !== "string" || chat.chatId === "") {
        setStartFailure({ kind: "internal" });
        return;
      }
      leaving = true;
      router.replace(`/plan/chat/${encodeURIComponent(chat.chatId)}`);
    } catch (error) {
      if (!mounted.current) return;
      const next = classifyPlanError(error);
      if (next.kind === "aborted") return;
      if (next.kind === "throttled") setThrottle({ retryAfterSec: next.retryAfterSec, endsAt: monotonicNow() + next.retryAfterSec * 1000 });
      if (!closeFor(next)) setStartFailure(next);
    } finally {
      // On success the button keeps its loading state while the conversation opens.
      if (!leaving && mounted.current) setStarting(false);
    }
  }

  // E15 and E17 failures: field messages at the fields (G-14), the fresh estimate on a changed one (G-12), «تحديث» on a moved plan (G-09),
  // and the closing banners (G-11, G-07, G-20).
  function handleFormFailure(failure: PlanFailure) {
    if (failure.kind === "aborted") return;
    if (failure.kind === "validation") {
      const errors = fieldErrorsOf(failure.rules);
      const first = FIELD_ORDER.find((field) => errors[field] !== undefined);
      if (first !== undefined) {
        setFieldErrors(errors);
        setFirstInvalid(first);
        return;
      }
    }
    if (failure.kind === "estimate_changed" && failure.estimate !== null && form !== null) {
      setEstimate({ estimate: failure.estimate, reason: reasonFor(failure.estimate, form.date) });
      setPreviewTick((value) => value + 1);
    }
    if (failure.kind === "plan_version") setEstimate(null);
    if (!closeFor(failure)) setFormFailure(failure);
  }

  async function calculate() {
    if (plan === null || form === null || calculating || confirming || !changed) return;
    setFormFailure(null);
    setFieldErrors({});
    setFirstInvalid(null);
    if (form.date !== "" && isDateRejected(form.date, todayIn(timeZone))) {
      setFieldErrors({ date: "date_invalid" });
      setFirstInvalid("date");
      return;
    }
    setCalculating(true);
    try {
      const answer = await estimatePlan(client, estimateRequest(plan, form));
      if (!mounted.current) return;
      setEstimate({ estimate: answer.estimate, reason: answer.reasonCode });
      setPreviewTick((value) => value + 1);
    } catch (error) {
      if (!mounted.current) return;
      handleFormFailure(classifyPlanError(error));
    } finally {
      if (mounted.current) setCalculating(false);
    }
  }

  async function confirm() {
    if (plan === null || form === null || confirming || estimate === null) return;
    setDialogOpen(false);
    setFormFailure(null);
    setConfirming(true);
    let leaving = false;
    try {
      await revisePlan(client, plan.planId, revisionBody(plan, form, estimate.estimate));
      if (!mounted.current) return;
      leaving = true;
      raisePlanConfirmed("revised");
      router.replace("/today");
    } catch (error) {
      if (!mounted.current) return;
      handleFormFailure(classifyPlanError(error));
    } finally {
      if (!leaving && mounted.current) setConfirming(false);
    }
  }

  const endThrottle = useCallback(() => {
    setThrottle(null);
    setStartFailure(null);
    setThrottleOver(true);
  }, []);

  // «تحديث» on a moved plan: the plan is read again (E18), the learner's inputs stay, and the estimate is asked for again.
  const refreshPlan = useCallback(() => {
    setFormFailure(null);
    setEstimate(null);
    refresh();
  }, [refresh]);

  return {
    form,
    setField,
    changed,
    formOpen: formOpen && closed === null,
    openForm,
    closed,
    starting,
    startFailure,
    throttle,
    throttleOver,
    endThrottle,
    start,
    estimate,
    calculating,
    confirming,
    calculate,
    fieldErrors,
    formFailure,
    refreshPlan,
    dialogOpen,
    openDialog: () => setDialogOpen(true),
    closeDialog: () => setDialogOpen(false),
    confirm,
    formHeadingTick,
    previewTick,
    firstInvalid,
  };
}
