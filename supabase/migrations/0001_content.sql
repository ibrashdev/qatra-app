-- 0001_content
--
-- Content boundary of the Qatra database: 17 tables, 3 trigger helpers, the private
-- schema, the vector extension and the private storage bucket `sources`.
--
-- Source: docs/Database-schema.md v1.1 (approved by the owner, D74, 4 October 2026):
-- §4 conventions, §5.2 grant posture, §6.1 content tables, §9 storage, §10 trigger
-- helpers, §11 migration plan `0001_content`.
--
-- Scope notes
--   * Every table enables row level security and revokes the default privileges of
--     `anon` and `authenticated` here (§5.2 item 1). `service_role` keeps the
--     platform default privileges on these content tables (publishing scope, §5.3).
--   * No policy, view, grant or function for learners is created here: the policies,
--     the `authenticated` grants, the `catalog_*` views and the `srv_*` / `app_*`
--     functions arrive in `0005_rls_functions` (§11).
--   * No seed rows: categories, rules and content come from the workflow's bundles.
--   * Nothing here is applied to any Supabase project by this file's existence.

-- ---------------------------------------------------------------------------
-- 1. Extension `vector` and schema `private`
-- ---------------------------------------------------------------------------

-- Database-schema.md names no schema for the extension; `extensions` is the Supabase
-- convention, so the type is written `extensions.vector` below.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- `private` is never exposed through the Data API; no role other than the owner
-- (and superusers) may use it (§5.2 item 2). Trigger functions still fire for
-- writers because trigger execution does not check schema USAGE or EXECUTE.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Trigger helpers (§10): schema private, search_path = '', security invoker
-- ---------------------------------------------------------------------------

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

-- Before delete on book_editions: only a never-published draft edition may be
-- deleted (D44). The check runs before the cascade, so the edition's own
-- content_jobs rows are still visible here.
create function private.guard_edition_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'draft' then
    raise exception 'edition % cannot be deleted: only a draft edition may be deleted (D44)', old.id
      using errcode = 'restrict_violation',
            hint = 'Withdraw, hide or archive a published edition instead of deleting it.';
  end if;

  if exists (
    select 1
    from public.content_jobs j
    where j.edition_id = old.id
      and j.step = 'published'
  ) then
    raise exception 'edition % cannot be deleted: a published step exists for it (D44)', old.id
      using errcode = 'restrict_violation',
            hint = 'An edition that was ever published is never deleted.';
  end if;

  return old;
end;
$$;

-- Before update on units: the verbatim text, its token array and its hash are
-- immutable once the edition has left `draft`; correction means a new edition
-- (D03, D20, D44).
create function private.guard_unit_text()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  if new.canonical_text is distinct from old.canonical_text
     or new.token_spans is distinct from old.token_spans
     or new.text_hash is distinct from old.text_hash then
    select e.status
      into v_status
    from public.book_editions e
    where e.id = old.edition_id;

    if v_status is distinct from 'draft' then
      raise exception 'unit %: canonical_text, token_spans and text_hash cannot change once the edition has left draft (D03, D20, D44)', old.id
        using errcode = 'restrict_violation',
              hint = 'Correct the text by publishing a new edition.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated, service_role;
revoke all on function private.guard_edition_delete() from public, anon, authenticated, service_role;
revoke all on function private.guard_unit_text() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Tables, in dependency order (§11 item 3)
-- ---------------------------------------------------------------------------

-- 3.1 categories ------------------------------------------------------------

create table public.categories (
  id            uuid        not null default gen_random_uuid(),
  slug          text        not null,
  label_ar      text        not null,
  label_en      text,
  display_order integer     not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint categories_pkey primary key (id),
  constraint categories_slug_key unique (slug),
  constraint categories_slug_format_check check (slug ~ '^[a-z][a-z0-9_-]*$'),
  constraint categories_label_ar_check check (btrim(label_ar) <> ''),
  constraint categories_display_order_check check (display_order >= 0)
);
comment on table public.categories is 'Open list of subject areas (D01); not a closed enumeration.';

create trigger categories_set_updated_at
  before update on public.categories
  for each row execute function private.set_updated_at();

alter table public.categories enable row level security;
revoke all on table public.categories from anon, authenticated;

-- 3.2 approved_source_rules -------------------------------------------------

