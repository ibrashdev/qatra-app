"use client";

import { useState } from "react";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { useLocale } from "@/i18n/LocaleProvider";
import { adminMessages } from "@/i18n/admin-messages";
import { formatInteger } from "@/i18n/format";
import { deleteBook, getBooks } from "@/lib/api/admin-endpoints";
import type { AdminBook, BooksResponse } from "@/lib/api/admin-types";
import { bookDeletable, bookTitle, formatLabel } from "./admin-model";
import { ActionFailure } from "./AdminFailureBanner";
import { AdminFrame, type FrameControls } from "./AdminFrame";
import { ConfirmDelete } from "./ConfirmDelete";
import { BookDialog } from "./EntityDialogs";
import { EntityActions } from "./EntityActions";
import { DetailLine, Mixed } from "./InfoList";
import { useAdminResource } from "./use-admin-resource";
import { useDeleteFlow } from "./use-delete-flow";

const NEXT = "/admin/books";

// AD-04 Books (docs/Content-admin.md section 6): every book with an edit dialog (titles, author, category) and a delete that is offered only when no
// edition uses the book. The toast needs a provider that the app shell does not have, so the screen carries its own.
export function BooksScreen() {
  return (
    <ToastProvider>
      <BooksContent />
    </ToastProvider>
  );
}

function BooksContent() {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const resource = useAdminResource("books", (client, signal) => getBooks(client, { signal }));
  return (
    <AdminFrame title={t.screens.books} back={{ destination: t.screenName, href: "/admin" }} next={NEXT} resource={resource}>
      {(data, controls) => <BooksList data={data} controls={controls} />}
    </AdminFrame>
  );
}

function BooksList({ data, controls }: { data: BooksResponse; controls: FrameControls<BooksResponse> }) {
  const { locale } = useLocale();
  const t = adminMessages(locale);
  const f = t.books.fields;
  const toast = useToast();
  const [editing, setEditing] = useState<AdminBook | null>(null);
  const remove = useDeleteFlow<AdminBook>({
    next: NEXT,
    send: (client, book) => deleteBook(client, book.id, { expectedUpdatedAt: book.updatedAt }),
    onDeleted: (book) => controls.replace((current) => ({ ...current, books: current.books.filter((row) => row.id !== book.id) })),
  });

  function saved(updated: AdminBook) {
    controls.replace((current) => ({ ...current, books: current.books.map((row) => (row.id === updated.id ? updated : row)) }));
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
      {data.books.length === 0 ? (
        <p className="mt-q16 text-body text-ink-secondary">{t.books.empty}</p>
      ) : (
        <ul className="mt-q16 flex flex-col gap-q16">
          {data.books.map((book) => {
            const title = bookTitle(locale, book);
            const other = locale === "ar" ? book.titleEn : book.titleAr;
            return (
              <li key={book.id} className="rounded-md border border-divider bg-surface p-q16">
                <h2 className="text-body font-semibold text-ink">
                  <Mixed>{title}</Mixed>
                </h2>
                {other === null || other === "" || other === title ? null : (
                  <p className="text-small text-ink-secondary">
                    <Mixed>{other}</Mixed>
                  </p>
                )}
                <dl className="mt-q8 flex flex-col gap-q4 text-body-compact">
                  <DetailLine label={f.author}>
                    <Mixed>{book.author}</Mixed>
                  </DetailLine>
                  <DetailLine label={f.category}>
                    <bdi lang="ar" dir="rtl">
                      {book.category.labelAr}
                    </bdi>
                  </DetailLine>
                  <DetailLine label={f.format}>{formatLabel(t, book.contentFormat)}</DetailLine>
                  <DetailLine label={f.editions}>{formatInteger(locale, book.editionCount)}</DetailLine>
                </dl>
                <EntityActions
                  name={title}
                  deletable={bookDeletable(book)}
                  deleting={remove.action.busy === book.id}
                  onEdit={() => setEditing(book)}
                  onDelete={() => remove.ask(book)}
                />
              </li>
            );
          })}
        </ul>
      )}

      {editing === null ? null : <BookDialog key={editing.id} book={editing} categories={data.categories} next={NEXT} onSaved={saved} onCancel={() => setEditing(null)} onReload={reload} />}
      <ConfirmDelete
        target={remove.target === null ? null : { name: bookTitle(locale, remove.target) }}
        copy={t.books.deleteDialog}
        onConfirm={() => void remove.confirm()}
        onCancel={remove.cancel}
      />
    </div>
  );
}
