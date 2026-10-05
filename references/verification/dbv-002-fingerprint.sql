-- DBV-002 catalog fingerprint (read-only). Scope: schemas public and private.
-- Run with: psql -X -At -d <db> -f dbv-002-fingerprint.sql
set search_path = pg_catalog;
with
fn as (
  select format('%s.%s(%s)|%s|%s|%s|%s|%s|%s|%s|%s|md5=%s', n.nspname, p.proname,
    pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid), p.prokind,
    p.prosecdef, p.provolatile, p.proleakproof, coalesce(p.proconfig::text,''),
    pg_get_userbyid(p.proowner), coalesce(p.proacl::text,''), md5(p.prosrc)) as x
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','private') and not exists (select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')),
col as (
  select format('%s.%s.%s|%s|%s|%s|%s|%s|%s', n.nspname, c.relname, a.attname,
    pg_catalog.format_type(a.atttypid,a.atttypmod), a.attnotnull, coalesce(pg_get_expr(d.adbin,d.adrelid),''),
    a.attidentity, a.attgenerated, a.attnum) as x
  from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where n.nspname in ('public','private') and c.relkind in ('r','p','v','m','f') and a.attnum>0 and not a.attisdropped),
con as (
  select format('%s.%s|%s|%s|%s', n.nspname, c.relname, k.conname, k.contype, pg_get_constraintdef(k.oid)) as x
  from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private')),
idx as (
  select format('%s.%s|%s|%s', schemaname, tablename, indexname, indexdef) as x
  from pg_indexes where schemaname in ('public','private')),
pol as (
  select format('%s.%s|%s|%s|%s|%s|%s|%s', schemaname, tablename, policyname, permissive, roles::text, cmd,
    coalesce(qual,''), coalesce(with_check,'')) as x
  from pg_policies where schemaname in ('public','private')
  union all
  select format('RLS %s.%s|enabled=%s|forced=%s', n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity)
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private') and c.relkind in ('r','p')),
gr as (
  select format('REL %s.%s|%s|%s|%s|%s', n.nspname, c.relname, c.relkind,
    case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end, x.privilege_type, x.is_grantable) as x
  from pg_class c join pg_namespace n on n.oid=c.relnamespace, aclexplode(c.relacl) x
  where n.nspname in ('public','private') and c.relkind in ('r','p','v','m','S','f')
  union all
  select format('COL %s.%s.%s|%s|%s|%s', n.nspname, c.relname, a.attname,
    case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end, x.privilege_type, x.is_grantable)
  from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace, aclexplode(a.attacl) x
  where n.nspname in ('public','private') and a.attacl is not null
  union all
  select format('FN %s.%s(%s)|%s|%s|%s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid),
    case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end, x.privilege_type, x.is_grantable)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace, aclexplode(p.proacl) x
  where n.nspname in ('public','private')
  union all
  select format('SCHEMA %s|%s|%s|%s', n.nspname, case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end,
    x.privilege_type, x.is_grantable)
  from pg_namespace n, aclexplode(n.nspacl) x where n.nspname in ('public','private')
  union all
  select format('DEFACL %s|%s|%s|%s', coalesce(n.nspname,'*'), pg_get_userbyid(d.defaclrole), d.defaclobjtype,
    d.defaclacl::text)
  from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace),
vw as (
  select format('%s.%s|%s|%s|%s', n.nspname, c.relname, c.relkind, coalesce(c.reloptions::text,''), pg_get_viewdef(c.oid,true)) as x
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private') and c.relkind in ('v','m')),
trg as (
  select format('%s.%s|%s|%s', n.nspname, c.relname, t.tgname, pg_get_triggerdef(t.oid,true)) as x
  from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in ('public','private') and not t.tgisinternal),
all_cat as (
  select 'functions' cat, x from fn union all select 'columns', x from col union all
  select 'constraints', x from con union all select 'indexes', x from idx union all
  select 'policies', x from pol union all select 'grants', x from gr union all
  select 'views', x from vw union all select 'triggers', x from trg)
select * from (
select cat, count(*) as n, md5(string_agg(x, E'\n' order by x collate "C")) as digest
from all_cat group by cat
union all
select 'ALL', count(*), md5(string_agg(cat||'|'||x, E'\n' order by cat collate "C", x collate "C")) from all_cat
) t order by cat collate "C";
