-- checks_0001.sql
--
-- LOCAL VALIDATION ONLY. Assertions for supabase/migrations/0001_content.sql, run by
-- run_local.sh right after that migration on a scratch database. Every "-- CHECK:" line
-- starts one independent chunk; a chunk passes when psql finishes it without an error.
-- Rows are synthetic placeholders (qa.make_fixture) created inside transactions that
-- are rolled back. Expected values are written out here from docs/Database-schema.md
-- v1.1 (§4.4, §5, §6.1, §9, §10, §11, §14 checks 3, 9, 11, 17), not read back from the
-- migration.

-- CHECK: 01 all 17 content tables exist in schema public
do $$
declare
  v_missing text[];
begin
  if cardinality(qa.content_tables()) <> 17 then
    raise exception 'the expected table list must hold 17 tables';
  end if;
  select array_agg(t order by t) into v_missing
  from unnest(qa.content_tables()) as t
  where not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = t and c.relkind = 'r');
  if v_missing is not null then
    raise exception 'missing tables: %', v_missing;
  end if;
end;
$$;

-- CHECK: 02 row level security is enabled (not forced) on all 17 tables
do $$
declare
  v_bad text[];
begin
  select array_agg(c.relname order by c.relname) into v_bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any (qa.content_tables())
    and not (c.relrowsecurity and not c.relforcerowsecurity);
  if v_bad is not null then
    raise exception 'RLS not enabled (or forced) on: %', v_bad;
  end if;
end;
$$;

-- CHECK: 03 anon and authenticated hold no privilege on the 17 tables (control: platform defaults are active)
begin;
create table public.qa_default_privilege_probe (id integer);
do $$
begin
  if not has_table_privilege('anon', 'public.qa_default_privilege_probe', 'SELECT')
     or not has_table_privilege('authenticated', 'public.qa_default_privilege_probe', 'INSERT')
     or not has_table_privilege('service_role', 'public.qa_default_privilege_probe', 'DELETE') then
    raise exception 'control failed: the shim default privileges are not active, so this check would be vacuous';
  end if;
end;
$$;
rollback;
do $$
declare
  r record;
begin
  for r in
    select t, rol, p
    from unnest(qa.content_tables()) as t
    cross join unnest(array['anon', 'authenticated']) as rol
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p
  loop
    if has_table_privilege(r.rol, format('public.%I', r.t), r.p) then
      raise exception '% holds % on public.%', r.rol, r.p, r.t;
    end if;
  end loop;
  for r in
    select t, rol, p
    from unnest(qa.content_tables()) as t
    cross join unnest(array['anon', 'authenticated']) as rol
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as p
  loop
    if has_any_column_privilege(r.rol, format('public.%I', r.t), r.p) then
      raise exception '% holds column-level % on public.%', r.rol, r.p, r.t;
    end if;
  end loop;
end;
$$;

-- CHECK: 04 service_role keeps select, insert, update, delete on the 17 tables (publishing scope)
do $$
declare
  r record;
begin
  for r in
    select t, p
    from unnest(qa.content_tables()) as t
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p
  loop
    if not has_table_privilege('service_role', format('public.%I', r.t), r.p) then
      raise exception 'service_role lacks % on public.%', r.p, r.t;
    end if;
  end loop;
end;
$$;

-- CHECK: 05 schema private exists and is locked (no USAGE or CREATE for public, anon, authenticated, service_role)
do $$
declare
  r text;
begin
  if not exists (select 1 from pg_namespace where nspname = 'private') then
    raise exception 'schema private does not exist';
  end if;
  foreach r in array array['public', 'anon', 'authenticated', 'service_role'] loop
    if has_schema_privilege(r, 'private', 'USAGE') then
      raise exception '% has USAGE on schema private', r;
    end if;
    if has_schema_privilege(r, 'private', 'CREATE') then
      raise exception '% has CREATE on schema private', r;
    end if;
  end loop;
  if exists (
    select 1
    from pg_namespace n, aclexplode(n.nspacl) a
    where n.nspname = 'private' and a.grantee <> n.nspowner
  ) then
    raise exception 'schema private has an ACL entry for a role other than its owner';
  end if;
end;
$$;

-- CHECK: 06 the three trigger helpers exist in private (plpgsql, invoker, search_path empty, not executable by API roles)
do $$
declare
  n text;
  r record;
  rol text;
