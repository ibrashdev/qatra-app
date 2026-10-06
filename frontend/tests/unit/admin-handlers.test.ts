import { describe, expect, it } from "vitest";
import { MOCK_ADMIN } from "@/lib/api/mock/admin-handlers";
import type { MockScenario } from "@/lib/api/mock/handlers";
import { createMockFetch } from "@/lib/api/mock/mock-fetch";
import type { AdminBook, AdminCategory, AdminSource, EditionDetail, Overview, SectionDetail } from "@/lib/api/admin-types";

function mockAdmin(scenario: Partial<MockScenario> = {}) {
  const fetchImpl = createMockFetch({ latencyMs: 0, scenario: { signedIn: true, hasPlan: true, ...scenario } });
  async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const response = await fetchImpl(`/api${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: (text === "" ? undefined : JSON.parse(text)) as T };
  }
  return { call };
}

const E = MOCK_ADMIN.editions;
const reasonOf = (answer: { body: unknown }) => (answer.body as { error: { code: string; details: { reason?: string } } }).error.details.reason;
const codeOf = (answer: { body: unknown }) => (answer.body as { error: { code: string } }).error.code;
const fieldsOf = (answer: { body: unknown }) => (answer.body as { error: { details: { fields: { field: string; rule: string }[] } } }).error.details.fields;

describe("the admin mock: who may ask", () => {
  it("answers 401 without a session, and 403 on every data route for a signed-in account that is not a manager or is a demo account", async () => {
    const dataRoutes = [
      ["GET", "/admin/overview"],
      ["GET", `/admin/editions/${E.published}`],
      ["GET", "/admin/books"],
      ["GET", "/admin/categories"],
      ["GET", "/admin/sources"],
      ["GET", `/admin/sections/${MOCK_ADMIN.sections.published}`],
    ] as const;
    for (const [scenario, status, code] of [
      [{ signedIn: false }, 401, "unauthenticated"],
      [{ contentManager: false }, 403, "forbidden"],
      [{ isDemo: true }, 403, "forbidden"],
    ] as const) {
      const { call } = mockAdmin(scenario);
      for (const [method, path] of dataRoutes) {
        const answer = await call(method, path);
        expect([answer.status, codeOf(answer)], `${method} ${path}`).toEqual([status, code]);
      }
    }
  });

  it("answers GET /admin/access 200 to every signed-in account, true only for a manager, and 401 when signed out", async () => {
    expect(await mockAdmin().call("GET", "/admin/access")).toEqual({ status: 200, body: { contentManager: true } });
    expect(await mockAdmin({ contentManager: true }).call("GET", "/admin/access")).toEqual({ status: 200, body: { contentManager: true } });
    expect(await mockAdmin({ contentManager: false }).call("GET", "/admin/access")).toEqual({ status: 200, body: { contentManager: false } });
    expect(await mockAdmin({ isDemo: true }).call("GET", "/admin/access")).toEqual({ status: 200, body: { contentManager: false } });
    const signedOut = await mockAdmin({ signedIn: false }).call("GET", "/admin/access");
    expect([signedOut.status, codeOf(signedOut)]).toEqual([401, "unauthenticated"]);
  });

  it("treats a signed-in account as a manager when the flag is left out, so the development mock shows the admin", async () => {
    const { call } = mockAdmin();
    expect(await call("GET", "/admin/access")).toEqual({ status: 200, body: { contentManager: true } });
    expect((await call("GET", "/admin/overview")).status).toBe(200);
  });

  it("answers 404 for a row that does not exist", async () => {
    const { call } = mockAdmin();
    expect((await call("GET", "/admin/editions/nope")).status).toBe(404);
    expect((await call("PATCH", "/admin/books/nope", { expectedUpdatedAt: "x", author: "y" })).status).toBe(404);
    expect((await call("POST", "/admin/categories/nope/delete", { expectedUpdatedAt: "x" })).status).toBe(404);
  });

  it("keeps each mock instance's data apart", async () => {
    const first = mockAdmin();
    const second = mockAdmin();
    const detail = (await first.call<EditionDetail>("GET", `/admin/editions/${E.published}`)).body;
    await first.call("PATCH", `/admin/editions/${E.published}`, { expectedUpdatedAt: detail.updatedAt, editionLabel: "طبعة معدلة" });
    expect((await second.call<EditionDetail>("GET", `/admin/editions/${E.published}`)).body.editionLabel).toBe(detail.editionLabel);
  });
});

describe("the admin mock: the overview and the editions", () => {
  it("counts every status and lists the editions by book title, then version descending", async () => {
    const { call } = mockAdmin();
    const { body } = await call<Overview>("GET", "/admin/overview");
    expect(body.counts.categories).toBe(3);
    expect(body.counts.books).toBe(3);
    expect(body.counts.sources).toBe(3);
    expect(body.counts.editions).toEqual({ draft: 2, validated: 1, published: 2, superseded: 1, revoked: 1 });
    expect(body.editions).toHaveLength(7);
    const versions = body.editions.map((edition) => [edition.book.id, edition.version]);
    for (const bookId of [MOCK_ADMIN.books.first, MOCK_ADMIN.books.second]) {
      const own = versions.filter(([id]) => id === bookId).map(([, version]) => version as number);
      expect(own, bookId).toEqual([...own].sort((a, b) => b - a));
    }
    expect(body.ai.models).toHaveLength(2);
    expect(typeof body.ai.dailyCap).toBe("number");
  });

  it("sends the approval record with text fields, any of which may be null", async () => {
    const { call } = mockAdmin();
    const published = (await call<EditionDetail>("GET", `/admin/editions/${E.published}`)).body;
    expect(published.approval).toEqual({ who: "owner", at: "2026-10-04T09:00:00.000Z", scope: "whole edition", words: "عبارة اعتماد تجريبية من المالك", source: "sample-source" });
    expect(typeof published.approval?.words).toBe("string");
    const superseded = (await call<EditionDetail>("GET", `/admin/editions/${E.superseded}`)).body;
    expect(superseded.approval).toMatchObject({ who: "owner", words: null, source: null });
    expect((await call<EditionDetail>("GET", `/admin/editions/${E.draft}`)).body.approval).toBeNull();
    const revoked = (await call<EditionDetail>("GET", `/admin/editions/${E.revoked}`)).body;
    expect(revoked.withdrawal).toEqual({ reason: "rights", note: "ملاحظة تجريبية عن سبب السحب", at: "2026-10-04T12:00:00.000Z" });
  });

  it("computes the actions with the rules the server enforces", async () => {
    const { call } = mockAdmin();
    const actionsOf = async (id: string) => (await call<EditionDetail>("GET", `/admin/editions/${id}`)).body.actions;
    expect(await actionsOf(E.published)).toEqual({ editLabel: true, archive: true, unarchive: false, withdraw: true, delete: false });
    expect(await actionsOf(E.hidden)).toEqual({ editLabel: true, archive: false, unarchive: true, withdraw: true, delete: false });
    expect(await actionsOf(E.draft)).toEqual({ editLabel: true, archive: false, unarchive: false, withdraw: false, delete: true });
    expect(await actionsOf(E.validated)).toEqual({ editLabel: true, archive: false, unarchive: false, withdraw: false, delete: false });
    expect(await actionsOf(E.superseded)).toEqual({ editLabel: true, archive: false, unarchive: false, withdraw: false, delete: false });
    expect(await actionsOf(E.revoked)).toEqual({ editLabel: false, archive: false, unarchive: false, withdraw: false, delete: false });
  });

  it("renames an edition: 422 for a bad body, 409 stale for an old token, 409 state for a withdrawn edition, then 200 with a new token", async () => {
    const { call } = mockAdmin();
    const before = (await call<EditionDetail>("GET", `/admin/editions/${E.published}`)).body;
    const path = `/admin/editions/${E.published}`;

    const empty = await call("PATCH", path, { expectedUpdatedAt: before.updatedAt });
    expect(empty.status).toBe(422);
    expect(fieldsOf(empty)).toContainEqual({ field: "body", rule: "no_fields" });
    expect(fieldsOf(await call("PATCH", path, { expectedUpdatedAt: before.updatedAt, editionLabel: "" }))).toContainEqual({ field: "editionLabel", rule: "empty" });
    expect(fieldsOf(await call("PATCH", path, { expectedUpdatedAt: before.updatedAt, editionLabel: "x".repeat(121) }))).toContainEqual({ field: "editionLabel", rule: "too_long" });
    expect(fieldsOf(await call("PATCH", path, { expectedUpdatedAt: before.updatedAt, editionLabel: "x", status: "draft" }))).toContainEqual({ field: "status", rule: "forbidden_field" });
    expect(fieldsOf(await call("PATCH", path, { editionLabel: "x" }))).toContainEqual({ field: "expectedUpdatedAt", rule: "required" });

    const stale = await call("PATCH", path, { expectedUpdatedAt: "2020-01-01T00:00:00.000Z", editionLabel: "x" });
    expect([stale.status, codeOf(stale), reasonOf(stale)]).toEqual([409, "version_conflict", "stale"]);

    const revoked = await call("PATCH", `/admin/editions/${E.revoked}`, { expectedUpdatedAt: "any", editionLabel: "x" });
    expect([revoked.status, reasonOf(revoked)]).toEqual([409, "state"]);

    const saved = await call<EditionDetail>("PATCH", path, { expectedUpdatedAt: before.updatedAt, editionLabel: "  طبعة معدلة  " });
    expect(saved.status).toBe(200);
    expect(saved.body.editionLabel).toBe("طبعة معدلة");
    expect(saved.body.updatedAt).not.toBe(before.updatedAt);
    // The token it read is now old.
    const again = await call("PATCH", path, { expectedUpdatedAt: before.updatedAt, editionLabel: "y" });
    expect(reasonOf(again)).toBe("stale");
  });

  it("hides and shows a published edition, and refuses either in the wrong state", async () => {
    const { call } = mockAdmin();
    const read = async (id: string) => (await call<EditionDetail>("GET", `/admin/editions/${id}`)).body;
    const published = await read(E.published);
    const wrongShow = await call("POST", `/admin/editions/${E.published}/unarchive`, { expectedUpdatedAt: published.updatedAt });
    expect([wrongShow.status, reasonOf(wrongShow)]).toEqual([409, "state"]);

    const hidden = await call<EditionDetail>("POST", `/admin/editions/${E.published}/archive`, { expectedUpdatedAt: published.updatedAt });
    expect(hidden.status).toBe(200);
    expect(hidden.body.catalogHidden).toBe(true);
    expect(hidden.body.archivedAt).not.toBeNull();
    expect(hidden.body.actions).toMatchObject({ archive: false, unarchive: true });
    expect(hidden.body.jobs.map((job) => job.step)).toContain("archived");

    const twice = await call("POST", `/admin/editions/${E.published}/archive`, { expectedUpdatedAt: hidden.body.updatedAt });
    expect(reasonOf(twice)).toBe("state");
    const stale = await call("POST", `/admin/editions/${E.published}/unarchive`, { expectedUpdatedAt: published.updatedAt });
    expect(reasonOf(stale)).toBe("stale");

    const shown = await call<EditionDetail>("POST", `/admin/editions/${E.published}/unarchive`, { expectedUpdatedAt: hidden.body.updatedAt });
    expect(shown.body.catalogHidden).toBe(false);
    expect(shown.body.archivedAt).toBeNull();

    const draft = await read(E.draft);
    expect(reasonOf(await call("POST", `/admin/editions/${E.draft}/archive`, { expectedUpdatedAt: draft.updatedAt }))).toBe("state");
  });

  it("withdraws a published edition for good: a reason from the list and a note of 1 to 500 characters", async () => {
    const { call } = mockAdmin();
    const path = `/admin/editions/${E.published}/withdraw`;
    const before = (await call<EditionDetail>("GET", `/admin/editions/${E.published}`)).body;

    expect(fieldsOf(await call("POST", path, { expectedUpdatedAt: before.updatedAt, reason: "other", note: "x" }))).toContainEqual({ field: "reason", rule: "invalid_choice" });
    expect(fieldsOf(await call("POST", path, { expectedUpdatedAt: before.updatedAt, reason: "rights", note: "" }))).toContainEqual({ field: "note", rule: "empty" });
    expect(fieldsOf(await call("POST", path, { expectedUpdatedAt: before.updatedAt, reason: "rights", note: "x".repeat(501) }))).toContainEqual({ field: "note", rule: "too_long" });
    expect(reasonOf(await call("POST", path, { expectedUpdatedAt: "2020-01-01T00:00:00.000Z", reason: "rights", note: "x" }))).toBe("stale");

    const done = await call<EditionDetail>("POST", path, { expectedUpdatedAt: before.updatedAt, reason: "accreditation", note: "  ملاحظة تجريبية  " });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("revoked");
    expect(done.body.withdrawal).toMatchObject({ reason: "accreditation", note: "ملاحظة تجريبية" });
    expect(done.body.jobs.map((job) => job.step)).toContain("withdrawn");
    expect(done.body.actions).toEqual({ editLabel: false, archive: false, unarchive: false, withdraw: false, delete: false });

    // Irreversible, and a second withdrawal is not allowed.
    const again = await call("POST", path, { expectedUpdatedAt: done.body.updatedAt, reason: "rights", note: "x" });
    expect([again.status, reasonOf(again)]).toEqual([409, "state"]);
    const superseded = await call("POST", `/admin/editions/${E.superseded}/withdraw`, { expectedUpdatedAt: "x", reason: "rights", note: "x" });
    expect(reasonOf(superseded)).toBe("state");
  });

  it("deletes a draft that nothing uses, and refuses a non-draft or a draft a learner refers to", async () => {
    const { call } = mockAdmin();
    const read = async (id: string) => (await call<EditionDetail>("GET", `/admin/editions/${id}`)).body;

    const published = await read(E.published);
    expect(reasonOf(await call("POST", `/admin/editions/${E.published}/delete`, { expectedUpdatedAt: published.updatedAt }))).toBe("state");

    const inUse = await read(E.draftInUse);
    expect(reasonOf(await call("POST", `/admin/editions/${E.draftInUse}/delete`, { expectedUpdatedAt: inUse.updatedAt }))).toBe("in_use");

    const draft = await read(E.draft);
    expect(reasonOf(await call("POST", `/admin/editions/${E.draft}/delete`, { expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }))).toBe("stale");
    expect(await call("POST", `/admin/editions/${E.draft}/delete`, { expectedUpdatedAt: draft.updatedAt })).toEqual({ status: 204, body: undefined });
    expect((await call("GET", `/admin/editions/${E.draft}`)).status).toBe(404);
    const overview = (await call<Overview>("GET", "/admin/overview")).body;
    expect(overview.counts.editions.draft).toBe(1);
  });
});

describe("the admin mock: sections", () => {
  it("reads a section with its units and question counts", async () => {
    const { call } = mockAdmin();
    const { body } = await call<SectionDetail>("GET", `/admin/sections/${MOCK_ADMIN.sections.published}`);
    expect(body.edition.id).toBe(E.published);
    expect(body.units).toHaveLength(3);
    expect(body.units.every((unit) => unit.kind === "ayah")).toBe(true);
    expect(body.units[0]?.text).toBe("نص تجريبي للوحدة الأولى");
    expect(body.questionCounts).toEqual({ wordOrder: 4, wordChoice: 6, wordRecall: 3, similarDistinction: 2 });
    const hadith = (await call<SectionDetail>("GET", `/admin/sections/${MOCK_ADMIN.sections.hidden}`)).body;
    expect(hadith.units[0]?.kind).toBe("hadith_narration");
  });

  it("renames the titles without a token: at least one title, nothing else, both NOT NULL, and not for a withdrawn edition", async () => {
    const { call } = mockAdmin();
    const path = `/admin/sections/${MOCK_ADMIN.sections.published}`;
    expect(fieldsOf(await call("PATCH", path, {}))).toContainEqual({ field: "body", rule: "no_fields" });
    expect(fieldsOf(await call("PATCH", path, { titleAr: "x", reference: "9" }))).toContainEqual({ field: "reference", rule: "forbidden_field" });
    expect(fieldsOf(await call("PATCH", path, { titleAr: "" }))).toContainEqual({ field: "titleAr", rule: "empty" });
    expect(fieldsOf(await call("PATCH", path, { titleEn: "" }))).toContainEqual({ field: "titleEn", rule: "empty" });
    expect(fieldsOf(await call("PATCH", path, { titleEn: "x".repeat(121) }))).toContainEqual({ field: "titleEn", rule: "too_long" });

    // The English title is NOT NULL: a null is a 422 on that field, and nothing changed.
    const refused = await call("PATCH", path, { titleEn: null });
    expect(refused.status).toBe(422);
    expect(codeOf(refused)).toBe("validation_error");
    expect(fieldsOf(refused)).toContainEqual({ field: "titleEn", rule: "invalid_type" });
    expect(fieldsOf(await call("PATCH", path, { titleAr: null }))).toContainEqual({ field: "titleAr", rule: "invalid_type" });
    expect((await call<SectionDetail>("GET", path)).body.titleEn).toBe("Sample section one");

    const saved = await call<SectionDetail>("PATCH", path, { titleAr: " عنوان جديد ", titleEn: " New title " });
    expect(saved.status).toBe(200);
    expect(saved.body.titleAr).toBe("عنوان جديد");
    expect(saved.body.titleEn).toBe("New title");
    expect(typeof saved.body.titleEn).toBe("string");

    const revokedSection = (await call<EditionDetail>("GET", `/admin/editions/${E.revoked}`)).body.sections[0];
    expect(typeof revokedSection?.titleEn).toBe("string");
    const refusedState = await call("PATCH", `/admin/sections/${revokedSection?.id}`, { titleAr: "x" });
    expect([refusedState.status, reasonOf(refusedState)]).toEqual([409, "state"]);
  });
});

describe("the admin mock: books, categories and sources", () => {
  it("lists books with their category options, and edits one with the token", async () => {
    const { call } = mockAdmin();
    const list = (await call<{ books: AdminBook[]; categories: { id: string; labelAr: string }[] }>("GET", "/admin/books")).body;
    expect(list.books).toHaveLength(3);
    expect(list.categories).toHaveLength(3);
    const book = list.books.find((row) => row.id === MOCK_ADMIN.books.first) as AdminBook;
    expect(book.editionCount).toBe(3);

    const path = `/admin/books/${book.id}`;
    expect(fieldsOf(await call("PATCH", path, { expectedUpdatedAt: book.updatedAt, categoryId: "nope" }))).toContainEqual({ field: "categoryId", rule: "category_not_found" });
    expect(fieldsOf(await call("PATCH", path, { expectedUpdatedAt: book.updatedAt, contentFormat: "quran" }))).toContainEqual({ field: "contentFormat", rule: "forbidden_field" });
    expect(reasonOf(await call("PATCH", path, { expectedUpdatedAt: "old", author: "x" }))).toBe("stale");
    const saved = await call<AdminBook>("PATCH", path, { expectedUpdatedAt: book.updatedAt, author: "مؤلف آخر", categoryId: MOCK_ADMIN.categories.second, titleEn: null });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ author: "مؤلف آخر", titleEn: null, category: { id: MOCK_ADMIN.categories.second } });
  });

  it("deletes a book only when no edition uses it", async () => {
    const { call } = mockAdmin();
    const books = (await call<{ books: AdminBook[] }>("GET", "/admin/books")).body.books;
    const used = books.find((row) => row.id === MOCK_ADMIN.books.first) as AdminBook;
    const unused = books.find((row) => row.id === MOCK_ADMIN.books.unused) as AdminBook;
    expect(reasonOf(await call("POST", `/admin/books/${used.id}/delete`, { expectedUpdatedAt: used.updatedAt }))).toBe("in_use");
    expect(reasonOf(await call("POST", `/admin/books/${unused.id}/delete`, { expectedUpdatedAt: "old" }))).toBe("stale");
    expect((await call("POST", `/admin/books/${unused.id}/delete`, { expectedUpdatedAt: unused.updatedAt })).status).toBe(204);
    expect((await call<{ books: AdminBook[] }>("GET", "/admin/books")).body.books).toHaveLength(2);
  });

  it("edits a category: a whole display order from 0 to 9999, and a label that may be cleared", async () => {
    const { call } = mockAdmin();
    const categories = (await call<{ categories: AdminCategory[] }>("GET", "/admin/categories")).body.categories;
    const category = categories.find((row) => row.id === MOCK_ADMIN.categories.first) as AdminCategory;
    expect(category.bookCount).toBe(2);
    const path = `/admin/categories/${category.id}`;
    expect(fieldsOf(await call("PATCH", path, { expectedUpdatedAt: category.updatedAt, displayOrder: 10000 }))).toContainEqual({ field: "displayOrder", rule: "out_of_range" });
    expect(fieldsOf(await call("PATCH", path, { expectedUpdatedAt: category.updatedAt, displayOrder: -1 }))).toContainEqual({ field: "displayOrder", rule: "out_of_range" });
    expect(fieldsOf(await call("PATCH", path, { expectedUpdatedAt: category.updatedAt, displayOrder: "5" }))).toContainEqual({ field: "displayOrder", rule: "not_integer" });
    expect(fieldsOf(await call("PATCH", path, { expectedUpdatedAt: category.updatedAt, slug: "new" }))).toContainEqual({ field: "slug", rule: "forbidden_field" });
    const saved = await call<AdminCategory>("PATCH", path, { expectedUpdatedAt: category.updatedAt, displayOrder: 9, labelEn: null });
    expect(saved.body).toMatchObject({ displayOrder: 9, labelEn: null, slug: "sample-first" });
    // The list is in display order, so the edited category moved to the end.
    const after = (await call<{ categories: AdminCategory[] }>("GET", "/admin/categories")).body.categories;
    expect(after.map((row) => row.id).at(-1)).toBe(category.id);
  });

  it("deletes a category only when it is empty", async () => {
    const { call } = mockAdmin();
    const categories = (await call<{ categories: AdminCategory[] }>("GET", "/admin/categories")).body.categories;
    const full = categories.find((row) => row.id === MOCK_ADMIN.categories.first) as AdminCategory;
    const empty = categories.find((row) => row.id === MOCK_ADMIN.categories.empty) as AdminCategory;
    expect(reasonOf(await call("POST", `/admin/categories/${full.id}/delete`, { expectedUpdatedAt: full.updatedAt }))).toBe("in_use");
    expect((await call("POST", `/admin/categories/${empty.id}/delete`, { expectedUpdatedAt: empty.updatedAt })).status).toBe(204);
  });

  it("edits a source: an https license link or null, a rights status from the list, and never the source link", async () => {
    const { call } = mockAdmin();
    const sources = (await call<{ sources: AdminSource[] }>("GET", "/admin/sources")).body.sources;
    const source = sources.find((row) => row.id === MOCK_ADMIN.sources.first) as AdminSource;
    const path = `/admin/sources/${source.id}`;
    expect(fieldsOf(await call("PATCH", path, { expectedUpdatedAt: source.updatedAt, licenseUrl: "http://example.invalid" }))).toContainEqual({ field: "licenseUrl", rule: "https_required" });
    expect(fieldsOf(await call("PATCH", path, { expectedUpdatedAt: source.updatedAt, rightsStatus: "maybe" }))).toContainEqual({ field: "rightsStatus", rule: "invalid_choice" });
    expect(fieldsOf(await call("PATCH", path, { expectedUpdatedAt: source.updatedAt, sourceUrl: "https://example.invalid" }))).toContainEqual({ field: "sourceUrl", rule: "forbidden_field" });
    expect(fieldsOf(await call("PATCH", path, { expectedUpdatedAt: source.updatedAt, title: "x".repeat(201) }))).toContainEqual({ field: "title", rule: "too_long" });
    const cleared = await call<AdminSource>("PATCH", path, { expectedUpdatedAt: source.updatedAt, licenseUrl: null, rightsStatus: "rejected" });
    expect(cleared.body).toMatchObject({ licenseUrl: null, rightsStatus: "rejected", sourceUrl: source.sourceUrl });
  });

  it("deletes a source only when no edition uses it", async () => {
    const { call } = mockAdmin();
    const sources = (await call<{ sources: AdminSource[] }>("GET", "/admin/sources")).body.sources;
    const used = sources.find((row) => row.id === MOCK_ADMIN.sources.first) as AdminSource;
    const unused = sources.find((row) => row.id === MOCK_ADMIN.sources.unused) as AdminSource;
    expect(used.editionCount).toBe(3);
    expect(reasonOf(await call("POST", `/admin/sources/${used.id}/delete`, { expectedUpdatedAt: used.updatedAt }))).toBe("in_use");
    expect((await call("POST", `/admin/sources/${unused.id}/delete`, { expectedUpdatedAt: unused.updatedAt })).status).toBe(204);
  });
});
