// Mock handlers for the content manager screens AD-01 to AD-06 (docs/Content-admin.md section 4, D91). Synthetic data only: placeholder titles, fake ids,
// no real book, no Quran or hadith text, and no account data. Registered by the coordinator in the default set of mock-fetch.ts, after
// the settings handlers; handlers.ts must not import this file.
//
// The handlers enforce the rules the server enforces, so a screen can be built and tested against the same answers: 401 without a session, 403 for a
// signed-in account that is not a manager, 404, 422 `validation_error` with `details.fields`, and 409 `version_conflict` with `details.reason` one of
// `stale`, `in_use` or `state`. `GET /access` is the one exception: it answers 200 `{ contentManager }` to every signed-in account. The data lives per
// mock instance (the scenario object), so a save in one test never reaches another.
import { DISPLAY_ORDER_MAX, DISPLAY_ORDER_MIN, licenseUrlRule, TEXT_LIMITS, textRule } from "@/lib/admin/admin-rules";
import {
  EDITION_STATUSES,
  RIGHTS_STATUSES,
  WITHDRAW_REASONS,
  type AdminBook,
  type AdminCategory,
  type AdminSource,
  type BooksResponse,
  type CategoriesResponse,
  type EditionActions,
  type EditionApproval,
  type EditionDetail,
  type EditionStatus,
  type EditionSummary,
  type EditionWithdrawal,
  type Overview,
  type RightsStatus,
  type SectionDetail,
  type SourcesResponse,
} from "../admin-types";
import { errorResponse, type MockHandler, type MockRequest, type MockResponse, type MockScenario } from "./handlers";

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Fixed ids, so a test can name the row it works on. They look like the ids of the server and mean nothing.

const uuid = (prefix: string, n: number): string => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const MOCK_ADMIN = {
  categories: { first: uuid("ca7e0000", 1), second: uuid("ca7e0000", 2), empty: uuid("ca7e0000", 3) },
  books: { first: uuid("b00c0000", 1), second: uuid("b00c0000", 2), unused: uuid("b00c0000", 3) },
  sources: { first: uuid("50c00000", 1), second: uuid("50c00000", 2), unused: uuid("50c00000", 3) },
  editions: {
    published: uuid("ed170000", 1), // book one, version 3, shown in the catalog
    revoked: uuid("ed170000", 2),
    superseded: uuid("ed170000", 3),
    validated: uuid("ed170000", 4),
    draft: uuid("ed170000", 5), // may be deleted
    draftInUse: uuid("ed170000", 6), // a learner row refers to it: the delete answers 409 `in_use`
    hidden: uuid("ed170000", 7), // published and hidden from the catalog
  },
  // The first section of the published edition (Quran face), of the withdrawn one (its rename is refused) and of the hidden one (hadith face).
  sections: { published: uuid("5ec70000", 1), revoked: uuid("5ec70000", 3), hidden: uuid("5ec70000", 20) },
} as const;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The in-memory data.

interface CategoryRow {
  id: string;
  slug: string;
  labelAr: string;
  labelEn: string | null;
  displayOrder: number;
  updatedAt: string;
}

interface BookRow {
  id: string;
  titleAr: string;
  titleEn: string | null;
  author: string;
  contentFormat: "quran" | "hadith_collection";
  categoryId: string;
  updatedAt: string;
}

interface SourceRow {
  id: string;
  title: string;
  provider: string;
  sourceUrl: string;
  licenseUrl: string | null;
  rightsStatus: RightsStatus;
  checkedAt: string | null;
  updatedAt: string;
}

interface JobRow {
  step: string;
  status: string;
  updatedAt: string;
  publishedAt: string | null;
}

interface UnitRow {
  id: string;
  ordinal: number;
  kind: string;
  reference: string;
  text: string;
}

interface SectionRow {
  id: string;
  editionId: string;
  ordinal: number;
  kind: string;
  reference: string;
  titleAr: string;
  titleEn: string; // NOT NULL in the database
  units: UnitRow[];
  questionCounts: SectionDetail["questionCounts"];
}

interface EditionRow {
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
  bookId: string;
  sourceId: string;
  contentHash: string | null;
  approval: EditionApproval | null;
  withdrawal: EditionWithdrawal | null;
  jobs: JobRow[];
  learnerReferenced: boolean;
}

interface Store {
  clock: number;
  categories: CategoryRow[];
  books: BookRow[];
  sources: SourceRow[];
  editions: EditionRow[];
  sections: SectionRow[];
}