begin
  foreach n in array array['set_updated_at', 'guard_edition_delete', 'guard_unit_text'] loop
    select p.oid, p.prorettype, p.prosecdef, p.proconfig, l.lanname into r
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where ns.nspname = 'private' and p.proname = n and p.pronargs = 0;
    if not found then
      raise exception 'function private.%() does not exist', n;
    end if;
    if r.prorettype <> 'trigger'::regtype then
      raise exception 'private.%() does not return trigger', n;
    end if;
    if r.lanname <> 'plpgsql' then
      raise exception 'private.%() is not plpgsql', n;
    end if;
    if r.prosecdef then
      raise exception 'private.%() is security definer, §10 says invoker', n;
    end if;
    if not exists (select 1 from unnest(coalesce(r.proconfig, '{}')) c where c in ('search_path=""', 'search_path=')) then
      raise exception 'private.%() lacks search_path = '''' (proconfig %)', n, r.proconfig;
    end if;
    foreach rol in array array['public', 'anon', 'authenticated', 'service_role'] loop
      if has_function_privilege(rol, r.oid, 'EXECUTE') then
        raise exception '% can execute private.%()', rol, n;
      end if;
    end loop;
  end loop;
end;
$$;

-- CHECK: 07 triggers are attached exactly where §6.1 and §10 say
do $$
declare
  v_missing text[];
  v_extra text[];
begin
  with expected(spec) as (
    values
      ('categories|categories_set_updated_at|set_updated_at|BEFORE UPDATE ROW'),
      ('sources|sources_set_updated_at|set_updated_at|BEFORE UPDATE ROW'),
      ('books|books_set_updated_at|set_updated_at|BEFORE UPDATE ROW'),
      ('book_editions|book_editions_set_updated_at|set_updated_at|BEFORE UPDATE ROW'),
      ('book_editions|book_editions_guard_delete|guard_edition_delete|BEFORE DELETE ROW'),
      ('units|units_guard_text|guard_unit_text|BEFORE UPDATE ROW'),
      ('content_jobs|content_jobs_set_updated_at|set_updated_at|BEFORE UPDATE ROW')
  ), actual as (
    select c.relname || '|' || t.tgname || '|' || p.proname || '|' ||
           case when t.tgtype & 2 = 2 then 'BEFORE' when t.tgtype & 64 = 64 then 'INSTEAD OF' else 'AFTER' end || ' ' ||
           concat_ws(' OR ',
             case when t.tgtype & 4 = 4 then 'INSERT' end,
             case when t.tgtype & 8 = 8 then 'DELETE' end,
             case when t.tgtype & 16 = 16 then 'UPDATE' end,
             case when t.tgtype & 32 = 32 then 'TRUNCATE' end) || ' ' ||
           case when t.tgtype & 1 = 1 then 'ROW' else 'STATEMENT' end ||
           case when t.tgenabled <> 'O' then ' (not enabled)' else '' end as spec
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    where n.nspname = 'public' and c.relname = any (qa.content_tables()) and not t.tgisinternal
  )
  select
    (select array_agg(spec) from expected where spec not in (select spec from actual)),
    (select array_agg(spec) from actual where spec not in (select spec from expected))
  into v_missing, v_extra;
  if v_missing is not null or v_extra is not null then
    raise exception 'trigger mismatch: missing %, unexpected %', v_missing, v_extra;
  end if;
end;
$$;

-- CHECK: 08 bucket sources exists and is private; no storage.objects policy; anon and authenticated cannot see or write objects
begin;
do $$
begin
  if not exists (select 1 from storage.buckets where id = 'sources' and name = 'sources' and public = false) then
    raise exception 'bucket sources is missing or public';
  end if;
  if (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects') <> 0 then
    raise exception 'a storage.objects policy exists (the sources bucket must have none)';
  end if;
end;
$$;
insert into storage.objects (bucket_id, name) values ('sources', 'test-edition/raw/synthetic.json');
set local role anon;
do $$
begin
  if (select count(*) from storage.objects) <> 0 then
    raise exception 'anon can read storage objects';
  end if;
  perform qa.expect_error($q$insert into storage.objects (bucket_id, name) values ('sources', 'x')$q$, '42501', 'anon insert object');
end;
$$;
reset role;
set local role authenticated;
do $$
begin
  if (select count(*) from storage.objects) <> 0 then
    raise exception 'authenticated can read storage objects';
  end if;
  perform qa.expect_error($q$insert into storage.objects (bucket_id, name) values ('sources', 'x')$q$, '42501', 'authenticated insert object');
end;
$$;
reset role;
set local role service_role;
do $$
begin
  if (select count(*) from storage.objects) <> 1 then
    raise exception 'service_role cannot read the object it should reach (bypass RLS)';
  end if;
end;
$$;
rollback;

-- CHECK: 09 vector extension in schema extensions; unit_embeddings.embedding is vector(384) with a cosine HNSW index
begin;
do $$
declare
  v_schema text;
  v_row record;
  v_def text;
begin
  select n.nspname into v_schema
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'vector';
  if v_schema is distinct from 'extensions' then
    raise exception 'extension vector is in schema %, expected extensions', v_schema;
  end if;

  select a.atttypmod, a.attnotnull, t.typname, tn.nspname as typschema into v_row
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_type t on t.oid = a.atttypid
  join pg_namespace tn on tn.oid = t.typnamespace
  where c.oid = 'public.unit_embeddings'::regclass and a.attname = 'embedding' and not a.attisdropped;
  if v_row.typname is distinct from 'vector' or v_row.typschema is distinct from 'extensions' then
    raise exception 'embedding has type %.%', v_row.typschema, v_row.typname;
  end if;
  if v_row.atttypmod <> 384 then
    raise exception 'embedding typmod is %, expected 384', v_row.atttypmod;
  end if;
  if not v_row.attnotnull then
    raise exception 'embedding must be NOT NULL';
  end if;

  select pg_get_indexdef(i.indexrelid) into v_def
  from pg_index i
  join pg_class ic on ic.oid = i.indexrelid
  join pg_am am on am.oid = ic.relam
  where i.indrelid = 'public.unit_embeddings'::regclass and am.amname = 'hnsw';
  if v_def is null or v_def not like '%vector_cosine_ops%' then
    raise exception 'no HNSW cosine index on unit_embeddings.embedding (found: %)', v_def;
  end if;
end;
$$;
select qa.make_fixture();
-- the fixture inserted a 384-dimension vector; other dimensions are rejected
select qa.expect_error($q$insert into public.unit_embeddings (unit_id, bank_version, model, edition_id, embedding)
  values (qa.id(8), 1, 'test-3d', qa.id(5), '[1,2,3]'::extensions.vector)$q$, '22000', 'wrong embedding dimension');
-- the cosine operator works against the column
select qa.expect_ok($q$select unit_id from public.unit_embeddings
  order by embedding operator(extensions.<=>) array_fill(0.1::real, array[384])::extensions.vector limit 1$q$, 'cosine order by');
rollback;

-- CHECK: 10 columns: name, type, nullability and default match §6.1 for all 17 tables
do $$
declare
  v_spec constant text := $spec$
categories|id|uuid|t|gen_random_uuid()
categories|slug|text|t|
categories|label_ar|text|t|
categories|label_en|text|f|
categories|display_order|integer|t|0
categories|created_at|timestamp with time zone|t|now()
categories|updated_at|timestamp with time zone|t|now()
approved_source_rules|id|uuid|t|gen_random_uuid()
approved_source_rules|policy_version|text|t|
approved_source_rules|domain_or_book_family|text|t|
approved_source_rules|field|text|t|
approved_source_rules|eligibility_rule|text|t|
approved_source_rules|policy_reference|text|t|
approved_source_rules|created_at|timestamp with time zone|t|now()
sources|id|uuid|t|
sources|approved_rule_id|uuid|f|
sources|title|text|t|
sources|provider|text|t|
sources|source_url|text|t|
sources|eligibility_record|jsonb|t|'{}'::jsonb
sources|license_url|text|f|
sources|license_record|jsonb|t|'{}'::jsonb
sources|checked_at|timestamp with time zone|f|
sources|rights_status|text|t|
sources|created_at|timestamp with time zone|t|now()
sources|updated_at|timestamp with time zone|t|now()
books|id|uuid|t|
books|category_id|uuid|t|
books|title_ar|text|t|
books|title_en|text|f|
books|author|text|t|
books|content_format|text|t|
books|created_at|timestamp with time zone|t|now()
books|updated_at|timestamp with time zone|t|now()
book_editions|id|uuid|t|
book_editions|book_id|uuid|t|
book_editions|source_id|uuid|t|
book_editions|edition_key|text|t|
book_editions|edition_label|text|t|
book_editions|language|text|t|
book_editions|version|integer|t|
book_editions|bank_version|integer|t|
book_editions|raw_storage_path|text|f|
book_editions|content_hash|text|f|
book_editions|pagination_record|jsonb|t|'{}'::jsonb
book_editions|status|text|t|'draft'::text
book_editions|review_record|jsonb|t|'{}'::jsonb
book_editions|catalog_hidden|boolean|t|false
book_editions|archived_at|timestamp with time zone|f|
book_editions|created_at|timestamp with time zone|t|now()
book_editions|updated_at|timestamp with time zone|t|now()
edition_pages|id|uuid|t|
edition_pages|edition_id|uuid|t|
edition_pages|printed_page_label|text|f|
edition_pages|file_page_no|integer|f|
edition_pages|page_hash|text|t|
edition_pages|validation_record|jsonb|t|'{}'::jsonb
book_sections|id|uuid|t|
book_sections|edition_id|uuid|t|
book_sections|parent_id|uuid|f|
book_sections|ordinal|integer|t|
book_sections|kind|text|t|
book_sections|reference|text|t|
book_sections|title_ar|text|t|
book_sections|title_en|text|t|
book_sections|source_url|text|f|
units|id|uuid|t|
units|edition_id|uuid|t|
units|section_id|uuid|t|
units|ordinal|integer|t|
units|kind|text|t|
units|reference|text|t|
units|source_url|text|f|
units|canonical_text|text|t|
units|char_start|integer|f|
units|char_end|integer|f|
units|token_spans|jsonb|t|
units|text_hash|text|t|
units|hadith_meta|jsonb|f|
unit_page_spans|unit_id|uuid|t|
unit_page_spans|ordinal|integer|t|
unit_page_spans|edition_id|uuid|t|
unit_page_spans|page_id|uuid|t|
unit_page_spans|start_offset|integer|t|
unit_page_spans|end_offset|integer|t|
passages|id|uuid|t|
passages|edition_id|uuid|t|
passages|bank_version|integer|t|
passages|section_id|uuid|t|
passages|ordinal|integer|t|
passages|path|text|t|
passages|start_ref|text|t|
passages|end_ref|text|t|
passages|word_count|integer|t|
passages|reference|text|t|
passage_parts|id|uuid|t|
passage_parts|passage_id|uuid|t|
passage_parts|edition_id|uuid|t|
passage_parts|ordinal|integer|t|
passage_parts|start_ref|text|t|
passage_parts|end_ref|text|t|
passage_parts|word_count|integer|t|
lessons|id|uuid|t|
lessons|edition_id|uuid|t|
lessons|bank_version|integer|t|
lessons|passage_id|uuid|t|
lessons|ordinal|integer|t|
lessons|duration_estimate_sec|integer|t|
lessons|status|text|t|'draft'::text
lesson_units|lesson_id|uuid|t|
lesson_units|ordinal|integer|t|
lesson_units|edition_id|uuid|t|
lesson_units|unit_id|uuid|t|
lesson_units|start_offset|integer|t|
lesson_units|end_offset|integer|t|
question_items|id|uuid|t|
question_items|edition_id|uuid|t|
question_items|bank_version|integer|t|
question_items|passage_id|uuid|t|
question_items|lesson_id|uuid|f|
question_items|unit_id|uuid|t|
question_items|type|text|t|
question_items|variant|text|f|
question_items|covered_part_ids|uuid[]|t|
question_items|token_refs|jsonb|t|
question_items|option_refs|jsonb|f|
question_items|correct_ref|jsonb|t|
question_items|context_refs|jsonb|t|'[]'::jsonb
question_items|reference|text|t|
question_items|status|text|t|'draft'::text
question_items|validation_record|jsonb|t|'{}'::jsonb
unit_embeddings|unit_id|uuid|t|
unit_embeddings|bank_version|integer|t|
unit_embeddings|model|text|t|
unit_embeddings|edition_id|uuid|t|
unit_embeddings|embedding|vector(384)|t|
unit_embeddings|created_at|timestamp with time zone|t|now()
content_jobs|id|uuid|t|gen_random_uuid()
content_jobs|edition_id|uuid|t|
content_jobs|bank_version|integer|t|
content_jobs|pipeline_version|text|t|
content_jobs|step|text|t|
content_jobs|cursor|jsonb|f|
content_jobs|status|text|t|'pending'::text
content_jobs|validation_summary|jsonb|f|
content_jobs|published_at|timestamp with time zone|f|
content_jobs|created_at|timestamp with time zone|t|now()
content_jobs|updated_at|timestamp with time zone|t|now()
generic_plan_templates|id|uuid|t|gen_random_uuid()
generic_plan_templates|edition_id|uuid|t|
generic_plan_templates|catalog_version|integer|t|
generic_plan_templates|scenario_key|text|t|
generic_plan_templates|policy_json|jsonb|t|
generic_plan_templates|generator_version|text|t|
generic_plan_templates|status|text|t|'draft'::text
generic_plan_templates|created_at|timestamp with time zone|t|now()
$spec$;
  v_diff text;
  v_expected_rows integer;
begin
  create temporary table qa_expected_columns on commit drop as
  select split_part(l, '|', 1) as tbl,
         split_part(l, '|', 2) as col,
         split_part(l, '|', 3) as typ,
         split_part(l, '|', 4) = 't' as not_null,
         nullif(split_part(l, '|', 5), '') as def
  from regexp_split_to_table(v_spec, E'\n') as l
  where l <> '';

  select count(*) into v_expected_rows from qa_expected_columns;

  select string_agg(d, E'\n  ') into v_diff
  from (
    select coalesce(e.tbl, a.tbl) || '.' || coalesce(e.col, a.col) || ': ' ||
           case
             when a.col is null then 'missing in database'
             when e.col is null then 'unexpected column in database'
             else concat_ws('; ',
               case when e.typ <> a.typ then format('type %s <> expected %s', a.typ, e.typ) end,
               case when e.not_null <> a.not_null then format('not null %s <> expected %s', a.not_null, e.not_null) end,
               case when e.def is distinct from a.def then format('default %s <> expected %s', coalesce(a.def, '(none)'), coalesce(e.def, '(none)')) end)
           end as d
    from qa_expected_columns e
    full join (
      select c.relname as tbl,
             a.attname as col,
             replace(format_type(a.atttypid, a.atttypmod), 'extensions.', '') as typ,
             a.attnotnull as not_null,
             pg_get_expr(ad.adbin, ad.adrelid) as def
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum
      where n.nspname = 'public' and c.relname = any (qa.content_tables())
        and a.attnum > 0 and not a.attisdropped
    ) a on a.tbl = e.tbl and a.col = e.col
    where e.col is null or a.col is null
       or e.typ <> a.typ or e.not_null <> a.not_null or e.def is distinct from a.def
  ) q(d);
  if v_diff is not null then
    raise exception E'column mismatch:\n  %', v_diff;
  end if;
  if v_expected_rows <> 156 then
    raise exception 'expected-column list holds % rows, expected 156 (list edited without updating the count)', v_expected_rows;
  end if;
end;
$$;

-- CHECK: 11 primary keys and unique constraints match §6.1 (column lists and order)
do $$
declare
  v_missing text[];
  v_extra text[];
begin
  with expected(spec) as (
    values
      ('categories|p|id'), ('categories|u|slug'),
      ('approved_source_rules|p|id'), ('approved_source_rules|u|policy_version,domain_or_book_family,field'),
      ('sources|p|id'),
      ('books|p|id'),
      ('book_editions|p|id'), ('book_editions|u|edition_key'), ('book_editions|u|book_id,version'),
      ('edition_pages|p|id'), ('edition_pages|u|id,edition_id'),
      ('edition_pages|u|edition_id,printed_page_label'), ('edition_pages|u|edition_id,file_page_no'),
      ('book_sections|p|id'), ('book_sections|u|id,edition_id'), ('book_sections|u|edition_id,ordinal'),
      ('units|p|id'), ('units|u|id,edition_id'), ('units|u|edition_id,ordinal'),
      ('unit_page_spans|p|unit_id,ordinal'),
      ('passages|p|id'), ('passages|u|edition_id,bank_version,path,ordinal'),
      ('passages|u|id,edition_id'), ('passages|u|id,edition_id,bank_version'),
      ('passage_parts|p|id'), ('passage_parts|u|passage_id,ordinal'), ('passage_parts|u|id,passage_id'),
      ('lessons|p|id'), ('lessons|u|edition_id,bank_version,ordinal'), ('lessons|u|id,edition_id'),
      ('lesson_units|p|lesson_id,ordinal'),
      ('question_items|p|id'), ('question_items|u|id,edition_id'), ('question_items|u|id,edition_id,passage_id'),
      ('unit_embeddings|p|unit_id,bank_version,model'),
      ('content_jobs|p|id'), ('content_jobs|u|edition_id,bank_version,step'),
      ('generic_plan_templates|p|id'),
      ('generic_plan_templates|u|edition_id,catalog_version,scenario_key,generator_version')
  ), actual as (
    select c.relname || '|' || k.contype::text || '|' ||
           (select string_agg(a.attname, ',' order by ord.n)
            from unnest(k.conkey) with ordinality as ord(attnum, n)
            join pg_attribute a on a.attrelid = k.conrelid and a.attnum = ord.attnum) as spec
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = any (qa.content_tables()) and k.contype in ('p', 'u')
  )
  select
    (select array_agg(spec) from expected where spec not in (select spec from actual)),
    (select array_agg(spec) from actual where spec not in (select spec from expected))
  into v_missing, v_extra;
  if v_missing is not null or v_extra is not null then
    raise exception 'key mismatch: missing %, unexpected %', v_missing, v_extra;
  end if;
end;
$$;

-- CHECK: 12 foreign keys match §6.1 and the delete classes of §4.2 (D cascade, E restrict)
do $$
declare
  v_missing text[];
  v_extra text[];
begin
  with expected(spec) as (
    values
      ('sources|approved_rule_id|approved_source_rules|id|RESTRICT'),
      ('books|category_id|categories|id|RESTRICT'),
      ('book_editions|book_id|books|id|RESTRICT'),
      ('book_editions|source_id|sources|id|RESTRICT'),
      ('edition_pages|edition_id|book_editions|id|CASCADE'),
      ('book_sections|edition_id|book_editions|id|CASCADE'),
      ('book_sections|parent_id,edition_id|book_sections|id,edition_id|CASCADE'),
      ('units|section_id,edition_id|book_sections|id,edition_id|CASCADE'),
      ('unit_page_spans|unit_id,edition_id|units|id,edition_id|CASCADE'),
      ('unit_page_spans|page_id,edition_id|edition_pages|id,edition_id|CASCADE'),
      ('passages|section_id,edition_id|book_sections|id,edition_id|CASCADE'),
      ('passage_parts|passage_id,edition_id|passages|id,edition_id|CASCADE'),
      ('lessons|passage_id,edition_id,bank_version|passages|id,edition_id,bank_version|CASCADE'),
      ('lesson_units|lesson_id,edition_id|lessons|id,edition_id|CASCADE'),
      ('lesson_units|unit_id,edition_id|units|id,edition_id|CASCADE'),
      ('question_items|passage_id,edition_id,bank_version|passages|id,edition_id,bank_version|CASCADE'),
      ('question_items|lesson_id,edition_id|lessons|id,edition_id|CASCADE'),
      ('question_items|unit_id,edition_id|units|id,edition_id|CASCADE'),
      ('unit_embeddings|unit_id,edition_id|units|id,edition_id|CASCADE'),
      ('content_jobs|edition_id|book_editions|id|CASCADE'),
      ('generic_plan_templates|edition_id|book_editions|id|CASCADE')
  ), actual as (
    select c.relname || '|' ||
           (select string_agg(a.attname, ',' order by ord.n)
            from unnest(k.conkey) with ordinality as ord(attnum, n)
            join pg_attribute a on a.attrelid = k.conrelid and a.attnum = ord.attnum) || '|' ||
           rc.relname || '|' ||
           (select string_agg(a.attname, ',' order by ord.n)
            from unnest(k.confkey) with ordinality as ord(attnum, n)
            join pg_attribute a on a.attrelid = k.confrelid and a.attnum = ord.attnum) || '|' ||
           case k.confdeltype
             when 'a' then 'NO ACTION' when 'r' then 'RESTRICT' when 'c' then 'CASCADE'
             when 'n' then 'SET NULL' when 'd' then 'SET DEFAULT' end ||
           case when k.confupdtype <> 'a' then ' (on update ' || k.confupdtype::text || ')' else '' end ||
           case when k.condeferrable then ' (deferrable)' else '' end ||
           case when k.confmatchtype <> 's' then ' (match ' || k.confmatchtype::text || ')' else '' end as spec
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
    join pg_class rc on rc.oid = k.confrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = any (qa.content_tables()) and k.contype = 'f'
  )
  select
    (select array_agg(spec) from expected where spec not in (select spec from actual)),
    (select array_agg(spec) from actual where spec not in (select spec from expected))
  into v_missing, v_extra;
  if v_missing is not null or v_extra is not null then
    raise exception 'foreign key mismatch: missing %, unexpected %', v_missing, v_extra;
  end if;
end;
$$;

-- CHECK: 13 secondary indexes of §6.1 exist (and no others besides the key indexes)
do $$
declare
  v_missing text[];
  v_extra text[];
begin
  with expected(idx, tbl, fragments) as (
    values
      ('sources_approved_rule_id_idx', 'sources', array['USING btree (approved_rule_id)']),
      ('books_category_id_idx', 'books', array['USING btree (category_id)']),
      ('book_editions_book_id_published_idx', 'book_editions',
        array['USING btree (book_id)', 'WHERE', 'published', 'superseded']),
      ('book_editions_source_id_idx', 'book_editions', array['USING btree (source_id)']),
      ('book_sections_parent_id_idx', 'book_sections',
        array['USING btree (parent_id)', 'WHERE (parent_id IS NOT NULL)']),
      ('units_section_id_ordinal_idx', 'units', array['USING btree (section_id, ordinal)']),
      ('unit_page_spans_page_id_idx', 'unit_page_spans', array['USING btree (page_id)']),
      ('passages_section_id_idx', 'passages', array['USING btree (section_id)']),
      ('lessons_passage_id_idx', 'lessons', array['USING btree (passage_id)']),
      ('lesson_units_unit_id_idx', 'lesson_units', array['USING btree (unit_id)']),
      ('question_items_passage_id_type_idx', 'question_items', array['USING btree (passage_id, type)']),
      ('question_items_covered_part_ids_idx', 'question_items', array['USING gin (covered_part_ids)']),
      ('question_items_edition_id_bank_version_idx', 'question_items',
        array['USING btree (edition_id, bank_version)']),
      ('unit_embeddings_embedding_hnsw_idx', 'unit_embeddings',
        array['USING hnsw (embedding', 'vector_cosine_ops']),
      ('unit_embeddings_edition_id_bank_version_idx', 'unit_embeddings',
        array['USING btree (edition_id, bank_version)']),
      ('content_jobs_edition_id_status_idx', 'content_jobs', array['USING btree (edition_id, status)'])
  ), actual as (
    select ic.relname as idx, c.relname as tbl, pg_get_indexdef(i.indexrelid) as def
    from pg_index i
    join pg_class ic on ic.oid = i.indexrelid
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = any (qa.content_tables())
      and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid)
  )
  select
    (select array_agg(e.idx) from expected e
      where not exists (
        select 1 from actual a
        where a.idx = e.idx and a.tbl = e.tbl
          and not exists (select 1 from unnest(e.fragments) f where position(f in a.def) = 0))),
    (select array_agg(a.idx) from actual a where a.idx not in (select idx from expected))
  into v_missing, v_extra;
  if v_missing is not null or v_extra is not null then
    raise exception 'index mismatch: missing or different %, unexpected %', v_missing, v_extra;
  end if;
end;
$$;

-- CHECK: 14 value sets of §4.4 reject unknown values and accept every listed value
begin;
select qa.make_fixture();
do $$
declare
  v text;
begin
  -- books.content_format
  perform qa.expect_check($q$update public.books set content_format = 'bogus' where id = qa.id(4)$q$, 'books_content_format_check');
  foreach v in array array['quran', 'hadith_collection'] loop
    perform qa.expect_ok(format('update public.books set content_format = %L where id = qa.id(4)', v), 'books.content_format ' || v);
  end loop;

  -- sources.rights_status
  perform qa.expect_check($q$update public.sources set rights_status = 'bogus' where id = qa.id(3)$q$, 'sources_rights_status_check');
  foreach v in array array['owner_accepted_pending_verification', 'verified', 'rejected'] loop
    perform qa.expect_ok(format('update public.sources set rights_status = %L where id = qa.id(3)', v), 'sources.rights_status ' || v);
  end loop;

  -- book_editions.status (an unknown value, then every listed value with a fingerprint and an approval record)
  perform qa.expect_check($q$update public.book_editions set status = 'bogus', content_hash = repeat('c', 64),
    review_record = '{"approval": {}}' where id = qa.id(5)$q$, 'book_editions_status_check');
  foreach v in array array['draft', 'validated', 'published', 'superseded', 'revoked'] loop
    perform qa.expect_ok(format('select qa.set_edition_status(%L)', v), 'book_editions.status ' || v);
  end loop;
  perform qa.set_edition_status('draft');

  -- book_sections.kind
  perform qa.expect_check($q$update public.book_sections set kind = 'bogus' where id = qa.id(7)$q$, 'book_sections_kind_check');
  foreach v in array array['surah', 'hadith'] loop
    perform qa.expect_ok(format('update public.book_sections set kind = %L where id = qa.id(7)', v), 'book_sections.kind ' || v);
  end loop;

  -- units.kind
  -- (hadith_meta follows the kind: NULL for ayah, an object for hadith units)
  perform qa.expect_check($q$update public.units set kind = 'bogus', hadith_meta = '{}' where id = qa.id(8)$q$, 'units_kind_check');
  foreach v in array array['ayah', 'hadith_narration', 'hadith_takhrij', 'hadith_grade'] loop
    perform qa.expect_ok(format('update public.units set kind = %L, hadith_meta = %s where id = qa.id(8)',
                                v, case when v = 'ayah' then 'null' else '''{}''::jsonb' end), 'units.kind ' || v);
  end loop;

  -- passages.path
  perform qa.expect_check($q$update public.passages set path = 'bogus' where id = qa.id(9)$q$, 'passages_path_check');
  -- five paths: quran and the four hadith paths (owner decision 4 Oct 2026, D75 pending register update)
  foreach v in array array['quran', 'matn', 'sanad', 'takhrij', 'grade'] loop
    perform qa.expect_ok(format('update public.passages set path = %L where id = qa.id(9)', v), 'passages.path ' || v);
  end loop;

  -- lessons.status
  perform qa.expect_check($q$update public.lessons set status = 'bogus' where id = qa.id(11)$q$, 'lessons_status_check');
  foreach v in array array['draft', 'validated', 'published', 'revoked'] loop
    perform qa.expect_ok(format('update public.lessons set status = %L where id = qa.id(11)', v), 'lessons.status ' || v);
  end loop;

  -- question_items.status
  perform qa.expect_check($q$update public.question_items set status = 'bogus' where id = qa.id(12)$q$, 'question_items_status_check');
  foreach v in array array['draft', 'validated', 'published', 'revoked'] loop
    perform qa.expect_ok(format('update public.question_items set status = %L where id = qa.id(12)', v), 'question_items.status ' || v);
  end loop;

  -- question_items.type and variant (consistent combinations only)
  perform qa.expect_check($q$update public.question_items set type = 'bogus', variant = null, option_refs = null where id = qa.id(12)$q$, 'question_items_type_check');
  perform qa.expect_ok($q$update public.question_items set type = 'word_order', variant = null, option_refs = null where id = qa.id(12)$q$, 'type word_order');
  perform qa.expect_ok($q$update public.question_items set type = 'word_choice', variant = 'word', option_refs = '[["1:0"]]' where id = qa.id(12)$q$, 'type word_choice/word');
  perform qa.expect_ok($q$update public.question_items set type = 'word_choice', variant = 'segment', option_refs = '[["1:0"]]' where id = qa.id(12)$q$, 'type word_choice/segment');
  perform qa.expect_ok($q$update public.question_items set type = 'word_choice', variant = null, option_refs = '[["1:0"]]' where id = qa.id(12)$q$, 'type word_choice/null');
  perform qa.expect_ok($q$update public.question_items set type = 'word_recall', variant = 'keyword', option_refs = null where id = qa.id(12)$q$, 'type word_recall/keyword');
  perform qa.expect_ok($q$update public.question_items set type = 'word_recall', variant = 'continuation', option_refs = null where id = qa.id(12)$q$, 'type word_recall/continuation');
  perform qa.expect_ok($q$update public.question_items set type = 'word_recall', variant = null, option_refs = null where id = qa.id(12)$q$, 'type word_recall/null');
  perform qa.expect_ok($q$update public.question_items set type = 'similar_distinction', variant = null, option_refs = '[["1:0"]]' where id = qa.id(12)$q$, 'type similar_distinction');
  perform qa.expect_check($q$update public.question_items set type = 'word_choice', variant = 'bogus', option_refs = '[["1:0"]]' where id = qa.id(12)$q$, 'question_items_variant_check');
  perform qa.expect_check($q$update public.question_items set type = 'word_choice', variant = 'keyword', option_refs = '[["1:0"]]' where id = qa.id(12)$q$, 'question_items_variant_check');
  perform qa.expect_check($q$update public.question_items set type = 'word_recall', variant = 'word', option_refs = null where id = qa.id(12)$q$, 'question_items_variant_check');
  perform qa.expect_check($q$update public.question_items set type = 'word_order', variant = 'word', option_refs = null where id = qa.id(12)$q$, 'question_items_variant_check');
  perform qa.expect_check($q$update public.question_items set type = 'similar_distinction', variant = 'word', option_refs = '[["1:0"]]' where id = qa.id(12)$q$, 'question_items_variant_check');
  -- option_refs present exactly for word_choice and similar_distinction
  perform qa.expect_check($q$update public.question_items set type = 'word_choice', variant = null, option_refs = null where id = qa.id(12)$q$, 'question_items_option_refs_presence_check');
  perform qa.expect_check($q$update public.question_items set type = 'similar_distinction', variant = null, option_refs = null where id = qa.id(12)$q$, 'question_items_option_refs_presence_check');
  perform qa.expect_check($q$update public.question_items set type = 'word_order', variant = null, option_refs = '[["1:0"]]' where id = qa.id(12)$q$, 'question_items_option_refs_presence_check');
  perform qa.expect_check($q$update public.question_items set type = 'word_recall', variant = null, option_refs = '[["1:0"]]' where id = qa.id(12)$q$, 'question_items_option_refs_presence_check');

  -- generic_plan_templates.status
  perform qa.expect_check($q$update public.generic_plan_templates set status = 'bogus' where id = qa.id(14)$q$, 'generic_plan_templates_status_check');
  foreach v in array array['draft', 'published', 'retired'] loop
    perform qa.expect_ok(format('update public.generic_plan_templates set status = %L where id = qa.id(14)', v), 'generic_plan_templates.status ' || v);
  end loop;

  -- content_jobs.status and content_jobs.step
  perform qa.expect_check($q$update public.content_jobs set status = 'bogus' where id = qa.id(13)$q$, 'content_jobs_status_check');
  foreach v in array array['pending', 'running', 'succeeded', 'failed', 'skipped'] loop
    perform qa.expect_ok(format('update public.content_jobs set status = %L where id = qa.id(13)', v), 'content_jobs.status ' || v);
  end loop;
  perform qa.expect_check($q$update public.content_jobs set step = 'bogus' where id = qa.id(13)$q$, 'content_jobs_step_check');
  foreach v in array array['acquired', 'verified', 'segmented', 'bank_built', 'validated', 'approved',
                           'withdrawn', 'archived', 'uploaded', 'extracted', 'page_mapped', 'embedded'] loop
    perform qa.expect_ok(format('update public.content_jobs set step = %L where id = qa.id(13)', v), 'content_jobs.step ' || v);
  end loop;
  perform qa.expect_ok($q$update public.content_jobs set step = 'published', published_at = now() where id = qa.id(13)$q$, 'content_jobs.step published');