create table public.approved_source_rules (
  id                    uuid        not null default gen_random_uuid(),
  policy_version        text        not null,
  domain_or_book_family text        not null,
  field                 text        not null,
  eligibility_rule      text        not null,
  policy_reference      text        not null,
  created_at            timestamptz not null default now(),
  constraint approved_source_rules_pkey primary key (id),
  constraint approved_source_rules_natural_key unique (policy_version, domain_or_book_family, field),
  constraint approved_source_rules_policy_version_check check (btrim(policy_version) <> ''),
  constraint approved_source_rules_domain_or_book_family_check check (btrim(domain_or_book_family) <> ''),
  constraint approved_source_rules_field_check check (btrim(field) <> ''),
  constraint approved_source_rules_eligibility_rule_check check (btrim(eligibility_rule) <> ''),
  constraint approved_source_rules_policy_reference_check check (btrim(policy_reference) <> '')
);
comment on table public.approved_source_rules is 'Source eligibility rules from the scientific reference; a row never approves a whole site or all editions of a book family.';

alter table public.approved_source_rules enable row level security;
revoke all on table public.approved_source_rules from anon, authenticated;

-- 3.3 sources ---------------------------------------------------------------

create table public.sources (
  id                 uuid        not null,
  approved_rule_id   uuid,
  title              text        not null,
  provider           text        not null,
  source_url         text        not null,
  eligibility_record jsonb       not null default '{}',
  license_url        text,
  license_record     jsonb       not null default '{}',
  checked_at         timestamptz,
  rights_status      text        not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint sources_pkey primary key (id),
  constraint sources_approved_rule_id_fkey
    foreign key (approved_rule_id) references public.approved_source_rules (id) on delete restrict,
  constraint sources_title_check check (btrim(title) <> ''),
  constraint sources_provider_check check (btrim(provider) <> ''),
  constraint sources_source_url_check check (source_url ~ '^https://'),
  constraint sources_eligibility_record_check check (jsonb_typeof(eligibility_record) = 'object'),
  constraint sources_license_url_check check (license_url is null or license_url ~ '^https://'),
  constraint sources_license_record_check check (jsonb_typeof(license_record) = 'object'),
  constraint sources_rights_status_check
    check (rights_status in ('owner_accepted_pending_verification', 'verified', 'rejected'))
);
comment on table public.sources is 'Documented eligibility and rights of a source, independent of any edition (D19, D62, D68).';

create index sources_approved_rule_id_idx on public.sources (approved_rule_id);

create trigger sources_set_updated_at
  before update on public.sources
  for each row execute function private.set_updated_at();

alter table public.sources enable row level security;
revoke all on table public.sources from anon, authenticated;

-- 3.4 books -----------------------------------------------------------------

create table public.books (
  id             uuid        not null,
  category_id    uuid        not null,
  title_ar       text        not null,
  title_en       text,
  author         text        not null,
  content_format text        not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint books_pkey primary key (id),
  constraint books_category_id_fkey
    foreign key (category_id) references public.categories (id) on delete restrict,
  constraint books_title_ar_check check (btrim(title_ar) <> ''),
  constraint books_author_check check (btrim(author) <> ''),
  constraint books_content_format_check check (content_format in ('quran', 'hadith_collection'))
);
comment on table public.books is 'A book of a category; its editions carry the text.';

create index books_category_id_idx on public.books (category_id);

create trigger books_set_updated_at
  before update on public.books
  for each row execute function private.set_updated_at();

alter table public.books enable row level security;
revoke all on table public.books from anon, authenticated;

-- 3.5 book_editions ---------------------------------------------------------

