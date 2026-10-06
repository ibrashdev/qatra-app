"use client";

import { useCallback, useId, useState } from "react";
import type { ApiClient } from "@/lib/api/client";
import { hasErrors, type FieldErrors } from "./admin-model";
import { useAdminAction, type AdminAction } from "./use-admin-action";

export interface EditFormConfig<V extends Record<string, string>, B, R> {
  initial: V;
  // The rule each broken field breaks.
  validate: (values: V) => FieldErrors<keyof V & string>;
  // The body of the changed fields, or null when nothing changed.
  patch: (values: V) => B | null;
  send: (client: ApiClient, body: B) => Promise<R>;
  onSaved: (result: R) => void;
  next: string; // where sign-in returns to after a 401
}

export interface EditForm<V extends Record<string, string>> {
  values: V;
  set: <K extends keyof V & string>(field: K, value: string) => void;
  // The rules the fields break, shown only once Save was pressed and kept current while the manager fixes them.
  errors: FieldErrors<keyof V & string>;
  nothingToSave: boolean;
  saving: boolean;
  action: AdminAction;
  fieldId: (field: keyof V & string) => string;
  submit: () => Promise<void>;
}

// The behaviour shared by the edit dialogs: the typed values, the rules judged before anything is sent, the changed fields only, one request per
// press, and the answer handed to the screen. A body with no changed field is not sent (the server would answer 422); the line says so instead.
export function useEditForm<V extends Record<string, string>, B, R>({ initial, validate, patch, send, onSaved, next }: EditFormConfig<V, B, R>): EditForm<V> {
  const action = useAdminAction(next);
  const [values, setValues] = useState<V>(initial);
  const [submitted, setSubmitted] = useState(false);
  const [nothingToSave, setNothingToSave] = useState(false);
  const base = useId();
  const fieldId = useCallback((field: string) => `${base}-${field}`, [base]);

  const set = useCallback(<K extends keyof V & string>(field: K, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    setNothingToSave(false);
  }, []);

  const errors: FieldErrors<keyof V & string> = submitted ? validate(values) : {};

  async function submit() {
    if (action.busy !== null) return;
    setSubmitted(true);
    const broken = validate(values);
    if (hasErrors(broken)) {
      const first = Object.keys(broken)[0];
      if (first !== undefined) document.getElementById(fieldId(first))?.focus();
      return;
    }
    const body = patch(values);
    if (body === null) {
      setNothingToSave(true);
      return;
    }
    const result = await action.run("save", (client) => send(client, body));
    if (result.ok) onSaved(result.value);
  }

  return { values, set, errors, nothingToSave, saving: action.busy !== null, action, fieldId, submit };
}
