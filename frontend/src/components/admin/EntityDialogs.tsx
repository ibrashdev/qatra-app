"use client";

import { SelectField } from "@/components/settings/SelectField";
import { TextField } from "@/components/ui/TextField";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";
import { TEXT_LIMITS } from "@/lib/admin/admin-rules";
import { updateBook, updateCategory, updateEdition, updateSection, updateSource } from "@/lib/api/admin-endpoints";
import { RIGHTS_STATUSES, type AdminBook, type AdminCategory, type AdminSource, type CategoryOption, type EditionDetail, type SectionDetail } from "@/lib/api/admin-types";
import {
  bookErrors,
  bookPatch,
  bookValues,
  categoryErrors,
  categoryPatch,
  categoryValues,
  editionLabelErrors,
  editionLabelPatch,
  rightsLabel,
  sectionErrors,
  sectionPatch,
  sourceErrors,
  sourcePatch,
  sourceValues,
} from "./admin-model";
import { EditDialog, fieldError } from "./EditDialog";
import { useEditForm } from "./use-edit-form";

// The edit dialogs of the content manager (docs/Content-admin.md section 3, "What may change"). Each is mounted to open and unmounted to close. Each
// sends only the fields that changed, with the `updatedAt` it read as `expectedUpdatedAt` (sections have no such token), and hands the row the server
// answered to its screen. The dialogs ask nothing about a field the manager may not change: those are not in the form at all.

interface DialogProps<R> {
  next: string;
  onSaved: (saved: R) => void;
  onCancel: () => void;
  onReload: () => void;
}

// A text field of a form: typed in either script, so its direction follows the text.
function textInput(props: { id: string; label: string; value: string; onChange: (value: string) => void; error?: string; helper?: string; inputMode?: "numeric" }) {
  const { onChange, ...rest } = props;
  return <TextField {...rest} dir="auto" autoComplete="off" onChange={(event) => onChange(event.target.value)} />;
}

export function EditionLabelDialog({ edition, next, onSaved, onCancel, onReload }: DialogProps<EditionDetail> & { edition: EditionDetail }) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const form = useEditForm({
    initial: { editionLabel: edition.editionLabel },
    validate: editionLabelErrors,
    patch: (values) => editionLabelPatch(edition, values),
    send: (client, body) => updateEdition(client, edition.id, body),
    onSaved,
    next,
  });
  return (
    <EditDialog title={t.edition.renameDialog.title} form={form} onCancel={onCancel} onReload={onReload}>
      {textInput({
        id: form.fieldId("editionLabel"),
        label: t.edition.renameDialog.label,
        value: form.values.editionLabel,
        onChange: (value) => form.set("editionLabel", value),
        error: fieldError(locale, t, form.errors, "editionLabel"),
      })}
    </EditDialog>
  );
}

export function SectionTitlesDialog({ section, next, onSaved, onCancel, onReload }: DialogProps<SectionDetail> & { section: { id: string; titleAr: string; titleEn: string } }) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const form = useEditForm({
    initial: { titleAr: section.titleAr, titleEn: section.titleEn },
    validate: sectionErrors,
    patch: (values) => sectionPatch(section, values),
    send: (client, body) => updateSection(client, section.id, body),
    onSaved,
    next,
  });
  return (
    <EditDialog title={t.section.renameDialogTitle} form={form} onCancel={onCancel} onReload={onReload}>
      {textInput({
        id: form.fieldId("titleAr"),
        label: t.section.titleAr,
        value: form.values.titleAr,
        onChange: (value) => form.set("titleAr", value),
        error: fieldError(locale, t, form.errors, "titleAr"),
      })}
      {textInput({
        id: form.fieldId("titleEn"),
        label: t.section.titleEn,
        value: form.values.titleEn,
        onChange: (value) => form.set("titleEn", value),
        error: fieldError(locale, t, form.errors, "titleEn"),
      })}
    </EditDialog>
  );
}