create table public.book_editions (
  id                uuid        not null,
  book_id           uuid        not null,
  source_id         uuid        not null,
  edition_key       text        not null,
  edition_label     text        not null,
  language          text        not null,
  version           integer     not null,
  bank_version      integer     not null,
  raw_storage_path  text,
  content_hash      text,
  pagination_record jsonb       not null default '{}',
  status            text        not null default 'draft',
  review_record     jsonb       not null default '{}',
  catalog_hidden    boolean     not null default false,
  archived_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint book_editions_pkey primary key (id),
  constraint book_editions_book_id_fkey
    foreign key (book_id) references public.books (id) on delete restrict,
  constraint book_editions_source_id_fkey
    foreign key (source_id) references public.sources (id) on delete restrict,
  constraint book_editions_edition_key_key unique (edition_key),
  constraint book_editions_book_id_version_key unique (book_id, version),
  constraint book_editions_edition_key_format_check check (edition_key ~ '^[a-z0-9-]{3,64}$'),
  constraint book_editions_edition_label_check check (btrim(edition_label) <> ''),
  constraint book_editions_language_check check (language ~ '^[a-z]{2,3}$'),
  constraint book_editions_version_check check (version >= 1),
  constraint book_editions_bank_version_check check (bank_version >= 1),
  constraint book_editions_raw_storage_path_check
    check (raw_storage_path is null or raw_storage_path = edition_key || '/raw/'),
  constraint book_editions_content_hash_check
    check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  constraint book_editions_pagination_record_check check (jsonb_typeof(pagination_record) = 'object'),
  constraint book_editions_status_check
    check (status in ('draft', 'validated', 'published', 'superseded', 'revoked')),
  constraint book_editions_review_record_check check (jsonb_typeof(review_record) = 'object'),
  -- a fingerprint exists before validation
  constraint book_editions_status_content_hash_check
    check (status = 'draft' or content_hash is not null),
  -- nothing is published without the owner's recorded approval step (directive 4)
  constraint book_editions_status_approval_check
    check (status in ('draft', 'validated') or review_record ? 'approval')
);
comment on table public.book_editions is 'One immutable-text edition of a book with its fingerprint, status and reviewer evidence (D27, D44, D71).';

create index book_editions_book_id_published_idx
  on public.book_editions (book_id)
  where status in ('published', 'superseded');
create index book_editions_source_id_idx on public.book_editions (source_id);

create trigger book_editions_set_updated_at
  before update on public.book_editions
  for each row execute function private.set_updated_at();

create trigger book_editions_guard_delete
  before delete on public.book_editions
  for each row execute function private.guard_edition_delete();

alter table public.book_editions enable row level security;
revoke all on table public.book_editions from anon, authenticated;

-- 3.6 edition_pages ---------------------------------------------------------

create table public.edition_pages (
  id                 uuid    not null,
  edition_id         uuid    not null,
  printed_page_label text,
  file_page_no       integer,
  page_hash          text    not null,
  validation_record  jsonb   not null default '{}',
  constraint edition_pages_pkey primary key (id),
  constraint edition_pages_edition_id_fkey
    foreign key (edition_id) references public.book_editions (id) on delete cascade,
  constraint edition_pages_id_edition_id_key unique (id, edition_id),
  constraint edition_pages_edition_id_printed_page_label_key unique (edition_id, printed_page_label),
  constraint edition_pages_edition_id_file_page_no_key unique (edition_id, file_page_no),
  constraint edition_pages_file_page_no_check check (file_page_no >= 1),
  constraint edition_pages_page_hash_check check (page_hash ~ '^[0-9a-f]{64}$'),
  constraint edition_pages_validation_record_check check (jsonb_typeof(validation_record) = 'object'),
  constraint edition_pages_page_present_check
    check (printed_page_label is not null or file_page_no is not null)
);
comment on table public.edition_pages is 'Printed-page records of a paginated edition; stays empty for web editions (D68).';

alter table public.edition_pages enable row level security;
revoke all on table public.edition_pages from anon, authenticated;

-- 3.7 book_sections ---------------------------------------------------------

create table public.book_sections (
  id         uuid    not null,
  edition_id uuid    not null,
  parent_id  uuid,
  ordinal    integer not null,
  kind       text    not null,
  reference  text    not null,
  title_ar   text    not null,
  title_en   text    not null,
  source_url text,
  constraint book_sections_pkey primary key (id),
  constraint book_sections_edition_id_fkey
    foreign key (edition_id) references public.book_editions (id) on delete cascade,
  constraint book_sections_parent_id_edition_id_fkey
    foreign key (parent_id, edition_id) references public.book_sections (id, edition_id) on delete cascade,
  constraint book_sections_id_edition_id_key unique (id, edition_id),
  constraint book_sections_edition_id_ordinal_key unique (edition_id, ordinal),
  constraint book_sections_ordinal_check check (ordinal >= 1),
  constraint book_sections_kind_check check (kind in ('surah', 'hadith')),
  constraint book_sections_reference_check check (btrim(reference) <> ''),
  constraint book_sections_title_ar_check check (btrim(title_ar) <> ''),
  constraint book_sections_title_en_check check (btrim(title_en) <> ''),
  constraint book_sections_source_url_check check (source_url is null or source_url ~ '^https://')
);
comment on table public.book_sections is 'Surahs, hadith numbers and chapters of an edition; a hierarchy through parent_id.';