end;
$$;
rollback;

-- CHECK: 15 other CHECK rules of §6.1 (formats, bounds, containers, couplings) reject bad values
begin;
select qa.make_fixture();
do $$
begin
  -- categories
  perform qa.expect_check($q$update public.categories set slug = 'Bad' where id = qa.id(1)$q$, 'categories_slug_format_check');
  perform qa.expect_check($q$update public.categories set slug = '1abc' where id = qa.id(1)$q$, 'categories_slug_format_check');
  perform qa.expect_check($q$update public.categories set slug = '' where id = qa.id(1)$q$, 'categories_slug_format_check');
  perform qa.expect_check($q$update public.categories set slug = 'a b' where id = qa.id(1)$q$, 'categories_slug_format_check');
  perform qa.expect_ok($q$update public.categories set slug = 'a_b-9' where id = qa.id(1)$q$, 'valid slug');
  perform qa.expect_check($q$update public.categories set label_ar = '  ' where id = qa.id(1)$q$, 'categories_label_ar_check');
  perform qa.expect_check($q$update public.categories set display_order = -1 where id = qa.id(1)$q$, 'categories_display_order_check');
  perform qa.expect_unique($q$insert into public.categories (slug, label_ar) values ('a_b-9', 'test')$q$, 'categories_slug_key');

  -- approved_source_rules
  perform qa.expect_check($q$update public.approved_source_rules set policy_version = '' where id = qa.id(2)$q$, 'approved_source_rules_policy_version_check');
  perform qa.expect_check($q$update public.approved_source_rules set domain_or_book_family = ' ' where id = qa.id(2)$q$, 'approved_source_rules_domain_or_book_family_check');
  perform qa.expect_check($q$update public.approved_source_rules set field = '' where id = qa.id(2)$q$, 'approved_source_rules_field_check');
  perform qa.expect_check($q$update public.approved_source_rules set eligibility_rule = '' where id = qa.id(2)$q$, 'approved_source_rules_eligibility_rule_check');
  perform qa.expect_check($q$update public.approved_source_rules set policy_reference = '' where id = qa.id(2)$q$, 'approved_source_rules_policy_reference_check');
  perform qa.expect_unique($q$insert into public.approved_source_rules (policy_version, domain_or_book_family, field, eligibility_rule, policy_reference)
    values ('test', 'test', 'test', 'other', 'other')$q$, 'approved_source_rules_natural_key');

  -- sources
  perform qa.expect_check($q$update public.sources set title = '' where id = qa.id(3)$q$, 'sources_title_check');
  perform qa.expect_check($q$update public.sources set provider = '' where id = qa.id(3)$q$, 'sources_provider_check');
  perform qa.expect_check($q$update public.sources set source_url = 'http://example.invalid' where id = qa.id(3)$q$, 'sources_source_url_check');
  perform qa.expect_check($q$update public.sources set license_url = 'http://example.invalid' where id = qa.id(3)$q$, 'sources_license_url_check');
  perform qa.expect_ok($q$update public.sources set license_url = 'https://example.invalid/license', approved_rule_id = null where id = qa.id(3)$q$, 'valid license_url, null rule');
  perform qa.expect_check($q$update public.sources set eligibility_record = '[]' where id = qa.id(3)$q$, 'sources_eligibility_record_check');
  perform qa.expect_check($q$update public.sources set license_record = '"x"' where id = qa.id(3)$q$, 'sources_license_record_check');

  -- books
  perform qa.expect_check($q$update public.books set title_ar = '' where id = qa.id(4)$q$, 'books_title_ar_check');
  perform qa.expect_check($q$update public.books set author = '' where id = qa.id(4)$q$, 'books_author_check');

  -- book_editions
  perform qa.expect_check($q$update public.book_editions set edition_key = 'ab' where id = qa.id(5)$q$, 'book_editions_edition_key_format_check');
  perform qa.expect_check($q$update public.book_editions set edition_key = 'Abc' where id = qa.id(5)$q$, 'book_editions_edition_key_format_check');
  perform qa.expect_check($q$update public.book_editions set edition_key = 'a_b' where id = qa.id(5)$q$, 'book_editions_edition_key_format_check');
  perform qa.expect_check($q$update public.book_editions set edition_key = repeat('a', 65) where id = qa.id(5)$q$, 'book_editions_edition_key_format_check');
  perform qa.expect_ok($q$update public.book_editions set edition_key = repeat('a', 64) where id = qa.id(5)$q$, '64-character edition_key');
  perform qa.expect_ok($q$update public.book_editions set edition_key = 'test-edition' where id = qa.id(5)$q$, 'restore edition_key');
  perform qa.expect_check($q$update public.book_editions set edition_label = '' where id = qa.id(5)$q$, 'book_editions_edition_label_check');
  perform qa.expect_check($q$update public.book_editions set language = 'AR' where id = qa.id(5)$q$, 'book_editions_language_check');
  perform qa.expect_check($q$update public.book_editions set language = 'a' where id = qa.id(5)$q$, 'book_editions_language_check');
  perform qa.expect_check($q$update public.book_editions set language = 'abcd' where id = qa.id(5)$q$, 'book_editions_language_check');
  perform qa.expect_ok($q$update public.book_editions set language = 'ara' where id = qa.id(5)$q$, 'three-letter language');
  perform qa.expect_check($q$update public.book_editions set version = 0 where id = qa.id(5)$q$, 'book_editions_version_check');
  perform qa.expect_check($q$update public.book_editions set bank_version = 0 where id = qa.id(5)$q$, 'book_editions_bank_version_check');
  perform qa.expect_check($q$update public.book_editions set raw_storage_path = 'other/raw/' where id = qa.id(5)$q$, 'book_editions_raw_storage_path_check');
  perform qa.expect_check($q$update public.book_editions set raw_storage_path = 'test-edition/raw' where id = qa.id(5)$q$, 'book_editions_raw_storage_path_check');
  perform qa.expect_ok($q$update public.book_editions set raw_storage_path = 'test-edition/raw/' where id = qa.id(5)$q$, 'valid raw_storage_path');
  perform qa.expect_check($q$update public.book_editions set content_hash = 'abc' where id = qa.id(5)$q$, 'book_editions_content_hash_check');
  perform qa.expect_check($q$update public.book_editions set content_hash = repeat('A', 64) where id = qa.id(5)$q$, 'book_editions_content_hash_check');
  perform qa.expect_check($q$update public.book_editions set content_hash = repeat('a', 63) where id = qa.id(5)$q$, 'book_editions_content_hash_check');
  perform qa.expect_ok($q$update public.book_editions set content_hash = repeat('f', 64) where id = qa.id(5)$q$, 'valid content_hash');
  perform qa.expect_ok($q$update public.book_editions set content_hash = null where id = qa.id(5)$q$, 'null content_hash while draft');
  perform qa.expect_check($q$update public.book_editions set pagination_record = '[]' where id = qa.id(5)$q$, 'book_editions_pagination_record_check');
  perform qa.expect_check($q$update public.book_editions set review_record = '[]' where id = qa.id(5)$q$, 'book_editions_review_record_check');
  -- a fingerprint is required once the edition leaves draft
  perform qa.expect_check($q$update public.book_editions set status = 'validated' where id = qa.id(5)$q$, 'book_editions_status_content_hash_check');
  -- published, superseded and revoked need the approval key in review_record
  perform qa.expect_check($q$update public.book_editions set status = 'published', content_hash = repeat('a', 64) where id = qa.id(5)$q$, 'book_editions_status_approval_check');
  perform qa.expect_check($q$update public.book_editions set status = 'superseded', content_hash = repeat('a', 64), review_record = '{"acquisition": {}}' where id = qa.id(5)$q$, 'book_editions_status_approval_check');
  perform qa.expect_check($q$update public.book_editions set status = 'revoked', content_hash = repeat('a', 64) where id = qa.id(5)$q$, 'book_editions_status_approval_check');
  perform qa.expect_ok($q$update public.book_editions set status = 'validated', content_hash = repeat('a', 64) where id = qa.id(5)$q$, 'validated without approval');
  perform qa.expect_ok($q$update public.book_editions set status = 'draft' where id = qa.id(5)$q$, 'back to draft');
  perform qa.expect_unique($q$insert into public.book_editions (id, book_id, source_id, edition_key, edition_label, language, version, bank_version)
    values (qa.id(105), qa.id(4), qa.id(3), 'other-key', 'test', 'ar', 1, 1)$q$, 'book_editions_book_id_version_key');
  perform qa.expect_unique($q$insert into public.book_editions (id, book_id, source_id, edition_key, edition_label, language, version, bank_version)
    values (qa.id(105), qa.id(4), qa.id(3), 'test-edition', 'test', 'ar', 2, 1)$q$, 'book_editions_edition_key_key');
  perform qa.expect_ok($q$insert into public.book_editions (id, book_id, source_id, edition_key, edition_label, language, version, bank_version)
    values (qa.id(105), qa.id(4), qa.id(3), 'test-edition-v2', 'test', 'ar', 2, 1)$q$, 'second version of the book');

  -- edition_pages
  perform qa.expect_check($q$insert into public.edition_pages (id, edition_id, page_hash) values (qa.id(106), qa.id(5), repeat('a', 64))$q$, 'edition_pages_page_present_check');
  perform qa.expect_check($q$update public.edition_pages set file_page_no = 0 where id = qa.id(6)$q$, 'edition_pages_file_page_no_check');
  perform qa.expect_check($q$update public.edition_pages set page_hash = 'xyz' where id = qa.id(6)$q$, 'edition_pages_page_hash_check');
  perform qa.expect_check($q$update public.edition_pages set validation_record = '[]' where id = qa.id(6)$q$, 'edition_pages_validation_record_check');
  perform qa.expect_unique($q$insert into public.edition_pages (id, edition_id, file_page_no, page_hash) values (qa.id(106), qa.id(5), 1, repeat('a', 64))$q$, 'edition_pages_edition_id_file_page_no_key');
  perform qa.expect_unique($q$insert into public.edition_pages (id, edition_id, printed_page_label, page_hash) values (qa.id(106), qa.id(5), '1', repeat('a', 64))$q$, 'edition_pages_edition_id_printed_page_label_key');
  perform qa.expect_ok($q$insert into public.edition_pages (id, edition_id, printed_page_label, page_hash) values (qa.id(106), qa.id(5), 'iv', repeat('a', 64))$q$, 'page with only a printed label');

  -- book_sections
  perform qa.expect_check($q$update public.book_sections set ordinal = 0 where id = qa.id(7)$q$, 'book_sections_ordinal_check');
  perform qa.expect_check($q$update public.book_sections set reference = '' where id = qa.id(7)$q$, 'book_sections_reference_check');
  perform qa.expect_check($q$update public.book_sections set title_ar = '' where id = qa.id(7)$q$, 'book_sections_title_ar_check');
  perform qa.expect_check($q$update public.book_sections set title_en = '' where id = qa.id(7)$q$, 'book_sections_title_en_check');
  perform qa.expect_check($q$update public.book_sections set source_url = 'http://example.invalid' where id = qa.id(7)$q$, 'book_sections_source_url_check');
  perform qa.expect_unique($q$insert into public.book_sections (id, edition_id, ordinal, kind, reference, title_ar, title_en)
    values (qa.id(107), qa.id(5), 1, 'surah', '2', 'test', 'Test 2')$q$, 'book_sections_edition_id_ordinal_key');
  perform qa.expect_ok($q$insert into public.book_sections (id, edition_id, parent_id, ordinal, kind, reference, title_ar, title_en)
    values (qa.id(107), qa.id(5), qa.id(7), 2, 'hadith', '2', 'test', 'Test 2')$q$, 'child section');

  -- units
  perform qa.expect_check($q$update public.units set ordinal = 0 where id = qa.id(8)$q$, 'units_ordinal_check');
  perform qa.expect_check($q$update public.units set reference = '' where id = qa.id(8)$q$, 'units_reference_check');
  perform qa.expect_check($q$update public.units set source_url = 'http://example.invalid' where id = qa.id(8)$q$, 'units_source_url_check');
  perform qa.expect_check($q$update public.units set canonical_text = '' where id = qa.id(8)$q$, 'units_canonical_text_check');
  perform qa.expect_check($q$update public.units set canonical_text = '   ' where id = qa.id(8)$q$, 'units_canonical_text_check');
  -- not NFC: e + combining acute accent; alef + combining maddah (composes to U+0622 in NFC)
  perform qa.expect_check(format('update public.units set canonical_text = %L where id = qa.id(8)', 'e' || chr(769)), 'units_canonical_text_check');
  perform qa.expect_check(format('update public.units set canonical_text = %L where id = qa.id(8)', chr(1575) || chr(1619)), 'units_canonical_text_check');
  perform qa.expect_ok(format('update public.units set canonical_text = %L where id = qa.id(8)', chr(1570)), 'NFC form is accepted');
  -- a zero-width non-joiner (U+200C) is preserved, not rejected
  perform qa.expect_ok(format('update public.units set canonical_text = %L where id = qa.id(8)', 'te' || chr(8204) || 'st'), 'zero-width character preserved');
  perform qa.expect_check($q$update public.units set char_start = 0 where id = qa.id(8)$q$, 'units_char_pair_check');
  perform qa.expect_check($q$update public.units set char_end = 4 where id = qa.id(8)$q$, 'units_char_pair_check');
  perform qa.expect_check($q$update public.units set char_start = 5, char_end = 4 where id = qa.id(8)$q$, 'units_char_range_check');
  perform qa.expect_check($q$update public.units set char_start = -1, char_end = 4 where id = qa.id(8)$q$, 'units_char_range_check');
  perform qa.expect_ok($q$update public.units set char_start = 0, char_end = 0 where id = qa.id(8)$q$, 'char_start = char_end');
  perform qa.expect_check($q$update public.units set token_spans = '{}' where id = qa.id(8)$q$, 'units_token_spans_check');
  perform qa.expect_check($q$update public.units set text_hash = 'abc' where id = qa.id(8)$q$, 'units_text_hash_check');
  -- hadith_meta: NULL for ayah, an object for every hadith unit (§6.1)
  perform qa.expect_check($q$update public.units set hadith_meta = '{}' where id = qa.id(8)$q$, 'units_hadith_meta_check');
  perform qa.expect_check($q$update public.units set hadith_meta = '[]' where id = qa.id(8)$q$, 'units_hadith_meta_check');
  perform qa.expect_check($q$update public.units set kind = 'hadith_narration', hadith_meta = null where id = qa.id(8)$q$, 'units_hadith_meta_check');
  perform qa.expect_check($q$update public.units set kind = 'hadith_takhrij', hadith_meta = null where id = qa.id(8)$q$, 'units_hadith_meta_check');
  perform qa.expect_check($q$update public.units set kind = 'hadith_grade', hadith_meta = null where id = qa.id(8)$q$, 'units_hadith_meta_check');
  perform qa.expect_check($q$update public.units set kind = 'hadith_narration', hadith_meta = '[]' where id = qa.id(8)$q$, 'units_hadith_meta_check');
  perform qa.expect_check($q$update public.units set kind = 'hadith_grade', hadith_meta = '"x"' where id = qa.id(8)$q$, 'units_hadith_meta_check');
  perform qa.expect_ok($q$update public.units set kind = 'hadith_narration', hadith_meta = '{"fortyNumber": 1}' where id = qa.id(8)$q$, 'hadith_narration with meta');
  perform qa.expect_ok($q$update public.units set kind = 'hadith_takhrij', hadith_meta = '{}' where id = qa.id(8)$q$, 'hadith_takhrij with meta');
  perform qa.expect_ok($q$update public.units set kind = 'hadith_grade', hadith_meta = '{"gradeRecorded": true}' where id = qa.id(8)$q$, 'hadith_grade with meta');
  perform qa.expect_ok($q$update public.units set kind = 'ayah', hadith_meta = null where id = qa.id(8)$q$, 'ayah with NULL hadith_meta');
  perform qa.expect_unique($q$insert into public.units (id, edition_id, section_id, ordinal, kind, reference, canonical_text, token_spans, text_hash)
    values (qa.id(108), qa.id(5), qa.id(7), 1, 'ayah', '1:2', 'test', '[]', repeat('b', 64))$q$, 'units_edition_id_ordinal_key');

  -- unit_page_spans
  perform qa.expect_check($q$update public.unit_page_spans set ordinal = 0 where unit_id = qa.id(8)$q$, 'unit_page_spans_ordinal_check');
  perform qa.expect_check($q$update public.unit_page_spans set start_offset = -1 where unit_id = qa.id(8)$q$, 'unit_page_spans_start_offset_check');
  perform qa.expect_check($q$update public.unit_page_spans set start_offset = 3, end_offset = 2 where unit_id = qa.id(8)$q$, 'unit_page_spans_end_offset_check');
  perform qa.expect_ok($q$update public.unit_page_spans set start_offset = 2, end_offset = 2 where unit_id = qa.id(8)$q$, 'end_offset = start_offset');

  -- passages
  perform qa.expect_check($q$update public.passages set bank_version = 0 where id = qa.id(9)$q$, 'passages_bank_version_check');
  perform qa.expect_check($q$update public.passages set ordinal = 0 where id = qa.id(9)$q$, 'passages_ordinal_check');
  perform qa.expect_check($q$update public.passages set start_ref = 'abc' where id = qa.id(9)$q$, 'passages_start_ref_check');
  perform qa.expect_check($q$update public.passages set start_ref = '1' where id = qa.id(9)$q$, 'passages_start_ref_check');
  perform qa.expect_check($q$update public.passages set start_ref = '1:' where id = qa.id(9)$q$, 'passages_start_ref_check');
  perform qa.expect_check($q$update public.passages set start_ref = ':1' where id = qa.id(9)$q$, 'passages_start_ref_check');
  perform qa.expect_check($q$update public.passages set start_ref = '1:a' where id = qa.id(9)$q$, 'passages_start_ref_check');
  perform qa.expect_check($q$update public.passages set start_ref = '1:0 ' where id = qa.id(9)$q$, 'passages_start_ref_check');
  perform qa.expect_check($q$update public.passages set end_ref = '1-2' where id = qa.id(9)$q$, 'passages_end_ref_check');
  perform qa.expect_ok($q$update public.passages set start_ref = '12:345', end_ref = '12:346' where id = qa.id(9)$q$, 'valid refs');
  perform qa.expect_check($q$update public.passages set word_count = 0 where id = qa.id(9)$q$, 'passages_word_count_check');
  perform qa.expect_check($q$update public.passages set reference = '' where id = qa.id(9)$q$, 'passages_reference_check');
  perform qa.expect_unique($q$insert into public.passages (id, edition_id, bank_version, section_id, ordinal, path, start_ref, end_ref, word_count, reference)
    values (qa.id(109), qa.id(5), 1, qa.id(7), 1, 'quran', '1:0', '1:0', 1, '1:1')$q$, 'passages_edition_id_bank_version_path_ordinal_key');
  perform qa.expect_ok($q$insert into public.passages (id, edition_id, bank_version, section_id, ordinal, path, start_ref, end_ref, word_count, reference)
    values (qa.id(109), qa.id(5), 1, qa.id(7), 1, 'matn', '1:0', '1:0', 1, '1:1')$q$, 'same ordinal on another path');
  perform qa.expect_ok($q$insert into public.passages (id, edition_id, bank_version, section_id, ordinal, path, start_ref, end_ref, word_count, reference)
    values (qa.id(110), qa.id(5), 2, qa.id(7), 1, 'quran', '1:0', '1:0', 1, '1:1')$q$, 'same ordinal in another bank version');

  -- passage_parts
  perform qa.expect_check($q$update public.passage_parts set ordinal = 0 where id = qa.id(10)$q$, 'passage_parts_ordinal_check');
  perform qa.expect_check($q$update public.passage_parts set start_ref = 'x' where id = qa.id(10)$q$, 'passage_parts_start_ref_check');
  perform qa.expect_check($q$update public.passage_parts set end_ref = '1:' where id = qa.id(10)$q$, 'passage_parts_end_ref_check');
  perform qa.expect_check($q$update public.passage_parts set word_count = 0 where id = qa.id(10)$q$, 'passage_parts_word_count_check');
  perform qa.expect_unique($q$insert into public.passage_parts (id, passage_id, edition_id, ordinal, start_ref, end_ref, word_count)
    values (qa.id(111), qa.id(9), qa.id(5), 1, '1:0', '1:0', 1)$q$, 'passage_parts_passage_id_ordinal_key');

  -- lessons
  perform qa.expect_check($q$update public.lessons set bank_version = 0 where id = qa.id(11)$q$, 'lessons_bank_version_check');
  perform qa.expect_check($q$update public.lessons set ordinal = 0 where id = qa.id(11)$q$, 'lessons_ordinal_check');
  perform qa.expect_check($q$update public.lessons set duration_estimate_sec = 0 where id = qa.id(11)$q$, 'lessons_duration_estimate_sec_check');
  perform qa.expect_check($q$update public.lessons set duration_estimate_sec = -5 where id = qa.id(11)$q$, 'lessons_duration_estimate_sec_check');
  perform qa.expect_unique($q$insert into public.lessons (id, edition_id, bank_version, passage_id, ordinal, duration_estimate_sec)
    values (qa.id(112), qa.id(5), 1, qa.id(9), 1, 60)$q$, 'lessons_edition_id_bank_version_ordinal_key');

  -- lesson_units
  perform qa.expect_check($q$update public.lesson_units set ordinal = 0 where lesson_id = qa.id(11)$q$, 'lesson_units_ordinal_check');
  perform qa.expect_check($q$update public.lesson_units set start_offset = -1 where lesson_id = qa.id(11)$q$, 'lesson_units_start_offset_check');
  perform qa.expect_check($q$update public.lesson_units set start_offset = 2, end_offset = 2 where lesson_id = qa.id(11)$q$, 'lesson_units_end_offset_check');

  -- question_items
  perform qa.expect_check($q$update public.question_items set bank_version = 0 where id = qa.id(12)$q$, 'question_items_bank_version_check');
  perform qa.expect_check($q$update public.question_items set covered_part_ids = '{}' where id = qa.id(12)$q$, 'question_items_covered_part_ids_check');
  perform qa.expect_check($q$update public.question_items set token_refs = '{}' where id = qa.id(12)$q$, 'question_items_token_refs_check');
  perform qa.expect_check($q$update public.question_items set option_refs = '{}' where id = qa.id(12)$q$, 'question_items_option_refs_check');
  perform qa.expect_check($q$update public.question_items set correct_ref = '"1:0"' where id = qa.id(12)$q$, 'question_items_correct_ref_check');
  perform qa.expect_check($q$update public.question_items set context_refs = '{}' where id = qa.id(12)$q$, 'question_items_context_refs_check');
  perform qa.expect_check($q$update public.question_items set reference = '' where id = qa.id(12)$q$, 'question_items_reference_check');
  perform qa.expect_check($q$update public.question_items set validation_record = '[]' where id = qa.id(12)$q$, 'question_items_validation_record_check');
  perform qa.expect_ok($q$update public.question_items set lesson_id = null where id = qa.id(12)$q$, 'lesson_id may be null');

  -- unit_embeddings
  perform qa.expect_check($q$update public.unit_embeddings set model = '' where unit_id = qa.id(8)$q$, 'unit_embeddings_model_check');
  perform qa.expect_check($q$update public.unit_embeddings set bank_version = 0 where unit_id = qa.id(8)$q$, 'unit_embeddings_bank_version_check');

  -- content_jobs
  perform qa.expect_check($q$update public.content_jobs set bank_version = 0 where id = qa.id(13)$q$, 'content_jobs_bank_version_check');
  perform qa.expect_check($q$update public.content_jobs set pipeline_version = '' where id = qa.id(13)$q$, 'content_jobs_pipeline_version_check');
  perform qa.expect_check($q$update public.content_jobs set published_at = now() where id = qa.id(13)$q$, 'content_jobs_published_at_check');
  perform qa.expect_check($q$update public.content_jobs set cursor = '[]' where id = qa.id(13)$q$, 'content_jobs_cursor_check');
  perform qa.expect_ok($q$update public.content_jobs set cursor = '{"next": 3}' where id = qa.id(13)$q$, 'cursor object');
  perform qa.expect_check($q$update public.content_jobs set validation_summary = '[]' where id = qa.id(13)$q$, 'content_jobs_validation_summary_check');
  perform qa.expect_ok($q$update public.content_jobs set validation_summary = '{"ok": true}' where id = qa.id(13)$q$, 'validation_summary object');
  perform qa.expect_unique($q$insert into public.content_jobs (edition_id, bank_version, pipeline_version, step)
    values (qa.id(5), 1, 'test', 'acquired')$q$, 'content_jobs_edition_id_bank_version_step_key');

  -- generic_plan_templates
  perform qa.expect_check($q$update public.generic_plan_templates set catalog_version = 0 where id = qa.id(14)$q$, 'generic_plan_templates_catalog_version_check');
  perform qa.expect_check($q$update public.generic_plan_templates set scenario_key = '' where id = qa.id(14)$q$, 'generic_plan_templates_scenario_key_check');
  perform qa.expect_check($q$update public.generic_plan_templates set policy_json = '[]' where id = qa.id(14)$q$, 'generic_plan_templates_policy_json_check');
  perform qa.expect_check($q$update public.generic_plan_templates set generator_version = '' where id = qa.id(14)$q$, 'generic_plan_templates_generator_version_check');
  perform qa.expect_unique($q$insert into public.generic_plan_templates (edition_id, catalog_version, scenario_key, policy_json, generator_version)
    values (qa.id(5), 1, 'test', '{}', 'test')$q$, 'generic_plan_templates_natural_key');