const SEED_STAMP = "2026-10-05T08:00:00.000Z";
const CLOCK_START = Date.parse("2026-10-05T10:00:00.000Z");
const ORDINAL_WORDS_AR = ["الأولى", "الثانية", "الثالثة"] as const;
const SECTION_WORDS_AR = ["الأول", "الثاني"] as const;
const SECTION_WORDS_EN = ["one", "two"] as const;

function sectionsFor(editionId: string, firstNumber: number, count: number, format: BookRow["contentFormat"], counted: boolean): SectionRow[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1;
    const id = uuid("5ec70000", firstNumber + index);
    return {
      id,
      editionId,
      ordinal,
      kind: format === "quran" ? "surah" : "chapter",
      reference: String(ordinal),
      titleAr: `القسم التجريبي ${SECTION_WORDS_AR[index] ?? ordinal}`,
      titleEn: `Sample section ${SECTION_WORDS_EN[index] ?? ordinal}`,
      units: ORDINAL_WORDS_AR.map((word, unitIndex) => ({
        id: uuid("0a170000", (firstNumber + index) * 10 + unitIndex),
        ordinal: unitIndex + 1,
        kind: format === "quran" ? "ayah" : "hadith_narration",
        reference: `${ordinal}:${unitIndex + 1}`,
        text: `نص تجريبي للوحدة ${word}`,
      })),
      questionCounts: counted ? { wordOrder: 4, wordChoice: 6, wordRecall: 3, similarDistinction: 2 } : { wordOrder: 0, wordChoice: 0, wordRecall: 0, similarDistinction: 0 },
    };
  });
}

// The owner's approval words are text, here a synthetic sentence; any field may be null (the superseded edition has no words and no source).
const approval = (scope: string): EditionApproval => ({ who: "owner", at: "2026-10-04T09:00:00.000Z", scope, words: "عبارة اعتماد تجريبية من المالك", source: "sample-source" });
const job = (step: string, published: boolean): JobRow => ({ step, status: "succeeded", updatedAt: "2026-10-04T09:30:00.000Z", publishedAt: published ? "2026-10-04T09:45:00.000Z" : null });