create index book_sections_parent_id_idx
  on public.book_sections (parent_id)
  where parent_id is not null;

alter table public.book_sections enable row level security;
revoke all on table public.book_sections from anon, authenticated;

-- 3.8 units -----------------------------------------------------------------

create table public.units (
  id             uuid    not null,
  edition_id     uuid    not null,
  section_id     uuid    not null,
  ordinal        integer not null,
  kind           text    not null,
  reference      text    not null,
  source_url     text,
  canonical_text text    not null,
  char_start     integer,
  char_end       integer,
  token_spans    jsonb   not null,
  text_hash      text    not null,
  hadith_meta    jsonb,
  constraint units_pkey primary key (id),
  constraint units_section_id_edition_id_fkey
    foreign key (section_id, edition_id) references public.book_sections (id, edition_id) on delete cascade,
  constraint units_id_edition_id_key unique (id, edition_id),
  constraint units_edition_id_ordinal_key unique (edition_id, ordinal),
  constraint units_ordinal_check check (ordinal >= 1),
  constraint units_kind_check
    check (kind in ('ayah', 'hadith_narration', 'hadith_takhrij', 'hadith_grade')),
  constraint units_reference_check check (btrim(reference) <> ''),
  constraint units_source_url_check check (source_url is null or source_url ~ '^https://'),
  constraint units_canonical_text_check
    check (btrim(canonical_text) <> '' and is_normalized(canonical_text, 'NFC')),
  -- both or neither of char_start, char_end
  constraint units_char_pair_check check ((char_start is null) = (char_end is null)),
  constraint units_char_range_check
    check (char_start is null or (char_start >= 0 and char_start <= char_end)),
  constraint units_token_spans_check check (jsonb_typeof(token_spans) = 'array'),
  constraint units_text_hash_check check (text_hash ~ '^[0-9a-f]{64}$'),
  -- hadith_meta: NULL for ayah; an object for every hadith unit (§6.1). The explicit
  -- "is not null" matters: jsonb_typeof(NULL) is NULL and a CHECK accepts NULL.
  constraint units_hadith_meta_check
    check (
      (kind = 'ayah' and hadith_meta is null)
      or (kind <> 'ayah' and hadith_meta is not null and jsonb_typeof(hadith_meta) = 'object')
    )
);
comment on table public.units is 'Verbatim positions of the original text (ayah; per hadith up to three units). Text immutable after draft.';

create index units_section_id_ordinal_idx on public.units (section_id, ordinal);

create trigger units_guard_text
  before update on public.units
  for each row execute function private.guard_unit_text();

alter table public.units enable row level security;
revoke all on table public.units from anon, authenticated;

-- 3.9 unit_page_spans -------------------------------------------------------

create table public.unit_page_spans (
  unit_id      uuid    not null,
  ordinal      integer not null,
  edition_id   uuid    not null,
  page_id      uuid    not null,
  start_offset integer not null,
  end_offset   integer not null,
  constraint unit_page_spans_pkey primary key (unit_id, ordinal),
  constraint unit_page_spans_unit_id_edition_id_fkey
    foreign key (unit_id, edition_id) references public.units (id, edition_id) on delete cascade,
  constraint unit_page_spans_page_id_edition_id_fkey
    foreign key (page_id, edition_id) references public.edition_pages (id, edition_id) on delete cascade,
  constraint unit_page_spans_ordinal_check check (ordinal >= 1),
  constraint unit_page_spans_start_offset_check check (start_offset >= 0),
  constraint unit_page_spans_end_offset_check check (end_offset >= start_offset)
);
comment on table public.unit_page_spans is 'Pages covered by a unit; stays empty for web editions (D68).';

create index unit_page_spans_page_id_idx on public.unit_page_spans (page_id);

alter table public.unit_page_spans enable row level security;
revoke all on table public.unit_page_spans from anon, authenticated;

-- 3.10 passages -------------------------------------------------------------

