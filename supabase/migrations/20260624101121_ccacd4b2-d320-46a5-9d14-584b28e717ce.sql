
-- Extensions
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ============ lineups: status / source / timestamps ============
alter table public.lineups
  add column if not exists lineup_status text not null default 'projected',
  add column if not exists lineup_source text not null default 'mlb',
  add column if not exists imported_at timestamptz not null default now(),
  add column if not exists confirmed_at timestamptz null;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'lineups_lineup_status_check'
  ) then
    alter table public.lineups
      add constraint lineups_lineup_status_check
      check (lineup_status in ('projected','confirmed','locked'));
  end if;
end $$;

-- Backfill from legacy `confirmed` boolean
update public.lineups
   set lineup_status = case
         when locked_at is not null then 'locked'
         when confirmed = true then 'confirmed'
         else 'projected'
       end,
       confirmed_at = case when confirmed = true and confirmed_at is null then updated_at else confirmed_at end
 where lineup_status = 'projected' and (confirmed = true or locked_at is not null);

create index if not exists lineups_status_idx on public.lineups (lineup_status);

-- ============ games: lineups_locked_at ============
alter table public.games
  add column if not exists lineups_locked_at timestamptz null;

-- ============ projections: status / source / confidence ============
alter table public.projections
  add column if not exists lineup_status text default 'projected',
  add column if not exists lineup_source text null,
  add column if not exists lineup_confidence smallint null,
  add column if not exists projection_status text not null default 'active';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'projections_projection_status_check'
  ) then
    alter table public.projections
      add constraint projections_projection_status_check
      check (projection_status in ('active','superseded'));
  end if;
end $$;

create index if not exists projections_active_idx
  on public.projections (game_id, projection_status, created_at desc);

-- ============ lineup_sources ============
create table if not exists public.lineup_sources (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  source text not null,
  payload jsonb not null,
  content_hash text not null,
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, team_id, source)
);

grant select on public.lineup_sources to anon, authenticated;
grant all on public.lineup_sources to service_role;

alter table public.lineup_sources enable row level security;

create policy "Lineup sources are public"
  on public.lineup_sources for select
  to anon, authenticated
  using (true);

create policy "Admins write lineup sources"
  on public.lineup_sources for all
  to authenticated
  using (has_role(auth.uid(), 'admin'::app_role))
  with check (has_role(auth.uid(), 'admin'::app_role));

create trigger lineup_sources_touch
  before update on public.lineup_sources
  for each row execute function public.touch_updated_at();

create index if not exists lineup_sources_game_idx on public.lineup_sources (game_id);

-- ============ game_lineup_status ============
create table if not exists public.game_lineup_status (
  game_id uuid primary key references public.games(id) on delete cascade,
  status text not null default 'projected',
  confidence smallint not null default 0,
  primary_source text null,
  source_count smallint not null default 0,
  hitters_set smallint not null default 0,
  hitters_expected smallint not null default 18,
  last_refresh_at timestamptz not null default now(),
  notes jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint game_lineup_status_status_check
    check (status in ('projected','confirmed','locked'))
);

grant select on public.game_lineup_status to anon, authenticated;
grant all on public.game_lineup_status to service_role;

alter table public.game_lineup_status enable row level security;

create policy "Game lineup status is public"
  on public.game_lineup_status for select
  to anon, authenticated
  using (true);

create policy "Admins write game lineup status"
  on public.game_lineup_status for all
  to authenticated
  using (has_role(auth.uid(), 'admin'::app_role))
  with check (has_role(auth.uid(), 'admin'::app_role));

create trigger game_lineup_status_touch
  before update on public.game_lineup_status
  for each row execute function public.touch_updated_at();

-- ============ cron_runs ============
create table if not exists public.cron_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  duration_ms integer null,
  date text null,
  providers jsonb not null default '{}'::jsonb,
  games_changed integer not null default 0,
  players_changed integer not null default 0,
  projections_regenerated integer not null default 0,
  affected_game_ids uuid[] not null default '{}'::uuid[],
  engine_ran boolean not null default false,
  error text null,
  notes text null,
  created_at timestamptz not null default now()
);

grant select on public.cron_runs to anon, authenticated;
grant all on public.cron_runs to service_role;

alter table public.cron_runs enable row level security;

create policy "Cron runs are public"
  on public.cron_runs for select
  to anon, authenticated
  using (true);

create policy "Admins write cron runs"
  on public.cron_runs for all
  to authenticated
  using (has_role(auth.uid(), 'admin'::app_role))
  with check (has_role(auth.uid(), 'admin'::app_role));

create index if not exists cron_runs_started_idx on public.cron_runs (started_at desc);