end;
$$;
rollback;

-- CHECK: 16 composite keys keep children inside one edition and bank version; RESTRICT protects catalog parents
begin;
select qa.make_fixture();
-- a second edition (version 2 of the same book) with its own section, page, unit, passage and lesson
insert into public.book_editions (id, book_id, source_id, edition_key, edition_label, language, version, bank_version)
values (qa.id(25), qa.id(4), qa.id(3), 'test-edition-2', 'test', 'ar', 2, 1);
insert into public.edition_pages (id, edition_id, printed_page_label, file_page_no, page_hash)
values (qa.id(26), qa.id(25), '1', 1, repeat('a', 64));
insert into public.book_sections (id, edition_id, ordinal, kind, reference, title_ar, title_en)
values (qa.id(27), qa.id(25), 1, 'surah', '1', 'test', 'Test 1');
insert into public.units (id, edition_id, section_id, ordinal, kind, reference, canonical_text, token_spans, text_hash)
values (qa.id(28), qa.id(25), qa.id(27), 1, 'ayah', '1:1', 'test', '[]', repeat('b', 64));
insert into public.passages (id, edition_id, bank_version, section_id, ordinal, path, start_ref, end_ref, word_count, reference)
values (qa.id(29), qa.id(25), 1, qa.id(27), 1, 'quran', '1:0', '1:0', 1, '1:1');
insert into public.lessons (id, edition_id, bank_version, passage_id, ordinal, duration_estimate_sec)
values (qa.id(31), qa.id(25), 1, qa.id(29), 1, 60);
-- a second bank version of the passage of edition 1
insert into public.passages (id, edition_id, bank_version, section_id, ordinal, path, start_ref, end_ref, word_count, reference)
values (qa.id(32), qa.id(5), 2, qa.id(7), 1, 'quran', '1:0', '1:0', 1, '1:1');
do $$
begin
  -- a child may not name a parent of another edition
  perform qa.expect_fk($q$insert into public.book_sections (id, edition_id, parent_id, ordinal, kind, reference, title_ar, title_en)
    values (qa.id(40), qa.id(25), qa.id(7), 2, 'hadith', '2', 'test', 'Test 2')$q$, 'book_sections_parent_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.units (id, edition_id, section_id, ordinal, kind, reference, canonical_text, token_spans, text_hash)
    values (qa.id(41), qa.id(25), qa.id(7), 2, 'ayah', '1:2', 'test', '[]', repeat('b', 64))$q$, 'units_section_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.passages (id, edition_id, bank_version, section_id, ordinal, path, start_ref, end_ref, word_count, reference)
    values (qa.id(42), qa.id(25), 1, qa.id(7), 2, 'quran', '1:0', '1:0', 1, '1:1')$q$, 'passages_section_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.unit_page_spans (unit_id, ordinal, edition_id, page_id, start_offset, end_offset)
    values (qa.id(28), 1, qa.id(25), qa.id(6), 0, 1)$q$, 'unit_page_spans_page_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.unit_page_spans (unit_id, ordinal, edition_id, page_id, start_offset, end_offset)
    values (qa.id(8), 2, qa.id(25), qa.id(26), 0, 1)$q$, 'unit_page_spans_unit_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.passage_parts (id, passage_id, edition_id, ordinal, start_ref, end_ref, word_count)
    values (qa.id(43), qa.id(9), qa.id(25), 2, '1:0', '1:0', 1)$q$, 'passage_parts_passage_id_edition_id_fkey');
  -- a lesson or question belongs to a passage of its own edition and bank version
  perform qa.expect_fk($q$insert into public.lessons (id, edition_id, bank_version, passage_id, ordinal, duration_estimate_sec)
    values (qa.id(44), qa.id(5), 2, qa.id(9), 2, 60)$q$, 'lessons_passage_id_edition_id_bank_version_fkey');
  perform qa.expect_fk($q$insert into public.lessons (id, edition_id, bank_version, passage_id, ordinal, duration_estimate_sec)
    values (qa.id(45), qa.id(25), 1, qa.id(9), 2, 60)$q$, 'lessons_passage_id_edition_id_bank_version_fkey');
  perform qa.expect_fk($q$insert into public.lesson_units (lesson_id, ordinal, edition_id, unit_id, start_offset, end_offset)
    values (qa.id(11), 2, qa.id(5), qa.id(28), 0, 1)$q$, 'lesson_units_unit_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.lesson_units (lesson_id, ordinal, edition_id, unit_id, start_offset, end_offset)
    values (qa.id(31), 2, qa.id(5), qa.id(8), 0, 1)$q$, 'lesson_units_lesson_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.question_items (id, edition_id, bank_version, passage_id, lesson_id, unit_id, type, covered_part_ids, token_refs, correct_ref, reference)
    values (qa.id(46), qa.id(5), 2, qa.id(9), null, qa.id(8), 'word_order', array[qa.id(10)], '[]', '[]', '1:1')$q$, 'question_items_passage_id_edition_id_bank_version_fkey');
  perform qa.expect_fk($q$insert into public.question_items (id, edition_id, bank_version, passage_id, lesson_id, unit_id, type, covered_part_ids, token_refs, correct_ref, reference)
    values (qa.id(47), qa.id(5), 1, qa.id(9), qa.id(31), qa.id(8), 'word_order', array[qa.id(10)], '[]', '[]', '1:1')$q$, 'question_items_lesson_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.question_items (id, edition_id, bank_version, passage_id, lesson_id, unit_id, type, covered_part_ids, token_refs, correct_ref, reference)
    values (qa.id(48), qa.id(5), 1, qa.id(9), null, qa.id(28), 'word_order', array[qa.id(10)], '[]', '[]', '1:1')$q$, 'question_items_unit_id_edition_id_fkey');
  perform qa.expect_ok($q$insert into public.question_items (id, edition_id, bank_version, passage_id, lesson_id, unit_id, type, covered_part_ids, token_refs, correct_ref, reference)
    values (qa.id(49), qa.id(5), 1, qa.id(9), null, qa.id(8), 'word_order', array[qa.id(10)], '[]', '[]', '1:1')$q$, 'question without lesson (nullable composite key)');
  perform qa.expect_fk($q$insert into public.unit_embeddings (unit_id, bank_version, model, edition_id, embedding)
    values (qa.id(8), 1, 'test-other', qa.id(25), array_fill(0.1::real, array[384])::extensions.vector(384))$q$, 'unit_embeddings_unit_id_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.content_jobs (edition_id, bank_version, pipeline_version, step)
    values (qa.id(99), 1, 'test', 'verified')$q$, 'content_jobs_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.generic_plan_templates (edition_id, catalog_version, scenario_key, policy_json, generator_version)
    values (qa.id(99), 1, 'test', '{}', 'test')$q$, 'generic_plan_templates_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.edition_pages (id, edition_id, file_page_no, page_hash)
    values (qa.id(50), qa.id(99), 9, repeat('a', 64))$q$, 'edition_pages_edition_id_fkey');
  perform qa.expect_fk($q$insert into public.book_sections (id, edition_id, ordinal, kind, reference, title_ar, title_en)
    values (qa.id(51), qa.id(99), 9, 'surah', '9', 'test', 'Test 9')$q$, 'book_sections_edition_id_fkey');
  -- catalog parents must exist
  perform qa.expect_fk($q$insert into public.sources (id, approved_rule_id, title, provider, source_url, rights_status)
    values (qa.id(52), qa.id(99), 'test', 'test', 'https://example.invalid/x', 'verified')$q$, 'sources_approved_rule_id_fkey');
  perform qa.expect_fk($q$insert into public.books (id, category_id, title_ar, author, content_format)
    values (qa.id(53), qa.id(99), 'test', 'test', 'quran')$q$, 'books_category_id_fkey');
  perform qa.expect_fk($q$insert into public.book_editions (id, book_id, source_id, edition_key, edition_label, language, version, bank_version)
    values (qa.id(54), qa.id(99), qa.id(3), 'test-edition-x', 'test', 'ar', 1, 1)$q$, 'book_editions_book_id_fkey');
  perform qa.expect_fk($q$insert into public.book_editions (id, book_id, source_id, edition_key, edition_label, language, version, bank_version)
    values (qa.id(55), qa.id(4), qa.id(99), 'test-edition-y', 'test', 'ar', 3, 1)$q$, 'book_editions_source_id_fkey');
  -- class E: catalog parents cannot be deleted while referenced
  perform qa.expect_fk($q$delete from public.categories where id = qa.id(1)$q$, 'books_category_id_fkey');
  perform qa.expect_fk($q$delete from public.approved_source_rules where id = qa.id(2)$q$, 'sources_approved_rule_id_fkey');
  perform qa.expect_fk($q$delete from public.sources where id = qa.id(3)$q$, 'book_editions_source_id_fkey');
  perform qa.expect_fk($q$delete from public.books where id = qa.id(4)$q$, 'book_editions_book_id_fkey');
