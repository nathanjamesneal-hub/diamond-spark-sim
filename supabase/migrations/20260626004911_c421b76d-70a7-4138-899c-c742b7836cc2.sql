
select cron.unschedule(jobid) from cron.job
  where jobname in ('refresh-lineups-window-a','refresh-lineups-window-b');

select cron.schedule(
  'refresh-lineups-window-a',
  '*/15 13-23 * * *',
  $cron$
  select net.http_post(
    url := 'https://project--0bdb12d7-3e43-4610-acad-1ad94d39b71d.lovable.app/api/public/hooks/refresh-lineups',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name='CRON_WEBHOOK_SECRET' limit 1
      )
    ),
    body := '{}'::jsonb
  );
  $cron$
);

select cron.schedule(
  'refresh-lineups-window-b',
  '*/15 0-2 * * *',
  $cron$
  select net.http_post(
    url := 'https://project--0bdb12d7-3e43-4610-acad-1ad94d39b71d.lovable.app/api/public/hooks/refresh-lineups',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name='CRON_WEBHOOK_SECRET' limit 1
      )
    ),
    body := '{}'::jsonb
  );
  $cron$
);

drop function if exists public.block_new_signups() cascade;
