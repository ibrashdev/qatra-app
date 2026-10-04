-- 0004_progress
--
-- Progress boundary: daily_progress, daily_completions, target_mastery,
-- target_part_evidence and ai_usage. There is NO `reviews` table: the review ladder of
-- D66 lives in target_mastery and its evidence in target_part_evidence; due reviews are
-- derived from target_mastery.next_review_due (Database-schema.md §3.4, directive 3).
--
-- Source: docs/Database-schema.md v1.1 (approved by the owner, D74, 4 October 2026):
-- §3.3 learning ERD, §3.4, §4 conventions, §6.3 learning tables, §11 migration plan
-- `0004_progress`.
--
-- Scope notes
--   * Every table enables row level security (not forced) and revokes every privilege of
--     `anon`, `authenticated` and `service_role`. Policies, column grants and the `app_*`
--     commit functions arrive in `0005_rls_functions` (§11).
--   * `ai_usage` has no learner, account, plan or free-text column (D17); it is written
--     only through `srv_record_ai_usage` (0005).
--   * No seed rows. Nothing here is applied to any Supabase project by this file's
--     existence.

-- ---------------------------------------------------------------------------
-- 1. Tables, in dependency order (§11 item 1)
-- ---------------------------------------------------------------------------

-- 1.1 daily_progress --------------------------------------------------------

create table public.daily_progress (
  user_id       uuid        not null,
  learning_date date        not null,
  active_ms     bigint      not null default 0,
  goal_ms       bigint      not null,
  updated_at    timestamptz not null default now(),
  constraint daily_progress_pkey primary key (user_id, learning_date),
  constraint daily_progress_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint daily_progress_active_ms_check check (active_ms >= 0),
  constraint daily_progress_goal_ms_check check (goal_ms > 0)
);
comment on table public.daily_progress is 'Validated active time per account and learning date; the union of server-validated intervals, never the client''s figure (D40).';

create trigger daily_progress_set_updated_at
  before update on public.daily_progress
  for each row execute function private.set_updated_at();

alter table public.daily_progress enable row level security;
revoke all on table public.daily_progress from anon, authenticated, service_role;

-- 1.2 daily_completions -----------------------------------------------------

create table public.daily_completions (
  user_id            uuid        not null,
  learning_date      date        not null,
  reached_in_plan_id uuid        not null,
  completed_at       timestamptz not null default now(),
  constraint daily_completions_pkey primary key (user_id, learning_date),
  constraint daily_completions_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint daily_completions_reached_in_plan_id_user_id_fkey
    foreign key (reached_in_plan_id, user_id)
    references public.master_plans (id, user_id) on delete cascade
);
comment on table public.daily_completions is 'One completion per account and learning date, written once when validated active time reaches the goal (D40).';

create index daily_completions_reached_in_plan_id_idx on public.daily_completions (reached_in_plan_id);

alter table public.daily_completions enable row level security;
revoke all on table public.daily_completions from anon, authenticated, service_role;

-- 1.3 target_mastery --------------------------------------------------------

create table public.target_mastery (
  user_id               uuid        not null,
  plan_id               uuid        not null,
  passage_id            uuid        not null,
  edition_id            uuid        not null,
  status                text        not null default 'new',
  consecutive_correct   integer     not null default 0,
  initial_success_at    timestamptz,
  initial_learning_date date,
  review_stage          smallint    not null default 0,
  next_review_due       date,
  last_review_date      date,
  confirmed_at          timestamptz,
  first_confirmed_at    timestamptz,
  maintenance_stage     smallint    not null default 0,
  lapse_count           integer     not null default 0,
  error_part_ids        uuid[]      not null default '{}',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint target_mastery_pkey primary key (user_id, plan_id, passage_id),
  constraint target_mastery_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint target_mastery_plan_id_user_id_edition_id_fkey
    foreign key (plan_id, user_id, edition_id)
    references public.master_plans (id, user_id, edition_id) on delete cascade,
  -- class C: personal row to published content
  constraint target_mastery_passage_id_edition_id_fkey
    foreign key (passage_id, edition_id)
    references public.passages (id, edition_id) on delete restrict,
  constraint target_mastery_status_check
    check (status in ('new', 'learning', 'reviewing', 'confirmed', 'needs_refresh')),
  constraint target_mastery_consecutive_correct_check check (consecutive_correct >= 0),
  constraint target_mastery_review_stage_check check (review_stage between 0 and 3),
  constraint target_mastery_maintenance_stage_check check (maintenance_stage >= 0),
  constraint target_mastery_lapse_count_check check (lapse_count >= 0),
  -- State consistency from contract §4; the transitions themselves belong to the domain policy.
  -- confirmed exactly when a current confirmation exists
  constraint target_mastery_confirmed_state_check
    check ((status = 'confirmed') = (confirmed_at is not null)),
  -- a current confirmation implies a first confirmation (kept after a lapse)
  constraint target_mastery_first_confirmed_check
    check (confirmed_at is null or first_confirmed_at is not null),
  -- a refresh is only needed after a confirmation
  constraint target_mastery_needs_refresh_check
    check (status <> 'needs_refresh' or first_confirmed_at is not null),
  -- reviewing and needs_refresh sit on the ladder (stage 1 to 3); next_review_due is
  -- deliberately not constrained (what stage 3 schedules before full coverage is not stated)
  constraint target_mastery_ladder_stage_check
    check (status not in ('reviewing', 'needs_refresh') or review_stage between 1 and 3),
  -- initial success and its learning date are set together
  constraint target_mastery_initial_pair_check
    check ((initial_success_at is null) = (initial_learning_date is null)),
  -- reviewing, confirmed and needs_refresh need the initial evidence
  constraint target_mastery_initial_evidence_check
    check (status not in ('reviewing', 'confirmed', 'needs_refresh') or initial_success_at is not null)
);
comment on table public.target_mastery is 'Memorization state per account, plan and passage; carries the review ladder in place of the dropped reviews table (D41, D56, D64, D66).';