end;
$$;
rollback;

-- CHECK: 17 trigger set_updated_at refreshes updated_at on the five tables that carry it
begin;
select qa.make_fixture();
do $$
declare
  r record;
  v_ok boolean;
begin
  -- an explicit old value in the SET list is overwritten by the trigger (now() is the transaction start)
  for r in
    select * from (values
      ('categories', 'label_ar', 'qa.id(1)'),
      ('sources', 'title', 'qa.id(3)'),
      ('books', 'title_ar', 'qa.id(4)'),
      ('book_editions', 'edition_label', 'qa.id(5)'),
      ('content_jobs', 'pipeline_version', 'qa.id(13)')
    ) as v(tbl, col, id_expr)
  loop
    execute format($q$update public.%I set %I = 'test-2', updated_at = timestamptz '2000-01-01 00:00:00+00' where id = %s$q$,
                   r.tbl, r.col, r.id_expr);
    execute format('select updated_at = now() from public.%I where id = %s', r.tbl, r.id_expr) into strict v_ok;
    if not v_ok then
      raise exception 'updated_at of % was not refreshed by the trigger', r.tbl;
    end if;
  end loop;
end;
$$;
rollback;

-- CHECK: 18 guard_edition_delete: only a never-published draft edition can be deleted; its subtree goes with it
begin;
select qa.make_fixture();
do $$
declare
  v text;
  v_left integer;