create table public.passages (
  id           uuid    not null,
  edition_id   uuid    not null,
  bank_version integer not null,
  section_id   uuid    not null,
  ordinal      integer not null,
  path         text    not null,
  start_ref    text    not null,
  end_ref      text    not null,
  word_count   integer not null,
  reference    text    not null,
  constraint passages_pkey primary key (id),
  constraint passages_section_id_edition_id_fkey
    foreign key (section_id, edition_id) references public.book_sections (id, edition_id) on delete cascade,
  constraint passages_edition_id_bank_version_path_ordinal_key unique (edition_id, bank_version, path, ordinal),
  constraint passages_id_edition_id_key unique (id, edition_id),
  constraint passages_id_edition_id_bank_version_key unique (id, edition_id, bank_version),
  constraint passages_bank_version_check check (bank_version >= 1),
  constraint passages_ordinal_check check (ordinal >= 1),
  constraint passages_path_check check (path in ('quran', 'matn', 'sanad', 'grade')),
  constraint passages_start_ref_check check (start_ref ~ '^[0-9]+:[0-9]+$'),
  constraint passages_end_ref_check check (end_ref ~ '^[0-9]+:[0-9]+$'),
  constraint passages_word_count_check check (word_count >= 1),
  constraint passages_reference_check check (btrim(reference) <> '')
);
comment on table public.passages is 'The memorization target (D66): a fixed contiguous token range inside one section, on one path.';

create index passages_section_id_idx on public.passages (section_id);

alter table public.passages enable row level security;
revoke all on table public.passages from anon, authenticated;

-- 3.11 passage_parts --------------------------------------------------------

create table public.passage_parts (
  id         uuid    not null,
  passage_id uuid    not null,
  edition_id uuid    not null,
  ordinal    integer not null,
  start_ref  text    not null,
  end_ref    text    not null,
  word_count integer not null,
  constraint passage_parts_pkey primary key (id),
  constraint passage_parts_passage_id_edition_id_fkey
    foreign key (passage_id, edition_id) references public.passages (id, edition_id) on delete cascade,
  constraint passage_parts_passage_id_ordinal_key unique (passage_id, ordinal),
  constraint passage_parts_id_passage_id_key unique (id, passage_id),
  constraint passage_parts_ordinal_check check (ordinal >= 1),
  constraint passage_parts_start_ref_check check (start_ref ~ '^[0-9]+:[0-9]+$'),
  constraint passage_parts_end_ref_check check (end_ref ~ '^[0-9]+:[0-9]+$'),
  constraint passage_parts_word_count_check check (word_count >= 1)
);
comment on table public.passage_parts is 'The coverage unit inside a passage (D66).';

alter table public.passage_parts enable row level security;
revoke all on table public.passage_parts from anon, authenticated;

-- 3.12 lessons --------------------------------------------------------------

create table public.lessons (
  id                    uuid    not null,
  edition_id            uuid    not null,
  bank_version          integer not null,
  passage_id            uuid    not null,
  ordinal               integer not null,
  duration_estimate_sec integer not null,
  status                text    not null default 'draft',
  constraint lessons_pkey primary key (id),
  constraint lessons_passage_id_edition_id_bank_version_fkey
    foreign key (passage_id, edition_id, bank_version)
    references public.passages (id, edition_id, bank_version) on delete cascade,
  constraint lessons_edition_id_bank_version_ordinal_key unique (edition_id, bank_version, ordinal),
  constraint lessons_id_edition_id_key unique (id, edition_id),
  constraint lessons_bank_version_check check (bank_version >= 1),
  constraint lessons_ordinal_check check (ordinal >= 1),
  constraint lessons_duration_estimate_sec_check check (duration_estimate_sec > 0),
  constraint lessons_status_check check (status in ('draft', 'validated', 'published', 'revoked'))
);
comment on table public.lessons is 'A fixed lesson for one passage, reusable by every learner; no user_id.';

create index lessons_passage_id_idx on public.lessons (passage_id);

alter table public.lessons enable row level security;
revoke all on table public.lessons from anon, authenticated;

-- 3.13 lesson_units ---------------------------------------------------------

create table public.lesson_units (
  lesson_id    uuid    not null,
  ordinal      integer not null,
  edition_id   uuid    not null,
  unit_id      uuid    not null,
  start_offset integer not null,
  end_offset   integer not null,
  constraint lesson_units_pkey primary key (lesson_id, ordinal),
  constraint lesson_units_lesson_id_edition_id_fkey
    foreign key (lesson_id, edition_id) references public.lessons (id, edition_id) on delete cascade,
  constraint lesson_units_unit_id_edition_id_fkey
    foreign key (unit_id, edition_id) references public.units (id, edition_id) on delete cascade,
  constraint lesson_units_ordinal_check check (ordinal >= 1),
  constraint lesson_units_start_offset_check check (start_offset >= 0),
  constraint lesson_units_end_offset_check check (end_offset > start_offset)
);
comment on table public.lesson_units is 'Ordered segments of units that make up a lesson; no generated text.';

