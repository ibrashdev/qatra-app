"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { useLocale } from "@/i18n/LocaleProvider";
import { getMessages } from "@/i18n/messages";
import { settingsMessages } from "@/i18n/settings-messages";
import { useApiRuntime } from "@/lib/api/react";
import { updateProfile } from "@/lib/api/settings-endpoints";
import type { Profile } from "@/lib/api/types";
import { classifySaveError, type SaveFailure } from "@/lib/settings/save-failure";
import { changedValues, chosenValues, type SettingsValues } from "@/lib/settings/settings-model";

export interface Preferences {
  values: SettingsValues; // what the controls show
  set: <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => void;
  saving: boolean;
  nothingToSave: boolean;
  failure: SaveFailure | null;
  languageNote: string | null; // the polite status after a language change, in the new language
  save: () => Promise<void>;
}

// The behaviour of the preferences form of S-22 (UI-screens S-22 section 3, "Form", and section 4): one Save, E12 once per press with only the
// changed fields, the answer replacing the profile, and a changed language switching the whole interface at once.
export function usePreferences(profile: Profile, replaceProfile: (profile: Profile) => void): Preferences {
  const { client } = useApiRuntime();
  const { locale, setLocale } = useLocale();
  const toast = useToast();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const chosen = chosenValues(profile);
  const [edits, setEdits] = useState<Partial<SettingsValues>>({});
  const [saving, setSaving] = useState(false);
  const [nothingToSave, setNothingToSave] = useState(false);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [languageNote, setLanguageNote] = useState<string | null>(null);
  const values: SettingsValues = { ...chosen, ...edits };

  const set = useCallback(<K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => {
    setEdits((current) => ({ ...current, [key]: value }));
    setNothingToSave(false);
  }, []);

  async function save() {
    if (saving) return;
    setFailure(null);
    setLanguageNote(null);
    const patch = changedValues(chosen, values);
    // Nothing changed: nothing is sent, and the polite line says so.
    if (Object.keys(patch).length === 0) {
      setNothingToSave(true);
      return;
    }
    setNothingToSave(false);
    setSaving(true);
    try {
      const updated = await updateProfile(client, patch);
      if (!mounted.current) return;
      // `language` takes effect at once: `lang`, `dir` and every label follow, with no reload.
      if (updated.language !== locale) setLocale(updated.language);
      replaceProfile(updated);
      setEdits({});
      toast.show(settingsMessages(updated.language).preferences.saved);
      if (patch.language !== undefined) setLanguageNote(getMessages(updated.language).language.changed);
    } catch (error) {
      if (!mounted.current) return;
      const next = classifySaveError(error);
      if (next.kind !== "aborted") setFailure(next);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  return { values, set, saving, nothingToSave, failure, languageNote, save };
}
