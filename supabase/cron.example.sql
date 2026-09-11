-- Run this in Supabase SQL Editor after deploying the heartbeat Edge Function.
-- Replace all three placeholder values before running.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

select vault.create_secret(
  'https://YOUR_PROJECT_REF.supabase.co',
  'dylan_project_url'
);

select vault.create_secret(
  'YOUR_SUPABASE_ANON_KEY',
  'dylan_anon_key'
);

select vault.create_secret(
  'USE_THE_SAME_RANDOM_VALUE_AS_HEARTBEAT_SECRET',
  'dylan_heartbeat_secret'
);

select cron.schedule(
  'dylan-heartbeat-every-30-minutes',
  '*/30 * * * *',
  $$
    select net.http_post(
      url := (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'dylan_project_url'
      ) || '/functions/v1/heartbeat',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'dylan_anon_key'
        ),
        'x-heartbeat-secret', (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'dylan_heartbeat_secret'
        )
      ),
      body := jsonb_build_object(
        'source', 'supabase-cron',
        'scheduled_at', now()
      ),
      timeout_milliseconds := 120000
    ) as request_id;
  $$
);

-- To remove the schedule later:
-- select cron.unschedule('dylan-heartbeat-every-30-minutes');