create index lesson_units_unit_id_idx on public.lesson_units (unit_id);

alter table public.lesson_units enable row level security;
revoke all on table public.lesson_units from anon, authenticated;

-- 3.14 question_items -------------------------------------------------------

create table public.question_items (
  id                uuid    not null,
  edition_id        uuid    not null,
  bank_version      integer not null,
  passage_id        uuid    not null,
  lesson_id         uuid,
  unit_id           uuid    not null,
  type              text    not null,
  variant           text,
  covered_part_ids  uuid[]  not null,
  token_refs        jsonb   not null,
  option_refs       jsonb,
  correct_ref       jsonb   not null,
  context_refs      jsonb   not null default '[]',
  reference         text    not null,
  status            text    not null default 'draft',
  validation_record jsonb   not null default '{}',
  constraint question_items_pkey primary key (id),
  constraint question_items_passage_id_edition_id_bank_version_fkey
    foreign key (passage_id, edition_id, bank_version)
    references public.passages (id, edition_id, bank_version) on delete cascade,
  constraint question_items_lesson_id_edition_id_fkey
    foreign key (lesson_id, edition_id) references public.lessons (id, edition_id) on delete cascade,
  constraint question_items_unit_id_edition_id_fkey
    foreign key (unit_id, edition_id) references public.units (id, edition_id) on delete cascade,
  constraint question_items_id_edition_id_key unique (id, edition_id),
  constraint question_items_id_edition_id_passage_id_key unique (id, edition_id, passage_id),
  constraint question_items_bank_version_check check (bank_version >= 1),
  constraint question_items_type_check
    check (type in ('word_order', 'word_choice', 'word_recall', 'similar_distinction')),
  -- variant: NULL, or word / segment for word_choice, or keyword / continuation for word_recall
  constraint question_items_variant_check
    check (
      variant is null
      or (type = 'word_choice' and variant in ('word', 'segment'))
      or (type = 'word_recall' and variant in ('keyword', 'continuation'))
    ),
  -- option_refs is present exactly for word_choice and similar_distinction
  constraint question_items_option_refs_presence_check
    check ((option_refs is not null) = (type in ('word_choice', 'similar_distinction'))),
  constraint question_items_covered_part_ids_check check (cardinality(covered_part_ids) >= 1),
  constraint question_items_token_refs_check check (jsonb_typeof(token_refs) = 'array'),
  constraint question_items_option_refs_check
    check (option_refs is null or jsonb_typeof(option_refs) = 'array'),
  constraint question_items_correct_ref_check check (jsonb_typeof(correct_ref) = 'array'),
  constraint question_items_context_refs_check check (jsonb_typeof(context_refs) = 'array'),
  constraint question_items_reference_check check (btrim(reference) <> ''),
  constraint question_items_status_check
    check (status in ('draft', 'validated', 'published', 'revoked')),
  constraint question_items_validation_record_check check (jsonb_typeof(validation_record) = 'object')
);
comment on table public.question_items is 'Deterministic question bank: four templates, token references only, never generated text (D20, D22, D31, D64).';

create index question_items_passage_id_type_idx on public.question_items (passage_id, type);
create index question_items_covered_part_ids_idx on public.question_items using gin (covered_part_ids);
create index question_items_edition_id_bank_version_idx on public.question_items (edition_id, bank_version);

alter table public.question_items enable row level security;
revoke all on table public.question_items from anon, authenticated;

-- 3.15 unit_embeddings (created, not populated in the MVP, D69) --------------

create table public.unit_embeddings (
  unit_id      uuid                  not null,
  bank_version integer               not null,
  model        text                  not null,
  edition_id   uuid                  not null,
  embedding    extensions.vector(384) not null,
  created_at   timestamptz           not null default now(),
  constraint unit_embeddings_pkey primary key (unit_id, bank_version, model),
  constraint unit_embeddings_unit_id_edition_id_fkey
    foreign key (unit_id, edition_id) references public.units (id, edition_id) on delete cascade,
  constraint unit_embeddings_bank_version_check check (bank_version >= 1),
  constraint unit_embeddings_model_check check (btrim(model) <> '')
);
comment on table public.unit_embeddings is 'Created but not populated in the MVP (D69); cosine HNSW operator class is proposed (OPEN-12).';

