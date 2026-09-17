alter table public.dylan_heartbeat_runs
  add column if not exists model_decided_at timestamptz;

update public.dylan_heartbeat_runs
set model_decided_at = coalesce(finished_at, started_at)
where model_decided_at is null
  and status in ('pushed', 'no_action');

create index if not exists dylan_heartbeat_runs_model_decided_at_idx
  on public.dylan_heartbeat_runs (model_decided_at desc)
  where model_decided_at is not null;

update public.dylan_heartbeat_settings
set
  attention_window_start_minute = 1140,
  attention_window_end_minute = 120,
  attention_wake_after_minutes = 45,
  off_hours_wake_after_minutes = 240,
  attention_check_interval_minutes = 30,
  off_hours_check_interval_minutes = 120,
  min_push_gap_minutes = 0,
  updated_at = now()
where id = true;

comment on table public.dylan_heartbeat_settings is
  'Editable non-secret settings for the Dylan Heartbeat Edge Function. The check interval columns control successful model-decision cooldowns.';