begin
  -- every non-draft status is blocked
  foreach v in array array['validated', 'published', 'superseded', 'revoked'] loop
    perform qa.set_edition_status(v);
    perform qa.expect_restrict($q$delete from public.book_editions where id = qa.id(5)$q$, 'delete ' || v || ' edition');
  end loop;
  if (select count(*) from public.book_editions where id = qa.id(5)) <> 1 then
    raise exception 'a blocked delete removed the edition';
  end if;

  -- a draft edition with a published job step is blocked too
  update public.book_editions set status = 'draft' where id = qa.id(5);
  insert into public.content_jobs (edition_id, bank_version, pipeline_version, step, status, published_at)
  values (qa.id(5), 1, 'test', 'published', 'failed', null);
  perform qa.expect_restrict($q$delete from public.book_editions where id = qa.id(5)$q$, 'delete draft edition with a published step');

  -- a draft edition without a published step is deleted with its whole subtree; catalog parents stay
  delete from public.content_jobs where step = 'published';
  delete from public.book_editions where id = qa.id(5);
  select
    (select count(*) from public.edition_pages)
  + (select count(*) from public.book_sections)
  + (select count(*) from public.units)
  + (select count(*) from public.unit_page_spans)
  + (select count(*) from public.passages)
  + (select count(*) from public.passage_parts)
  + (select count(*) from public.lessons)
  + (select count(*) from public.lesson_units)
  + (select count(*) from public.question_items)
  + (select count(*) from public.unit_embeddings)
  + (select count(*) from public.content_jobs)
  + (select count(*) from public.generic_plan_templates)
  into v_left;
  if v_left <> 0 then
    raise exception '% subtree rows remain after deleting the draft edition', v_left;
  end if;
  if (select count(*) from public.books) <> 1
     or (select count(*) from public.sources) <> 1
     or (select count(*) from public.categories) <> 1
     or (select count(*) from public.approved_source_rules) <> 1 then
    raise exception 'catalog parents were removed together with the edition';
  end if;