create index unit_embeddings_embedding_hnsw_idx
  on public.unit_embeddings
  using hnsw (embedding extensions.vector_cosine_ops);
create index unit_embeddings_edition_id_bank_version_idx
  on public.unit_embeddings (edition_id, bank_version);

alter table public.unit_embeddings enable row level security;
revoke all on table public.unit_embeddings from anon, authenticated;

-- 3.16 content_jobs ---------------------------------------------------------

create table public.content_jobs (
  id                 uuid        not null default gen_random_uuid(),
  edition_id         uuid        not null,
  bank_version       integer     not null,
  pipeline_version   text        not null,
  step               text        not null,
  cursor             jsonb,
  status             text        not null default 'pending',
  validation_summary jsonb,
  published_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint content_jobs_pkey primary key (id),
  constraint content_jobs_edition_id_fkey
    foreign key (edition_id) references public.book_editions (id) on delete cascade,
  constraint content_jobs_edition_id_bank_version_step_key unique (edition_id, bank_version, step),
  constraint content_jobs_bank_version_check check (bank_version >= 1),
  constraint content_jobs_pipeline_version_check check (btrim(pipeline_version) <> ''),
  constraint content_jobs_step_check
    check (step in (
      'acquired', 'verified', 'segmented', 'bank_built', 'validated', 'approved', 'published',
      'withdrawn', 'archived',
      'uploaded', 'extracted', 'page_mapped', 'embedded'
    )),
  constraint content_jobs_status_check
    check (status in ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  constraint content_jobs_cursor_check check (cursor is null or jsonb_typeof(cursor) = 'object'),
  constraint content_jobs_validation_summary_check
    check (validation_summary is null or jsonb_typeof(validation_summary) = 'object'),
  constraint content_jobs_published_at_check check (published_at is null or step = 'published')
);
comment on table public.content_jobs is 'Drives the Background Workflow: one row per (edition, bank version, step) (D37, D65).';

create index content_jobs_edition_id_status_idx on public.content_jobs (edition_id, status);

create trigger content_jobs_set_updated_at
  before update on public.content_jobs
  for each row execute function private.set_updated_at();

alter table public.content_jobs enable row level security;
revoke all on table public.content_jobs from anon, authenticated;

-- 3.17 generic_plan_templates -----------------------------------------------

create table public.generic_plan_templates (
  id                uuid        not null default gen_random_uuid(),
  edition_id        uuid        not null,
  catalog_version   integer     not null,
  scenario_key      text        not null,
  policy_json       jsonb       not null,
  generator_version text        not null,
  status            text        not null default 'draft',
  created_at        timestamptz not null default now(),
  constraint generic_plan_templates_pkey primary key (id),
  constraint generic_plan_templates_edition_id_fkey
    foreign key (edition_id) references public.book_editions (id) on delete cascade,
  constraint generic_plan_templates_natural_key
    unique (edition_id, catalog_version, scenario_key, generator_version),
  constraint generic_plan_templates_catalog_version_check check (catalog_version >= 1),
  constraint generic_plan_templates_scenario_key_check check (btrim(scenario_key) <> ''),
  constraint generic_plan_templates_policy_json_check check (jsonb_typeof(policy_json) = 'object'),
  constraint generic_plan_templates_generator_version_check check (btrim(generator_version) <> ''),
  constraint generic_plan_templates_status_check check (status in ('draft', 'published', 'retired'))
);
comment on table public.generic_plan_templates is 'Planning templates built from synthetic cases only; no account identifier or person record (D17, D29).';

alter table public.generic_plan_templates enable row level security;
revoke all on table public.generic_plan_templates from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Storage: private bucket `sources`, no policy (§9)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('sources', 'sources', false)
on conflict (id) do nothing;

-- `on conflict do nothing` would silently keep a pre-existing public bucket: fail loudly.
do $$
begin
  if not exists (select 1 from storage.buckets where id = 'sources' and public = false) then
    raise exception 'storage bucket "sources" must exist and be private (public = false)';
  end if;
end;
$$;