-- due and overdue reviews (replaces the dropped reviews (user_id, due_at) index)
create index target_mastery_user_id_plan_id_next_review_due_idx
  on public.target_mastery (user_id, plan_id, next_review_due)
  where next_review_due is not null;
-- foreign-key support
create index target_mastery_passage_id_idx on public.target_mastery (passage_id);

create trigger target_mastery_set_updated_at
  before update on public.target_mastery
  for each row execute function private.set_updated_at();

alter table public.target_mastery enable row level security;
revoke all on table public.target_mastery from anon, authenticated, service_role;

-- 1.4 target_part_evidence --------------------------------------------------

create table public.target_part_evidence (
  user_id       uuid        not null,
  plan_id       uuid        not null,
  passage_id    uuid        not null,
  part_id       uuid        not null,
  attempt_id    uuid        not null,
  learning_date date        not null,
  created_at    timestamptz not null default now(),
  -- a part is covered once per plan (contract §3.2)
  constraint target_part_evidence_pkey primary key (user_id, plan_id, part_id),
  constraint target_part_evidence_user_id_fkey
    foreign key (user_id) references auth.users (id) on delete cascade,
  constraint target_part_evidence_user_id_plan_id_passage_id_fkey
    foreign key (user_id, plan_id, passage_id)
    references public.target_mastery (user_id, plan_id, passage_id) on delete cascade,
  -- class C: personal row to published content
  constraint target_part_evidence_part_id_passage_id_fkey
    foreign key (part_id, passage_id)
    references public.passage_parts (id, passage_id) on delete restrict,
  constraint target_part_evidence_attempt_id_user_id_passage_id_fkey
    foreign key (attempt_id, user_id, passage_id)
    references public.attempts (id, user_id, passage_id) on delete cascade
);
comment on table public.target_part_evidence is 'Coverage evidence: a part is covered by a correct, unassisted answer to a question that tests it; displayed context is not coverage (D64, D66).';

create index target_part_evidence_user_id_plan_id_passage_id_idx
  on public.target_part_evidence (user_id, plan_id, passage_id);
create index target_part_evidence_attempt_id_idx on public.target_part_evidence (attempt_id);

alter table public.target_part_evidence enable row level security;
revoke all on table public.target_part_evidence from anon, authenticated, service_role;

-- 1.5 ai_usage --------------------------------------------------------------

create table public.ai_usage (
  id             uuid        not null default gen_random_uuid(),
  provider       text        not null,
  model          text        not null,
  prompt_version text        not null,
  input_tokens   integer,
  output_tokens  integer,
  cost_usd       numeric,
  status         text        not null,
  quota_record   jsonb,
  created_at     timestamptz not null default now(),
  constraint ai_usage_pkey primary key (id),
  constraint ai_usage_provider_check check (btrim(provider) <> ''),
  constraint ai_usage_model_check check (btrim(model) <> ''),
  constraint ai_usage_prompt_version_check check (btrim(prompt_version) <> ''),
  -- NULL means unknown, never zero unless measured
  constraint ai_usage_input_tokens_check check (input_tokens is null or input_tokens >= 0),
  constraint ai_usage_output_tokens_check check (output_tokens is null or output_tokens >= 0),
  constraint ai_usage_cost_usd_check check (cost_usd is null or cost_usd >= 0),
  constraint ai_usage_status_check
    check (status in ('succeeded', 'failed', 'timed_out', 'rules_fallback')),
  constraint ai_usage_quota_record_check
    check (quota_record is null or jsonb_typeof(quota_record) = 'object')
);
comment on table public.ai_usage is 'One record per model call (D39, D60); no learner, account, plan or free text is stored (D17), so it sits outside the account-deletion cascade.';

create index ai_usage_created_at_idx on public.ai_usage (created_at);

alter table public.ai_usage enable row level security;
revoke all on table public.ai_usage from anon, authenticated, service_role;