end;
$$;
rollback;

-- CHECK: 19 guard_unit_text: text, token_spans and text_hash are frozen once the edition leaves draft
begin;
select qa.make_fixture();
do $$
declare
  v text;
begin
  -- draft: all three columns may change
  perform qa.expect_ok($q$update public.units set canonical_text = 'test-2', text_hash = repeat('d', 64),
    token_spans = '[{"i":0,"s":0,"e":6,"k":"word","n":"test-2"}]' where id = qa.id(8)$q$, 'draft edition: text may change');

  foreach v in array array['validated', 'published', 'superseded', 'revoked'] loop
    perform qa.set_edition_status(v);
    perform qa.expect_restrict($q$update public.units set canonical_text = 'changed' where id = qa.id(8)$q$, v || ': canonical_text');
    perform qa.expect_restrict($q$update public.units set token_spans = '[]' where id = qa.id(8)$q$, v || ': token_spans');
    perform qa.expect_restrict($q$update public.units set text_hash = repeat('e', 64) where id = qa.id(8)$q$, v || ': text_hash');
    -- other columns and an unchanged text stay writable
    perform qa.expect_ok($q$update public.units set reference = '1:1', source_url = 'https://example.invalid/unit' where id = qa.id(8)$q$, v || ': other columns');
    perform qa.expect_ok($q$update public.units set canonical_text = canonical_text, token_spans = token_spans, text_hash = text_hash where id = qa.id(8)$q$, v || ': unchanged text');
  end loop;
