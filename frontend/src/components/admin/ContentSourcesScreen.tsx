"use client";

import { useState } from "react";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";
import { formatInteger } from "@/i18n/format";
import { deleteSource, getSources } from "@/lib/api/admin-endpoints";
import type { AdminSource, SourcesResponse } from "@/lib/api/admin-types";
import { formatTimestamp, rightsLabel, sourceDeletable } from "./admin-model";
import { ActionFailure } from "./AdminFailureBanner";
import { AdminFrame, type FrameControls } from "./AdminFrame";
import { ConfirmDelete } from "./ConfirmDelete";
import { SourceDialog } from "./EntityDialogs";
import { EntityActions } from "./EntityActions";
import { DetailLine, Mixed, Technical } from "./InfoList";
import { useAdminResource } from "./use-admin-resource";
import { useDeleteFlow } from "./use-delete-flow";

const NEXT = "/admin/sources";

// AD-06 Content sources (docs/Content-admin.md section 6): every source with an edit dialog (title, provider, license link, rights status) and a
// delete that is offered only when no edition uses the source. The source link and the date it was checked are shown and never changed. The toast
// needs a provider that the app shell does not have, so the screen carries its own.
export function ContentSourcesScreen() {
  return (
    <ToastProvider>
      <ContentSourcesContent />
    </ToastProvider>
  );
}

function ContentSourcesContent() {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const resource = useAdminResource("sources", (client, signal) => getSources(client, { signal }));
  return (
    <AdminFrame title={t.screens.sources} back={{ destination: t.screenName, href: "/admin" }} next={NEXT} resource={resource}>
      {(data, controls) => <SourcesList data={data} controls={controls} />}
    </AdminFrame>
  );
}

function SourcesList({ data, controls }: { data: SourcesResponse; controls: FrameControls<SourcesResponse> }) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const f = t.sources.fields;
  const toast = useToast();
  const [editing, setEditing] = useState<AdminSource | null>(null);
  const remove = useDeleteFlow<AdminSource>({
    next: NEXT,
    send: (client, source) => deleteSource(client, source.id, { expectedUpdatedAt: source.updatedAt }),
    onDeleted: (source) => controls.replace((current) => ({ ...current, sources: current.sources.filter((row) => row.id !== source.id) })),
  });

  function saved(updated: AdminSource) {
    controls.replace((current) => ({ ...current, sources: current.sources.map((row) => (row.id === updated.id ? updated : row)) }));
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
      {data.sources.length === 0 ? (
        <p className="mt-q16 text-body text-ink-secondary">{t.sources.empty}</p>
      ) : (
        <ul className="mt-q16 flex flex-col gap-q16">
          {data.sources.map((source) => (
            <li key={source.id} className="rounded-md border border-divider bg-surface p-q16">
              <h2 className="text-body font-semibold text-ink">
                <Mixed>{source.title}</Mixed>
              </h2>
              <p className="text-small text-ink-secondary">
                <Mixed>{source.provider}</Mixed>
              </p>
              <dl className="mt-q8 flex flex-col gap-q4 text-body-compact">
                <DetailLine label={f.rights}>{rightsLabel(t, source.rightsStatus)}</DetailLine>
                <DetailLine label={f.sourceUrl}>
                  <Technical>{source.sourceUrl}</Technical>
                </DetailLine>
                <DetailLine label={f.licenseUrl}>{source.licenseUrl === null ? t.none : <Technical>{source.licenseUrl}</Technical>}</DetailLine>
                <DetailLine label={f.checkedAt}>{source.checkedAt === null ? t.notAvailable : formatTimestamp(locale, source.checkedAt)}</DetailLine>
                <DetailLine label={f.editions}>{formatInteger(locale, source.editionCount)}</DetailLine>
              </dl>
              <EntityActions
                name={source.title}
                deletable={sourceDeletable(source)}
                deleting={remove.action.busy === source.id}
                onEdit={() => setEditing(source)}
                onDelete={() => remove.ask(source)}
              />
            </li>
          ))}
        </ul>
      )}

      {editing === null ? null : <SourceDialog key={editing.id} source={editing} next={NEXT} onSaved={saved} onCancel={() => setEditing(null)} onReload={reload} />}
      <ConfirmDelete
        target={remove.target === null ? null : { name: remove.target.title }}
        copy={t.sources.deleteDialog}
        onConfirm={() => void remove.confirm()}
        onCancel={remove.cancel}
      />
    </div>
  );
}