function createStore(): Store {
  const { categories, books, sources, editions } = MOCK_ADMIN;
  const edition = (row: Partial<EditionRow> & Pick<EditionRow, "id" | "editionKey" | "editionLabel" | "version" | "status" | "bookId" | "sourceId">): EditionRow => ({
    language: "ar",
    bankVersion: 1,
    catalogHidden: false,
    archivedAt: null,
    updatedAt: SEED_STAMP,
    contentHash: null,
    approval: null,
    withdrawal: null,
    jobs: [],
    learnerReferenced: false,
    ...row,
  });
  const hash = (n: number) => `sha256:${String(n).repeat(8)}0123456789abcdef`;
  return {
    clock: 0,
    categories: [
      { id: categories.first, slug: "sample-first", labelAr: "تصنيف تجريبي أول", labelEn: "Sample category one", displayOrder: 1, updatedAt: SEED_STAMP },
      { id: categories.second, slug: "sample-second", labelAr: "تصنيف تجريبي ثانٍ", labelEn: null, displayOrder: 2, updatedAt: SEED_STAMP },
      { id: categories.empty, slug: "sample-empty", labelAr: "تصنيف تجريبي فارغ", labelEn: "Sample empty category", displayOrder: 3, updatedAt: SEED_STAMP },
    ],
    books: [
      { id: books.first, titleAr: "كتاب تجريبي أول", titleEn: "Sample book one", author: "مؤلف تجريبي أول", contentFormat: "quran", categoryId: categories.first, updatedAt: SEED_STAMP },
      { id: books.second, titleAr: "كتاب تجريبي ثانٍ", titleEn: null, author: "مؤلف تجريبي ثانٍ", contentFormat: "hadith_collection", categoryId: categories.second, updatedAt: SEED_STAMP },
      { id: books.unused, titleAr: "كتاب تجريبي بلا طبعات", titleEn: "Sample book without editions", author: "مؤلف تجريبي ثالث", contentFormat: "hadith_collection", categoryId: categories.first, updatedAt: SEED_STAMP },
    ],
    sources: [
      { id: sources.first, title: "مصدر تجريبي أول", provider: "جهة تجريبية أولى", sourceUrl: "https://example.invalid/source-one", licenseUrl: "https://example.invalid/license-one", rightsStatus: "verified", checkedAt: "2026-10-03T09:00:00.000Z", updatedAt: SEED_STAMP },
      { id: sources.second, title: "مصدر تجريبي ثانٍ", provider: "جهة تجريبية ثانية", sourceUrl: "https://example.invalid/source-two", licenseUrl: null, rightsStatus: "owner_accepted_pending_verification", checkedAt: null, updatedAt: SEED_STAMP },
      { id: sources.unused, title: "مصدر تجريبي غير مستخدم", provider: "جهة تجريبية ثالثة", sourceUrl: "https://example.invalid/source-three", licenseUrl: null, rightsStatus: "rejected", checkedAt: null, updatedAt: SEED_STAMP },
    ],
    editions: [
      edition({ id: editions.published, editionKey: "sample-book-one-v3", editionLabel: "طبعة تجريبية ٣", version: 3, bankVersion: 2, status: "published", bookId: books.first, sourceId: sources.first, contentHash: hash(3), approval: approval("whole edition"), jobs: [job("validated", false), job("published", true)] }),
      edition({
        id: editions.revoked,
        editionKey: "sample-book-one-v2",
        editionLabel: "طبعة تجريبية ٢",
        version: 2,
        status: "revoked",
        bookId: books.first,
        sourceId: sources.first,
        contentHash: hash(2),
        approval: approval("whole edition"),
        withdrawal: { reason: "rights", note: "ملاحظة تجريبية عن سبب السحب", at: "2026-10-04T12:00:00.000Z" },
        jobs: [job("published", true), job("withdrawn", false)],
      }),
      edition({ id: editions.superseded, editionKey: "sample-book-one-v1", editionLabel: "طبعة تجريبية ١", version: 1, status: "superseded", bookId: books.first, sourceId: sources.first, contentHash: hash(1), approval: { ...approval("whole edition"), words: null, source: null }, jobs: [job("published", true)] }),
      edition({ id: editions.validated, editionKey: "sample-book-two-v3", editionLabel: "طبعة تجريبية ٣ للكتاب الثاني", version: 3, status: "validated", bookId: books.second, sourceId: sources.second, contentHash: hash(4), jobs: [job("validated", false)] }),
      edition({ id: editions.draft, editionKey: "sample-book-two-v2", editionLabel: "مسودة تجريبية ٢", version: 2, status: "draft", bookId: books.second, sourceId: sources.second }),
      edition({ id: editions.draftInUse, editionKey: "sample-book-two-v4", editionLabel: "مسودة تجريبية ٤", version: 4, status: "draft", bookId: books.second, sourceId: sources.second, learnerReferenced: true }),
      edition({
        id: editions.hidden,
        editionKey: "sample-book-two-v1",
        editionLabel: "طبعة تجريبية ١ للكتاب الثاني",
        version: 1,
        status: "published",
        catalogHidden: true,
        archivedAt: "2026-10-04T15:00:00.000Z",
        bookId: books.second,
        sourceId: sources.second,
        contentHash: hash(5),
        approval: approval("whole edition"),
        jobs: [job("published", true), job("archived", false)],
      }),
    ],
    sections: [
      ...sectionsFor(editions.published, 1, 2, "quran", true),
      ...sectionsFor(editions.revoked, 3, 1, "quran", true),
      ...sectionsFor(editions.superseded, 4, 1, "quran", true),
      ...sectionsFor(editions.validated, 5, 1, "hadith_collection", true),
      ...sectionsFor(editions.draft, 6, 1, "hadith_collection", false),
      ...sectionsFor(editions.draftInUse, 7, 1, "hadith_collection", false),
      ...sectionsFor(editions.hidden, 20, 1, "hadith_collection", true),
    ],
  };
}

const stores = new WeakMap<MockScenario, Store>();

function storeOf(scenario: MockScenario): Store {
  let store = stores.get(scenario);
  if (store === undefined) {
    store = createStore();
    stores.set(scenario, store);
  }
  return store;
}