end;
$$;
rollback;

-- CHECK: 20 API roles act as the grants say: anon and authenticated are denied, service_role publishes (triggers fire although private is locked)
begin;
select qa.make_fixture();
set local role anon;
do $$
declare
  t text;
begin
  foreach t in array qa.content_tables() loop
    perform qa.expect_error(format('select 1 from public.%I limit 1', t), '42501', 'anon select ' || t);
    perform qa.expect_error(format('insert into public.%I default values', t), '42501', 'anon insert ' || t);
  end loop;
end;
$$;
reset role;
set local role authenticated;
do $$
declare
  t text;
begin
  foreach t in array qa.content_tables() loop
    perform qa.expect_error(format('select 1 from public.%I limit 1', t), '42501', 'authenticated select ' || t);
    perform qa.expect_error(format('insert into public.%I default values', t), '42501', 'authenticated insert ' || t);
    perform qa.expect_error(format('delete from public.%I', t), '42501', 'authenticated delete ' || t);
  end loop;
end;
$$;
reset role;
set local role service_role;
do $$
begin
  perform qa.expect_ok($q$insert into public.categories (slug, label_ar) values ('service-role-test', 'test')$q$, 'service_role insert');
  perform qa.expect_ok($q$update public.categories set label_ar = 'test-2' where slug = 'service-role-test'$q$, 'service_role update (trigger fires)');
  perform qa.expect_ok($q$update public.units set canonical_text = canonical_text || 'x' where id = qa.id(8)$q$, 'service_role text change on a draft edition');
  perform qa.set_edition_status('published');
  perform qa.expect_restrict($q$update public.units set canonical_text = canonical_text || 'y' where id = qa.id(8)$q$, 'service_role text change on a published edition');
  perform qa.expect_restrict($q$delete from public.book_editions where id = qa.id(5)$q$, 'service_role delete of a published edition');
  perform qa.expect_ok($q$delete from public.categories where slug = 'service-role-test'$q$, 'service_role delete');
end;
$$;
reset role;
rollback;

-- CHECK: 21 no seed rows: all 17 tables are empty and the only bucket is sources
do $$
declare
  t text;
  n bigint;
begin
  foreach t in array qa.content_tables() loop
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then
      raise exception 'public.% holds % rows after the migration', t, n;
    end if;
  end loop;
  if (select count(*) from storage.buckets where id <> 'sources') <> 0 then
    raise exception 'unexpected buckets exist';
  end if;
  if (select count(*) from storage.objects) <> 0 then
    raise exception 'unexpected storage objects exist';
  end if;
end;
$$;
