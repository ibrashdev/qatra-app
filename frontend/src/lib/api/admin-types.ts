// The shapes of the content manager API (docs/Content-admin.md section 4, D91). JSON in camelCase, as the server sends it.
// Every row that can be edited carries `updatedAt`, which a write sends back as `expectedUpdatedAt` (section 3, "Concurrency").

export type EditionStatus = "draft" | "validated" | "published" | "superseded" | "revoked";
export const EDITION_STATUSES: readonly EditionStatus[] = ["draft", "validated", "published", "superseded", "revoked"];

// The values of the CLI's `--reason` option (section 4).
export type WithdrawReason = "transmission" | "rights" | "accreditation";
export const WITHDRAW_REASONS: readonly WithdrawReason[] = ["transmission", "rights", "accreditation"];

export type RightsStatus = "owner_accepted_pending_verification" | "verified" | "rejected";
export const RIGHTS_STATUSES: readonly RightsStatus[] = ["owner_accepted_pending_verification", "verified", "rejected"];

// GET /access answers 200 with this body to every signed-in account (`contentManager` is false for a non-manager and for a demo account), and 401 when
// signed out. The row in settings is shown only for `contentManager === true`.
export interface AdminAccess {
  contentManager: boolean;
}

export interface EditionBookRef {
  id: string;
  titleAr: string;
  titleEn: string | null;
}

export interface EditionSummary {
  id: string;
  editionKey: string;
  editionLabel: string;
  language: string;
  version: number;
  bankVersion: number;
  status: EditionStatus;
  catalogHidden: boolean;
  archivedAt: string | null;
  updatedAt: string;
  book: EditionBookRef;
}

export interface AiStatus {
  chatModelForLearners: boolean;
  providerConfigured: boolean;
  models: string[];
  dailyCap: number;
  // The counters live in the memory of the server process, so they are null when the server cannot say.
  usedToday: number | null;
  usedLastMinute: number | null;
}

export interface Overview {
  counts: {
    categories: number;
    books: number;
    sources: number;
    editions: Record<EditionStatus, number>;
  };
  editions: EditionSummary[]; // by book titleAr, then version descending
  ai: AiStatus;
}

export interface EditionSourceRef {
  id: string;
  title: string;
  provider: string;
  rightsStatus: RightsStatus;
}

// From `review_record.approval`. Every field may be null, and `words` is the owner's approval words as text (for example a quoted sentence in either
// script), not a number.
export interface EditionApproval {
  who: string | null;
  at: string | null;
  scope: string | null;
  words: string | null;
  source: string | null;
}

// From `review_record.withdrawal`. Every field may be null; `reason` is normally one of WITHDRAW_REASONS, and an unknown code is shown as it is.
export interface EditionWithdrawal {
  reason: string | null;
  note: string | null;
  at: string | null;
}

export interface EditionSectionRow {
  id: string;
  ordinal: number;
  kind: string;
  reference: string;
  titleAr: string;
  titleEn: string; // never null: the column is NOT NULL
}

export interface EditionJob {
  step: string;
  status: string;
  updatedAt: string;
  publishedAt: string | null;
}

// Computed by the server with the rules it enforces (section 5), so a button is offered only when the answer will not be 409 `state`.
export interface EditionActions {
  editLabel: boolean;
  archive: boolean;
  unarchive: boolean;
  withdraw: boolean;
  delete: boolean;
}

export interface EditionDetail extends EditionSummary {
  source: EditionSourceRef;
  contentHash: string | null;
  approval: EditionApproval | null;
  withdrawal: EditionWithdrawal | null;
  counts: { sections: number; units: number; passages: number; lessons: number; questions: number };
  sections: EditionSectionRow[]; // by ordinal
  jobs: EditionJob[]; // by created_at
  actions: EditionActions;
}

export interface SectionUnit {
  id: string;
  ordinal: number;
  kind: string;
  reference: string;
  text: string;
}

export interface SectionDetail {
  id: string;
  edition: { id: string; editionLabel: string; status: EditionStatus };
  ordinal: number;
  kind: string;
  reference: string;
  titleAr: string;
  titleEn: string; // never null: the column is NOT NULL
  units: SectionUnit[]; // by ordinal
  questionCounts: { wordOrder: number; wordChoice: number; wordRecall: number; similarDistinction: number };
}

export interface CategoryOption {
  id: string;
  labelAr: string;
}

export interface AdminBook {
  id: string;
  titleAr: string;
  titleEn: string | null;
  author: string;
  contentFormat: string;
  category: CategoryOption;
  editionCount: number;
  updatedAt: string;
}

export interface BooksResponse {
  books: AdminBook[];
  categories: CategoryOption[];
}

export interface AdminCategory {
  id: string;
  slug: string;
  labelAr: string;
  labelEn: string | null;
  displayOrder: number;
  bookCount: number;
  updatedAt: string;
}

export interface CategoriesResponse {
  categories: AdminCategory[];
}

export interface AdminSource {
  id: string;
  title: string;
  provider: string;
  sourceUrl: string;
  licenseUrl: string | null;
  rightsStatus: RightsStatus;
  checkedAt: string | null;
  editionCount: number;
  updatedAt: string;
}

export interface SourcesResponse {
  sources: AdminSource[];
}

// Request bodies. A book's `titleEn`, a category's `labelEn` and a source's `licenseUrl` accept null to clear; a section's `titleEn` does not (it is
// NOT NULL, and a null is a 422). A PATCH changes at least one field (422 otherwise).
export interface UpdateEditionBody {
  expectedUpdatedAt: string;
  editionLabel: string;
}

export interface WithdrawEditionBody {
  expectedUpdatedAt: string;
  reason: WithdrawReason;
  note: string;
}

export interface ExpectedUpdate {
  expectedUpdatedAt: string;
}

export interface UpdateSectionBody {
  titleAr?: string;
  titleEn?: string;
}

export interface UpdateBookBody {
  expectedUpdatedAt: string;
  titleAr?: string;
  titleEn?: string | null;
  author?: string;
  categoryId?: string;
}

export interface UpdateCategoryBody {
  expectedUpdatedAt: string;
  labelAr?: string;
  labelEn?: string | null;
  displayOrder?: number;
}

export interface UpdateSourceBody {
  expectedUpdatedAt: string;
  title?: string;
  provider?: string;
  licenseUrl?: string | null;
  rightsStatus?: RightsStatus;
}
