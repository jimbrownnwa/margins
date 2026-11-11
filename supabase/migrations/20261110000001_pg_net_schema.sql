-- Keep pg_net out of the public schema (Supabase security advisor: extension_in_public).
-- Its functions live in the "net" schema either way, so cron calls to net.http_post are unaffected.
drop extension if exists pg_net;
create extension pg_net with schema extensions;