// Every write gives the row a new `updatedAt`, one second after the last one, so a second manager's older copy is stale.
function stamp(store: Store): string {
  store.clock += 1;
  return new Date(CLOCK_START + store.clock * 1000).toISOString();
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Answers.

interface Violation {
  field: string;
  rule: string;
}

type Conflict = "stale" | "in_use" | "state";

const unauthenticated = (): MockResponse => errorResponse(401, "unauthenticated", "Authentication is required.");
const forbidden = (): MockResponse => errorResponse(403, "forbidden", "This account may not manage content.");
const notFound = (): MockResponse => errorResponse(404, "not_found", "The item does not exist.");
const invalid = (fields: Violation[]): MockResponse => errorResponse(422, "validation_error", "The request body is not valid.", { fields });
const conflict = (reason: Conflict): MockResponse => errorResponse(409, "version_conflict", "The item cannot be changed now.", { reason });

// The guards of the server, in its order as far as a mock can follow it: no session is 401, a signed-in account that is not a manager (and a demo
// account, which never is one) is 403.
function guard(scenario: MockScenario): MockResponse | null {
  if (!scenario.signedIn) return unauthenticated();
  if (scenario.contentManager === false || scenario.isDemo === true) return forbidden();
  return null;
}

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

// The schema of a body: nothing but the named fields, `expectedUpdatedAt` when the row has the token, and at least one of the editable fields.
function schemaViolations(body: Record<string, unknown>, options: { editable: readonly string[]; token: boolean; atLeastOne: boolean }): Violation[] {
  const allowed = [...options.editable, ...(options.token ? ["expectedUpdatedAt"] : [])];
  const found: Violation[] = Object.keys(body)
    .filter((field) => !allowed.includes(field))
    .map((field) => ({ field, rule: "forbidden_field" }));
  if (options.token && typeof body.expectedUpdatedAt !== "string") found.push({ field: "expectedUpdatedAt", rule: "required" });
  if (options.atLeastOne && !options.editable.some((field) => field in body)) found.push({ field: "body", rule: "no_fields" });
  return found;
}

function textViolations(body: Record<string, unknown>, field: string, max: number, nullable: boolean): Violation[] {
  if (!(field in body)) return [];
  const value = body[field];
  if (value === null) return nullable ? [] : [{ field, rule: "invalid_type" }];
  if (typeof value !== "string") return [{ field, rule: "invalid_type" }];
  const rule = textRule(value, max);
  return rule === null ? [] : [{ field, rule }];
}

const trimmedOrNull = (value: unknown): string | null => (typeof value === "string" ? value.trim() : null);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Views.

function bookOf(store: Store, id: string): BookRow {
  const row = store.books.find((book) => book.id === id);
  if (row === undefined) throw new Error("The mock data has an edition without its book.");
  return row;
}

function editionActions(edition: EditionRow): EditionActions {
  return {
    editLabel: edition.status !== "revoked",
    archive: edition.status === "published" && !edition.catalogHidden,
    unarchive: edition.status === "published" && edition.catalogHidden,
    withdraw: edition.status === "published",
    delete: edition.status === "draft" && !edition.jobs.some((entry) => entry.step === "published"),
  };
}

function summaryOf(store: Store, edition: EditionRow): EditionSummary {
  const book = bookOf(store, edition.bookId);
  return {
    id: edition.id,
    editionKey: edition.editionKey,
    editionLabel: edition.editionLabel,
    language: edition.language,
    version: edition.version,
    bankVersion: edition.bankVersion,
    status: edition.status,
    catalogHidden: edition.catalogHidden,
    archivedAt: edition.archivedAt,
    updatedAt: edition.updatedAt,
    book: { id: book.id, titleAr: book.titleAr, titleEn: book.titleEn },
  };
}

function detailOf(store: Store, edition: EditionRow): EditionDetail {
  const source = store.sources.find((row) => row.id === edition.sourceId);
  if (source === undefined) throw new Error("The mock data has an edition without its source.");
  const sections = store.sections.filter((row) => row.editionId === edition.id).sort((a, b) => a.ordinal - b.ordinal);
  const questions = sections.reduce((sum, row) => sum + Object.values(row.questionCounts).reduce((inner, count) => inner + count, 0), 0);
  return {
    ...summaryOf(store, edition),
    source: { id: source.id, title: source.title, provider: source.provider, rightsStatus: source.rightsStatus },
    contentHash: edition.contentHash,
    approval: edition.approval,
    withdrawal: edition.withdrawal,
    counts: { sections: sections.length, units: sections.reduce((sum, row) => sum + row.units.length, 0), passages: sections.length * 2, lessons: sections.length * 3, questions },
    sections: sections.map((row) => ({ id: row.id, ordinal: row.ordinal, kind: row.kind, reference: row.reference, titleAr: row.titleAr, titleEn: row.titleEn })),
    jobs: edition.jobs.map((entry) => ({ ...entry })),
    actions: editionActions(edition),
  };
}

function sectionDetailOf(store: Store, section: SectionRow): SectionDetail {
  const edition = store.editions.find((row) => row.id === section.editionId);
  if (edition === undefined) throw new Error("The mock data has a section without its edition.");
  return {
    id: section.id,
    edition: { id: edition.id, editionLabel: edition.editionLabel, status: edition.status },
    ordinal: section.ordinal,
    kind: section.kind,
    reference: section.reference,
    titleAr: section.titleAr,
    titleEn: section.titleEn,
    units: section.units.map((unit) => ({ ...unit })),
    questionCounts: { ...section.questionCounts },
  };
}

function bookView(store: Store, book: BookRow): AdminBook {
  const category = store.categories.find((row) => row.id === book.categoryId);
  if (category === undefined) throw new Error("The mock data has a book without its category.");
  return {
    id: book.id,
    titleAr: book.titleAr,
    titleEn: book.titleEn,
    author: book.author,
    contentFormat: book.contentFormat,
    category: { id: category.id, labelAr: category.labelAr },
    editionCount: store.editions.filter((row) => row.bookId === book.id).length,
    updatedAt: book.updatedAt,
  };
}

function categoryView(store: Store, category: CategoryRow): AdminCategory {
  return {
    id: category.id,
    slug: category.slug,
    labelAr: category.labelAr,
    labelEn: category.labelEn,
    displayOrder: category.displayOrder,
    bookCount: store.books.filter((row) => row.categoryId === category.id).length,
    updatedAt: category.updatedAt,
  };
}

function sourceView(store: Store, source: SourceRow): AdminSource {
  return {
    id: source.id,
    title: source.title,
    provider: source.provider,
    sourceUrl: source.sourceUrl,
    licenseUrl: source.licenseUrl,
    rightsStatus: source.rightsStatus,
    checkedAt: source.checkedAt,
    editionCount: store.editions.filter((row) => row.sourceId === source.id).length,
    updatedAt: source.updatedAt,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Handlers.

const idOf = (request: MockRequest): string => request.params?.id ?? "";

// `GET /access` answers 200 `{ contentManager }` to every signed-in account: true for a manager, false for anyone else and for a demo account. Only a
// request with no session is refused (401).
const access: MockHandler = (_request, scenario) => {
  if (!scenario.signedIn) return unauthenticated();
  return { status: 200, body: { contentManager: scenario.contentManager !== false && scenario.isDemo !== true } };
};

const overview: MockHandler = (_request, scenario) => {
  const denied = guard(scenario);
  if (denied !== null) return denied;
  const store = storeOf(scenario);
  const byStatus = Object.fromEntries(EDITION_STATUSES.map((status) => [status, store.editions.filter((row) => row.status === status).length])) as Record<EditionStatus, number>;
  const editions = store.editions
    .map((row) => summaryOf(store, row))
    .sort((a, b) => a.book.titleAr.localeCompare(b.book.titleAr, "ar") || b.version - a.version);
  const body: Overview = {
    counts: { categories: store.categories.length, books: store.books.length, sources: store.sources.length, editions: byStatus },
    editions,
    ai: { chatModelForLearners: true, providerConfigured: true, models: ["sample-free-model-a:free", "sample-free-model-b:free"], dailyCap: 200, usedToday: 12, usedLastMinute: 1 },
  };
  return { status: 200, body };
};

// Looks the edition up and checks the session, so every edition handler starts from the same place.
function withEdition(request: MockRequest, scenario: MockScenario, run: (store: Store, edition: EditionRow) => MockResponse): MockResponse {
  const denied = guard(scenario);
  if (denied !== null) return denied;
  const store = storeOf(scenario);
  const edition = store.editions.find((row) => row.id === idOf(request));
  return edition === undefined ? notFound() : run(store, edition);
}

const getEdition: MockHandler = (request, scenario) => withEdition(request, scenario, (store, edition) => ({ status: 200, body: detailOf(store, edition) }));

const patchEdition: MockHandler = (request, scenario) =>
  withEdition(request, scenario, (store, edition) => {
    const body = asRecord(request.body);
    const broken = [...schemaViolations(body, { editable: ["editionLabel"], token: true, atLeastOne: true }), ...textViolations(body, "editionLabel", TEXT_LIMITS.name, false)];
    if (broken.length > 0) return invalid(broken);
    if (!editionActions(edition).editLabel) return conflict("state");
    if (body.expectedUpdatedAt !== edition.updatedAt) return conflict("stale");
    edition.editionLabel = trimmedOrNull(body.editionLabel) ?? edition.editionLabel;
    edition.updatedAt = stamp(store);
    return { status: 200, body: detailOf(store, edition) };
  });

const withdraw: MockHandler = (request, scenario) =>
  withEdition(request, scenario, (store, edition) => {
    const body = asRecord(request.body);
    const broken: Violation[] = [...schemaViolations(body, { editable: ["reason", "note"], token: true, atLeastOne: false })];
    if (!(WITHDRAW_REASONS as readonly unknown[]).includes(body.reason)) broken.push({ field: "reason", rule: "invalid_choice" });
    if (typeof body.note !== "string") broken.push({ field: "note", rule: "required" });
    else {
      const rule = textRule(body.note, TEXT_LIMITS.note);
      if (rule !== null) broken.push({ field: "note", rule });
    }
    if (broken.length > 0) return invalid(broken);
    if (!editionActions(edition).withdraw) return conflict("state");
    if (body.expectedUpdatedAt !== edition.updatedAt) return conflict("stale");
    const at = stamp(store);
    edition.status = "revoked";
    edition.withdrawal = { reason: body.reason as string, note: trimmedOrNull(body.note) ?? "", at };
    edition.jobs = [...edition.jobs.filter((entry) => entry.step !== "withdrawn"), { step: "withdrawn", status: "succeeded", updatedAt: at, publishedAt: null }];
    edition.updatedAt = at;
    return { status: 200, body: detailOf(store, edition) };
  });

function setVisibility(hide: boolean): MockHandler {
  return (request, scenario) =>
    withEdition(request, scenario, (store, edition) => {
      const broken = schemaViolations(asRecord(request.body), { editable: [], token: true, atLeastOne: false });
      if (broken.length > 0) return invalid(broken);
      const actions = editionActions(edition);
      if (!(hide ? actions.archive : actions.unarchive)) return conflict("state");
      if (asRecord(request.body).expectedUpdatedAt !== edition.updatedAt) return conflict("stale");
      const at = stamp(store);
      edition.catalogHidden = hide;
      edition.archivedAt = hide ? at : null;
      if (hide) edition.jobs = [...edition.jobs.filter((entry) => entry.step !== "archived"), { step: "archived", status: "succeeded", updatedAt: at, publishedAt: null }];
      edition.updatedAt = at;
      return { status: 200, body: detailOf(store, edition) };
    });
}

const deleteEdition: MockHandler = (request, scenario) =>
  withEdition(request, scenario, (store, edition) => {
    const broken = schemaViolations(asRecord(request.body), { editable: [], token: true, atLeastOne: false });
    if (broken.length > 0) return invalid(broken);
    if (asRecord(request.body).expectedUpdatedAt !== edition.updatedAt) return conflict("stale");
    if (!editionActions(edition).delete) return conflict("state");
    if (edition.learnerReferenced) return conflict("in_use");
    store.editions = store.editions.filter((row) => row.id !== edition.id);
    store.sections = store.sections.filter((row) => row.editionId !== edition.id);
    return { status: 204 };
  });

function withSection(request: MockRequest, scenario: MockScenario, run: (store: Store, section: SectionRow) => MockResponse): MockResponse {
  const denied = guard(scenario);
  if (denied !== null) return denied;
  const store = storeOf(scenario);
  const section = store.sections.find((row) => row.id === idOf(request));
  return section === undefined ? notFound() : run(store, section);
}

const getSection: MockHandler = (request, scenario) => withSection(request, scenario, (store, section) => ({ status: 200, body: sectionDetailOf(store, section) }));

// Sections have no `updated_at`: the last write wins, so there is no token and no `stale`. Both titles are NOT NULL: a null or an empty one is a 422.
const patchSection: MockHandler = (request, scenario) =>
  withSection(request, scenario, (store, section) => {
    const body = asRecord(request.body);
    const broken = [...schemaViolations(body, { editable: ["titleAr", "titleEn"], token: false, atLeastOne: true }), ...textViolations(body, "titleAr", TEXT_LIMITS.name, false), ...textViolations(body, "titleEn", TEXT_LIMITS.name, false)];
    if (broken.length > 0) return invalid(broken);
    const edition = store.editions.find((row) => row.id === section.editionId);
    if (edition?.status === "revoked") return conflict("state");
    if ("titleAr" in body) section.titleAr = trimmedOrNull(body.titleAr) ?? section.titleAr;
    if ("titleEn" in body) section.titleEn = trimmedOrNull(body.titleEn) ?? section.titleEn;
    return { status: 200, body: sectionDetailOf(store, section) };
  });

const listBooks: MockHandler = (_request, scenario) => {
  const denied = guard(scenario);
  if (denied !== null) return denied;
  const store = storeOf(scenario);
  const body: BooksResponse = {
    books: store.books.map((row) => bookView(store, row)),
    categories: [...store.categories].sort((a, b) => a.displayOrder - b.displayOrder).map((row) => ({ id: row.id, labelAr: row.labelAr })),
  };
  return { status: 200, body };
};

function withRow<R extends { id: string }>(request: MockRequest, scenario: MockScenario, pick: (store: Store) => R[], run: (store: Store, row: R) => MockResponse): MockResponse {
  const denied = guard(scenario);
  if (denied !== null) return denied;
  const store = storeOf(scenario);
  const row = pick(store).find((candidate) => candidate.id === idOf(request));
  return row === undefined ? notFound() : run(store, row);
}

const patchBook: MockHandler = (request, scenario) =>
  withRow(request, scenario, (store) => store.books, (store, book) => {
    const body = asRecord(request.body);
    const broken = [
      ...schemaViolations(body, { editable: ["titleAr", "titleEn", "author", "categoryId"], token: true, atLeastOne: true }),
      ...textViolations(body, "titleAr", TEXT_LIMITS.name, false),
      ...textViolations(body, "titleEn", TEXT_LIMITS.name, true),
      ...textViolations(body, "author", TEXT_LIMITS.name, false),
    ];
    if ("categoryId" in body && !store.categories.some((row) => row.id === body.categoryId)) broken.push({ field: "categoryId", rule: "category_not_found" });
    if (broken.length > 0) return invalid(broken);
    if (body.expectedUpdatedAt !== book.updatedAt) return conflict("stale");
    if ("titleAr" in body) book.titleAr = trimmedOrNull(body.titleAr) ?? book.titleAr;
    if ("titleEn" in body) book.titleEn = trimmedOrNull(body.titleEn);
    if ("author" in body) book.author = trimmedOrNull(body.author) ?? book.author;
    if ("categoryId" in body) book.categoryId = body.categoryId as string;
    book.updatedAt = stamp(store);
    return { status: 200, body: bookView(store, book) };
  });

const deleteBook: MockHandler = (request, scenario) =>
  withRow(request, scenario, (store) => store.books, (store, book) => {
    const broken = schemaViolations(asRecord(request.body), { editable: [], token: true, atLeastOne: false });
    if (broken.length > 0) return invalid(broken);
    if (asRecord(request.body).expectedUpdatedAt !== book.updatedAt) return conflict("stale");
    if (store.editions.some((row) => row.bookId === book.id)) return conflict("in_use");
    store.books = store.books.filter((row) => row.id !== book.id);
    return { status: 204 };
  });

const listCategories: MockHandler = (_request, scenario) => {
  const denied = guard(scenario);
  if (denied !== null) return denied;
  const store = storeOf(scenario);
  const body: CategoriesResponse = { categories: [...store.categories].sort((a, b) => a.displayOrder - b.displayOrder).map((row) => categoryView(store, row)) };
  return { status: 200, body };
};

const patchCategory: MockHandler = (request, scenario) =>
  withRow(request, scenario, (store) => store.categories, (store, category) => {
    const body = asRecord(request.body);
    const broken = [
      ...schemaViolations(body, { editable: ["labelAr", "labelEn", "displayOrder"], token: true, atLeastOne: true }),
      ...textViolations(body, "labelAr", TEXT_LIMITS.name, false),
      ...textViolations(body, "labelEn", TEXT_LIMITS.name, true),
    ];
    if ("displayOrder" in body) {
      const order = body.displayOrder;
      if (typeof order !== "number" || !Number.isInteger(order)) broken.push({ field: "displayOrder", rule: "not_integer" });
      else if (order < DISPLAY_ORDER_MIN || order > DISPLAY_ORDER_MAX) broken.push({ field: "displayOrder", rule: "out_of_range" });
    }
    if (broken.length > 0) return invalid(broken);
    if (body.expectedUpdatedAt !== category.updatedAt) return conflict("stale");
    if ("labelAr" in body) category.labelAr = trimmedOrNull(body.labelAr) ?? category.labelAr;
    if ("labelEn" in body) category.labelEn = trimmedOrNull(body.labelEn);
    if ("displayOrder" in body) category.displayOrder = body.displayOrder as number;
    category.updatedAt = stamp(store);
    return { status: 200, body: categoryView(store, category) };
  });

const deleteCategory: MockHandler = (request, scenario) =>
  withRow(request, scenario, (store) => store.categories, (store, category) => {
    const broken = schemaViolations(asRecord(request.body), { editable: [], token: true, atLeastOne: false });
    if (broken.length > 0) return invalid(broken);
    if (asRecord(request.body).expectedUpdatedAt !== category.updatedAt) return conflict("stale");
    if (store.books.some((row) => row.categoryId === category.id)) return conflict("in_use");
    store.categories = store.categories.filter((row) => row.id !== category.id);
    return { status: 204 };
  });

const listSources: MockHandler = (_request, scenario) => {
  const denied = guard(scenario);
  if (denied !== null) return denied;
  const store = storeOf(scenario);
  const body: SourcesResponse = { sources: store.sources.map((row) => sourceView(store, row)) };
  return { status: 200, body };
};

const patchSource: MockHandler = (request, scenario) =>
  withRow(request, scenario, (store) => store.sources, (store, source) => {
    const body = asRecord(request.body);
    const broken = [
      ...schemaViolations(body, { editable: ["title", "provider", "licenseUrl", "rightsStatus"], token: true, atLeastOne: true }),
      ...textViolations(body, "title", TEXT_LIMITS.sourceTitle, false),
      ...textViolations(body, "provider", TEXT_LIMITS.name, false),
    ];
    if ("licenseUrl" in body && body.licenseUrl !== null) {
      if (typeof body.licenseUrl !== "string") broken.push({ field: "licenseUrl", rule: "invalid_type" });
      else {
        const rule = licenseUrlRule(body.licenseUrl);
        if (rule !== null || body.licenseUrl.trim() === "") broken.push({ field: "licenseUrl", rule: rule ?? "empty" });
      }
    }
    if ("rightsStatus" in body && !(RIGHTS_STATUSES as readonly unknown[]).includes(body.rightsStatus)) broken.push({ field: "rightsStatus", rule: "invalid_choice" });
    if (broken.length > 0) return invalid(broken);
    if (body.expectedUpdatedAt !== source.updatedAt) return conflict("stale");
    if ("title" in body) source.title = trimmedOrNull(body.title) ?? source.title;
    if ("provider" in body) source.provider = trimmedOrNull(body.provider) ?? source.provider;
    if ("licenseUrl" in body) source.licenseUrl = trimmedOrNull(body.licenseUrl);
    if ("rightsStatus" in body) source.rightsStatus = body.rightsStatus as RightsStatus;
    source.updatedAt = stamp(store);
    return { status: 200, body: sourceView(store, source) };
  });

const deleteSource: MockHandler = (request, scenario) =>
  withRow(request, scenario, (store) => store.sources, (store, source) => {
    const broken = schemaViolations(asRecord(request.body), { editable: [], token: true, atLeastOne: false });
    if (broken.length > 0) return invalid(broken);
    if (asRecord(request.body).expectedUpdatedAt !== source.updatedAt) return conflict("stale");
    if (store.editions.some((row) => row.sourceId === source.id)) return conflict("in_use");
    store.sources = store.sources.filter((row) => row.id !== source.id);
    return { status: 204 };
  });

// Keys are "METHOD /path"; a ":id" segment matches any one segment. The `/admin` prefix keeps these apart from the learner routes.
export const adminMockHandlers: Readonly<Record<string, MockHandler>> = {
  "GET /admin/access": access,
  "GET /admin/overview": overview,
  "GET /admin/editions/:id": getEdition,
  "PATCH /admin/editions/:id": patchEdition,
  "POST /admin/editions/:id/withdraw": withdraw,
  "POST /admin/editions/:id/archive": setVisibility(true),
  "POST /admin/editions/:id/unarchive": setVisibility(false),
  "POST /admin/editions/:id/delete": deleteEdition,
  "GET /admin/sections/:id": getSection,
  "PATCH /admin/sections/:id": patchSection,
  "GET /admin/books": listBooks,
  "PATCH /admin/books/:id": patchBook,
  "POST /admin/books/:id/delete": deleteBook,
  "GET /admin/categories": listCategories,
  "PATCH /admin/categories/:id": patchCategory,
  "POST /admin/categories/:id/delete": deleteCategory,
  "GET /admin/sources": listSources,
  "PATCH /admin/sources/:id": patchSource,
  "POST /admin/sources/:id/delete": deleteSource,
};
