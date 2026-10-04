-- 01_check_helpers.sql
--
-- LOCAL VALIDATION ONLY. Helper functions for the checks_*.sql files, created in a
-- throwaway schema `qa` of the scratch database. Applied by run_local.sh right after
-- the shim and before the first migration (the functions only name tables at run time).
-- Synthetic placeholder rows only: no source text is ever used.

create schema if not exists qa;
grant usage on schema qa to public;

-- Deterministic synthetic ids.
create function qa.id(n integer)
returns uuid
language sql
immutable
as $$
  select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

-- Runs p_sql and requires that it fails with SQLSTATE p_sqlstate (inside a subtransaction)
-- and, when p_constraint is given, on exactly that constraint.
create function qa.expect_error(
  p_sql text, p_sqlstate text, p_label text, p_constraint text default null)
returns void
language plpgsql
as $$
declare
  v_state      text;
  v_message    text;
  v_constraint text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_constraint = constraint_name;
    v_state := sqlstate;
    v_message := sqlerrm;
    if v_state = p_sqlstate and (p_constraint is null or v_constraint = p_constraint) then
      return;
    end if;
    raise exception 'FAIL [%]: expected SQLSTATE % (constraint %) but got % (constraint %): %',
      p_label, p_sqlstate, coalesce(p_constraint, 'any'), v_state, coalesce(v_constraint, 'none'), v_message;
  end;
  raise exception 'FAIL [%]: statement succeeded but SQLSTATE % was expected', p_label, p_sqlstate;
end;
$$;

-- Shorthands: 23514 check_violation, 23505 unique_violation, 23503 foreign_key_violation,
-- 23001 restrict_violation (also raised by the guard triggers of 0001).
create function qa.expect_check(p_sql text, p_constraint text)
returns void language sql as $$ select qa.expect_error(p_sql, '23514', p_constraint, p_constraint) $$;
create function qa.expect_unique(p_sql text, p_constraint text)
returns void language sql as $$ select qa.expect_error(p_sql, '23505', p_constraint, p_constraint) $$;
create function qa.expect_fk(p_sql text, p_constraint text)
returns void language sql as $$ select qa.expect_error(p_sql, '23503', p_constraint, p_constraint) $$;
create function qa.expect_restrict(p_sql text, p_label text, p_constraint text default null)
returns void language sql as $$ select qa.expect_error(p_sql, '23001', p_label, p_constraint) $$;

-- The 17 content tables of 0001_content, in dependency order.
create function qa.content_tables()
returns text[]
language sql
immutable
as $$
  select array[
    'categories', 'approved_source_rules', 'sources', 'books', 'book_editions',
    'edition_pages', 'book_sections', 'units', 'unit_page_spans', 'passages',
    'passage_parts', 'lessons', 'lesson_units', 'question_items', 'unit_embeddings',
    'content_jobs', 'generic_plan_templates'
  ]
$$;

-- Runs p_sql and requires that it succeeds.
create function qa.expect_ok(p_sql text, p_label text)
returns void
language plpgsql
as $$
begin
  execute p_sql;
exception when others then
  raise exception 'FAIL [%]: expected success but got SQLSTATE % (%)', p_label, sqlstate, sqlerrm;
end;
$$;

