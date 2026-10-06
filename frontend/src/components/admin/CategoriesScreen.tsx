"use client";

import { useState } from "react";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";
import { formatInteger } from "@/i18n/format";
import { deleteCategory, getCategories } from "@/lib/api/admin-endpoints";
import type { AdminCategory, CategoriesResponse } from "@/lib/api/admin-types";
import { categoryDeletable, categoryLabel } from "./admin-model";
import { ActionFailure } from "./AdminFailureBanner";
import { AdminFrame, type FrameControls } from "./AdminFrame";
import { ConfirmDelete } from "./ConfirmDelete";
import { CategoryDialog } from "./EntityDialogs";
import { EntityActions } from "./EntityActions";
import { DetailLine, Mixed, Technical } from "./InfoList";
import { useAdminResource } from "./use-admin-resource";
import { useDeleteFlow } from "./use-delete-flow";

const NEXT = "/admin/categories";

// AD-05 Categories (docs/Content-admin.md section 6): every category with an edit dialog (labels and display order) and a delete that is offered only
// when no book is in the category. The slug is shown and never changed. The toast needs a provider that the app shell does not have, so the screen
// carries its own.
export function CategoriesScreen() {
  return (
    <ToastProvider>
      <CategoriesContent />
    </ToastProvider>
  );
}

function CategoriesContent() {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const resource = useAdminResource("categories", (client, signal) => getCategories(client, { signal }));
  return (
    <AdminFrame title={t.screens.categories} back={{ destination: t.screenName, href: "/admin" }} next={NEXT} resource={resource}>
      {(data, controls) => <CategoriesList data={data} controls={controls} />}
    </AdminFrame>
  );
}

function CategoriesList({ data, controls }: { data: CategoriesResponse; controls: FrameControls<CategoriesResponse> }) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const f = t.categories.fields;
  const toast = useToast();
  const [editing, setEditing] = useState<AdminCategory | null>(null);
  const remove = useDeleteFlow<AdminCategory>({
    next: NEXT,
    send: (client, category) => deleteCategory(client, category.id, { expectedUpdatedAt: category.updatedAt }),
    onDeleted: (category) => controls.replace((current) => ({ ...current, categories: current.categories.filter((row) => row.id !== category.id) })),
  });

  // The list is kept in display order, so a changed order moves the row.
  function saved(updated: AdminCategory) {
    controls.replace((current) => ({
      ...current,
      categories: current.categories.map((row) => (row.id === updated.id ? updated : row)).sort((a, b) => a.displayOrder - b.displayOrder),
    }));
    setEditing(null);
    toast.show(t.toasts.saved);
  }

  function reload() {
    setEditing(null);
    controls.reload();
  }

  return (
    <div className="mt-q24">
      <ActionFailure failure={remove.action.failure} onReload={reload} />
      {data.categories.length === 0 ? (
        <p className="mt-q16 text-body text-ink-secondary">{t.categories.empty}</p>
      ) : (
        <ul className="mt-q16 flex flex-col gap-q16">
          {data.categories.map((category) => {
            const label = categoryLabel(locale, category);
            const other = locale === "ar" ? category.labelEn : category.labelAr;
            return (
              <li key={category.id} className="rounded-md border border-divider bg-surface p-q16">
                <h2 className="text-body font-semibold text-ink">
                  <Mixed>{label}</Mixed>
                </h2>
                {other === null || other === "" || other === label ? null : (
                  <p className="text-small text-ink-secondary">
                    <Mixed>{other}</Mixed>
                  </p>
                )}
                <dl className="mt-q8 flex flex-col gap-q4 text-body-compact">
                  <DetailLine label={f.slug}>
                    <Technical>{category.slug}</Technical>
                  </DetailLine>
                  <DetailLine label={f.order}>{formatInteger(locale, category.displayOrder)}</DetailLine>
                  <DetailLine label={f.books}>{formatInteger(locale, category.bookCount)}</DetailLine>
                </dl>
                <EntityActions
                  name={label}
                  deletable={categoryDeletable(category)}
                  deleting={remove.action.busy === category.id}
                  onEdit={() => setEditing(category)}
                  onDelete={() => remove.ask(category)}
                />
              </li>
            );
          })}
        </ul>
      )}

      {editing === null ? null : <CategoryDialog key={editing.id} category={editing} next={NEXT} onSaved={saved} onCancel={() => setEditing(null)} onReload={reload} />}
      <ConfirmDelete
        target={remove.target === null ? null : { name: categoryLabel(locale, remove.target) }}
        copy={t.categories.deleteDialog}
        onConfirm={() => void remove.confirm()}
        onCancel={remove.cancel}
      />
    </div>
  );
}