export function BookDialog({ book, categories, next, onSaved, onCancel, onReload }: DialogProps<AdminBook> & { book: AdminBook; categories: readonly CategoryOption[] }) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const form = useEditForm({
    initial: bookValues(book),
    validate: bookErrors,
    patch: (values) => bookPatch(book, values),
    send: (client, body) => updateBook(client, book.id, body),
    onSaved,
    next,
  });
  return (
    <EditDialog title={t.books.dialogTitle} form={form} onCancel={onCancel} onReload={onReload}>
      {textInput({
        id: form.fieldId("titleAr"),
        label: t.books.fields.titleAr,
        value: form.values.titleAr,
        onChange: (value) => form.set("titleAr", value),
        error: fieldError(locale, t, form.errors, "titleAr"),
      })}
      {textInput({
        id: form.fieldId("titleEn"),
        label: t.books.fields.titleEn,
        value: form.values.titleEn,
        onChange: (value) => form.set("titleEn", value),
        error: fieldError(locale, t, form.errors, "titleEn"),
      })}
      {textInput({
        id: form.fieldId("author"),
        label: t.books.fields.author,
        value: form.values.author,
        onChange: (value) => form.set("author", value),
        error: fieldError(locale, t, form.errors, "author"),
      })}
      <SelectField
        id={form.fieldId("categoryId")}
        label={t.books.fields.category}
        value={form.values.categoryId}
        onChange={(event) => form.set("categoryId", event.target.value)}
        options={categories.map((category) => ({ value: category.id, label: category.labelAr }))}
      />
    </EditDialog>
  );
}

export function CategoryDialog({ category, next, onSaved, onCancel, onReload }: DialogProps<AdminCategory> & { category: AdminCategory }) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const form = useEditForm({
    initial: categoryValues(category),
    validate: categoryErrors,
    patch: (values) => categoryPatch(category, values),
    send: (client, body) => updateCategory(client, category.id, body),
    onSaved,
    next,
  });
  return (
    <EditDialog title={t.categories.dialogTitle} form={form} onCancel={onCancel} onReload={onReload}>
      {textInput({
        id: form.fieldId("labelAr"),
        label: t.categories.fields.labelAr,
        value: form.values.labelAr,
        onChange: (value) => form.set("labelAr", value),
        error: fieldError(locale, t, form.errors, "labelAr"),
      })}
      {textInput({
        id: form.fieldId("labelEn"),
        label: t.categories.fields.labelEn,
        value: form.values.labelEn,
        onChange: (value) => form.set("labelEn", value),
        error: fieldError(locale, t, form.errors, "labelEn"),
      })}
      {textInput({
        id: form.fieldId("displayOrder"),
        label: t.categories.fields.order,
        value: form.values.displayOrder,
        onChange: (value) => form.set("displayOrder", value),
        error: fieldError(locale, t, form.errors, "displayOrder"),
        helper: t.categories.orderHelper,
        inputMode: "numeric",
      })}
    </EditDialog>
  );
}

export function SourceDialog({ source, next, onSaved, onCancel, onReload }: DialogProps<AdminSource> & { source: AdminSource }) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const form = useEditForm({
    initial: sourceValues(source),
    validate: sourceErrors,
    patch: (values) => sourcePatch(source, values),
    send: (client, body) => updateSource(client, source.id, body),
    onSaved,
    next,
  });
  return (
    <EditDialog title={t.sources.dialogTitle} form={form} onCancel={onCancel} onReload={onReload}>
      {textInput({
        id: form.fieldId("title"),
        label: t.sources.fields.title,
        value: form.values.title,
        onChange: (value) => form.set("title", value),
        error: fieldError(locale, t, form.errors, "title", TEXT_LIMITS.sourceTitle),
      })}
      {textInput({
        id: form.fieldId("provider"),
        label: t.sources.fields.provider,
        value: form.values.provider,
        onChange: (value) => form.set("provider", value),
        error: fieldError(locale, t, form.errors, "provider"),
      })}
      <TextField
        id={form.fieldId("licenseUrl")}
        label={t.sources.fields.licenseUrl}
        helper={t.sources.licenseHelper}
        value={form.values.licenseUrl}
        onChange={(event) => form.set("licenseUrl", event.target.value)}
        error={fieldError(locale, t, form.errors, "licenseUrl", TEXT_LIMITS.licenseUrl)}
        dir="ltr"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
      />
      <SelectField
        id={form.fieldId("rightsStatus")}
        label={t.sources.fields.rights}
        value={form.values.rightsStatus}
        onChange={(event) => form.set("rightsStatus", event.target.value)}
        options={RIGHTS_STATUSES.map((status) => ({ value: status, label: rightsLabel(t, status) }))}
      />
    </EditDialog>
  );
}
