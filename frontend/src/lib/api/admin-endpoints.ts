import type { ApiClient, RequestOptions } from "./client";
import type {
  AdminAccess,
  AdminBook,
  AdminCategory,
  AdminSource,
  BooksResponse,
  CategoriesResponse,
  EditionDetail,
  ExpectedUpdate,
  Overview,
  SectionDetail,
  SourcesResponse,
  UpdateBookBody,
  UpdateCategoryBody,
  UpdateEditionBody,
  UpdateSectionBody,
  UpdateSourceBody,
  WithdrawEditionBody,
} from "./admin-types";

// The content manager API (docs/Content-admin.md section 4, D91): one function per operation, each taking the client of the runtime, so the mock layer
// and the real server behave alike. A write is never retried automatically: the caller decides what a retry does. Deletes are POST requests that
// answer 204, following the account deletion convention.

type ReadOptions = Pick<RequestOptions, "signal">;
type PressOptions = Pick<RequestOptions, "signal">;

const idPath = (collection: string, id: string, suffix = ""): string => `/admin/${collection}/${encodeURIComponent(id)}${suffix}`;

// The probe of settings (AD-00) passes `track: false`, so it never raises the busy or wake-up line of the shell.
export function getAdminAccess(client: ApiClient, options?: Pick<RequestOptions, "signal" | "track">): Promise<AdminAccess> {
  return client.get<AdminAccess>("/admin/access", { signal: options?.signal, track: options?.track });
}

export function getOverview(client: ApiClient, options?: ReadOptions): Promise<Overview> {
  return client.get<Overview>("/admin/overview", { signal: options?.signal });
}

export function getEdition(client: ApiClient, id: string, options?: ReadOptions): Promise<EditionDetail> {
  return client.get<EditionDetail>(idPath("editions", id), { signal: options?.signal });
}

export function updateEdition(client: ApiClient, id: string, body: UpdateEditionBody, options?: PressOptions): Promise<EditionDetail> {
  return client.patch<EditionDetail>(idPath("editions", id), body, { signal: options?.signal });
}

export function withdrawEdition(client: ApiClient, id: string, body: WithdrawEditionBody, options?: PressOptions): Promise<EditionDetail> {
  return client.post<EditionDetail>(idPath("editions", id, "/withdraw"), body, { signal: options?.signal });
}

export function archiveEdition(client: ApiClient, id: string, body: ExpectedUpdate, options?: PressOptions): Promise<EditionDetail> {
  return client.post<EditionDetail>(idPath("editions", id, "/archive"), body, { signal: options?.signal });
}

export function unarchiveEdition(client: ApiClient, id: string, body: ExpectedUpdate, options?: PressOptions): Promise<EditionDetail> {
  return client.post<EditionDetail>(idPath("editions", id, "/unarchive"), body, { signal: options?.signal });
}

export function deleteEdition(client: ApiClient, id: string, body: ExpectedUpdate, options?: PressOptions): Promise<void> {
  return client.post<void>(idPath("editions", id, "/delete"), body, { signal: options?.signal });
}

export function getSection(client: ApiClient, id: string, options?: ReadOptions): Promise<SectionDetail> {
  return client.get<SectionDetail>(idPath("sections", id), { signal: options?.signal });
}

export function updateSection(client: ApiClient, id: string, body: UpdateSectionBody, options?: PressOptions): Promise<SectionDetail> {
  return client.patch<SectionDetail>(idPath("sections", id), body, { signal: options?.signal });
}

export function getBooks(client: ApiClient, options?: ReadOptions): Promise<BooksResponse> {
  return client.get<BooksResponse>("/admin/books", { signal: options?.signal });
}

export function updateBook(client: ApiClient, id: string, body: UpdateBookBody, options?: PressOptions): Promise<AdminBook> {
  return client.patch<AdminBook>(idPath("books", id), body, { signal: options?.signal });
}

export function deleteBook(client: ApiClient, id: string, body: ExpectedUpdate, options?: PressOptions): Promise<void> {
  return client.post<void>(idPath("books", id, "/delete"), body, { signal: options?.signal });
}

export function getCategories(client: ApiClient, options?: ReadOptions): Promise<CategoriesResponse> {
  return client.get<CategoriesResponse>("/admin/categories", { signal: options?.signal });
}

export function updateCategory(client: ApiClient, id: string, body: UpdateCategoryBody, options?: PressOptions): Promise<AdminCategory> {
  return client.patch<AdminCategory>(idPath("categories", id), body, { signal: options?.signal });
}

export function deleteCategory(client: ApiClient, id: string, body: ExpectedUpdate, options?: PressOptions): Promise<void> {
  return client.post<void>(idPath("categories", id, "/delete"), body, { signal: options?.signal });
}

export function getSources(client: ApiClient, options?: ReadOptions): Promise<SourcesResponse> {
  return client.get<SourcesResponse>("/admin/sources", { signal: options?.signal });
}

export function updateSource(client: ApiClient, id: string, body: UpdateSourceBody, options?: PressOptions): Promise<AdminSource> {
  return client.patch<AdminSource>(idPath("sources", id), body, { signal: options?.signal });
}

export function deleteSource(client: ApiClient, id: string, body: ExpectedUpdate, options?: PressOptions): Promise<void> {
  return client.post<void>(idPath("sources", id, "/delete"), body, { signal: options?.signal });
}