-- Minimal valid synthetic row graph for the 0001 content tables (one draft edition).
-- Ids: 1 category, 2 rule, 3 source, 4 book, 5 edition, 6 page, 7 section, 8 unit,
-- 9 passage, 10 part, 11 lesson, 12 question, 13 job, 14 template.
create function qa.make_fixture()
returns void
language plpgsql
as $$
begin
  insert into public.categories (id, slug, label_ar, label_en)
  values (qa.id(1), 'test-category', 'test', null);

  insert into public.approved_source_rules
    (id, policy_version, domain_or_book_family, field, eligibility_rule, policy_reference)
  values (qa.id(2), 'test', 'test', 'test', 'test', 'test');

  insert into public.sources (id, approved_rule_id, title, provider, source_url, rights_status)
  values (qa.id(3), qa.id(2), 'test', 'test', 'https://example.invalid/test',
          'owner_accepted_pending_verification');

  insert into public.books (id, category_id, title_ar, author, content_format)
  values (qa.id(4), qa.id(1), 'test', 'test', 'quran');

  insert into public.book_editions
    (id, book_id, source_id, edition_key, edition_label, language, version, bank_version)
  values (qa.id(5), qa.id(4), qa.id(3), 'test-edition', 'test', 'ar', 1, 1);

  insert into public.edition_pages (id, edition_id, printed_page_label, file_page_no, page_hash)
  values (qa.id(6), qa.id(5), '1', 1, repeat('a', 64));

  insert into public.book_sections (id, edition_id, ordinal, kind, reference, title_ar, title_en)
  values (qa.id(7), qa.id(5), 1, 'surah', '1', 'test', 'Test 1');

  insert into public.units
    (id, edition_id, section_id, ordinal, kind, reference, canonical_text, token_spans, text_hash)
  values (qa.id(8), qa.id(5), qa.id(7), 1, 'ayah', '1:1', 'test',
          '[{"i":0,"s":0,"e":4,"k":"word","n":"test"}]', repeat('b', 64));

  insert into public.unit_page_spans (unit_id, ordinal, edition_id, page_id, start_offset, end_offset)
  values (qa.id(8), 1, qa.id(5), qa.id(6), 0, 4);

  insert into public.passages
    (id, edition_id, bank_version, section_id, ordinal, path, start_ref, end_ref, word_count, reference)
  values (qa.id(9), qa.id(5), 1, qa.id(7), 1, 'quran', '1:0', '1:0', 1, '1:1');

  insert into public.passage_parts (id, passage_id, edition_id, ordinal, start_ref, end_ref, word_count)
  values (qa.id(10), qa.id(9), qa.id(5), 1, '1:0', '1:0', 1);

  insert into public.lessons (id, edition_id, bank_version, passage_id, ordinal, duration_estimate_sec)
  values (qa.id(11), qa.id(5), 1, qa.id(9), 1, 60);

  insert into public.lesson_units (lesson_id, ordinal, edition_id, unit_id, start_offset, end_offset)
  values (qa.id(11), 1, qa.id(5), qa.id(8), 0, 4);

  insert into public.question_items
    (id, edition_id, bank_version, passage_id, lesson_id, unit_id, type, variant,
     covered_part_ids, token_refs, option_refs, correct_ref, reference)
  values (qa.id(12), qa.id(5), 1, qa.id(9), qa.id(11), qa.id(8), 'word_choice', 'word',
          array[qa.id(10)], '["1:0"]', '[["1:0"],["1:0"]]', '["1:0"]', '1:1');

  insert into public.unit_embeddings (unit_id, bank_version, model, edition_id, embedding)
  values (qa.id(8), 1, 'test', qa.id(5), array_fill(0.1::real, array[384])::extensions.vector(384));

  insert into public.content_jobs (id, edition_id, bank_version, pipeline_version, step)
  values (qa.id(13), qa.id(5), 1, 'test', 'acquired');

  insert into public.generic_plan_templates
    (id, edition_id, catalog_version, scenario_key, policy_json, generator_version)
  values (qa.id(14), qa.id(5), 1, 'test', '{}', 'test');
end;
$$;

-- Moves the fixture edition to a status that its CHECK constraints accept.
create function qa.set_edition_status(p_status text)
returns void
language plpgsql
as $$
begin
  update public.book_editions
     set content_hash  = repeat('c', 64),
         review_record = '{"approval": {"who": "test", "at": "2026-01-01T00:00:00Z", "note": "test"}}',
         status        = p_status
   where id = qa.id(5);
end;
$$;

grant execute on all functions in schema qa to public;
