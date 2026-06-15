-- =============================================================================
-- MeuPost — schema do Supabase (Postgres)
-- Rode no SQL Editor do seu projeto Supabase (ou via `supabase db push`).
-- Inclui: tabelas, Row Level Security, bucket de mídia e o agendador (pg_cron).
-- =============================================================================

-- ---- Extensões necessárias --------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists pg_cron;   -- agendador
create extension if not exists pg_net;    -- chamadas HTTP a partir do banco

-- ---- Enums (como tipos check simples para facilitar) ------------------------
-- Usamos text + check para não brigar com migrations; o app valida também.

-- ---- Tabela: social_accounts ------------------------------------------------
create table if not exists public.social_accounts (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  platform        text not null check (platform in ('INSTAGRAM','FACEBOOK','TIKTOK')),
  account_name    text not null,
  external_id     text not null default '',
  access_token    text,                 -- guardado pela Edge Function (server-side)
  token_expires_at timestamptz,
  page_id         text,
  ig_business_id  text,
  status          text not null default 'ACTIVE'
                    check (status in ('ACTIVE','EXPIRED','REVOKED','ERROR')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---- Tabela: posts ----------------------------------------------------------
create table if not exists public.posts (
  id               uuid primary key default uuid_generate_v4(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  social_account_id uuid references public.social_accounts(id) on delete cascade,
  type             text not null check (type in ('IMAGE','REELS','CAROUSEL','FB_FEED','TIKTOK_VIDEO')),
  caption          text,
  media_urls       text[] not null default '{}',
  scheduled_at     timestamptz,
  status           text not null default 'DRAFT'
                     check (status in ('DRAFT','SCHEDULED','PROCESSING','PUBLISHED','FAILED')),
  published_at     timestamptz,
  external_post_id text,
  error_message    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists posts_status_idx on public.posts(status);
create index if not exists posts_scheduled_idx on public.posts(scheduled_at);

-- ---- Tabela: post_logs ------------------------------------------------------
create table if not exists public.post_logs (
  id        uuid primary key default uuid_generate_v4(),
  post_id   uuid not null references public.posts(id) on delete cascade,
  timestamp timestamptz not null default now(),
  level     text not null default 'INFO' check (level in ('INFO','ERROR')),
  message   text not null,
  payload   jsonb
);
create index if not exists post_logs_post_idx on public.post_logs(post_id);

-- ---- Tabela: ai_caption_requests --------------------------------------------
create table if not exists public.ai_caption_requests (
  id         uuid primary key default uuid_generate_v4(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  prompt     text not null,
  tone       text,
  audience   text,
  variations jsonb,
  created_at timestamptz not null default now()
);

-- =============================================================================
-- Row Level Security — cada usuário só enxerga os próprios dados.
-- O Admin é simplesmente o usuário do Supabase Auth que você usa.
-- =============================================================================
alter table public.social_accounts    enable row level security;
alter table public.posts               enable row level security;
alter table public.post_logs           enable row level security;
alter table public.ai_caption_requests enable row level security;

-- Política genérica de "dono".
create policy "own_accounts" on public.social_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own_posts" on public.posts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own_logs" on public.post_logs
  for all using (
    exists (select 1 from public.posts p where p.id = post_id and p.user_id = auth.uid())
  );

create policy "own_ai" on public.ai_caption_requests
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =============================================================================
-- Storage: bucket público de mídia (Instagram exige URL pública).
-- =============================================================================
insert into storage.buckets (id, name, public)
values ('media', 'media', true)
on conflict (id) do nothing;

-- Upload restrito ao dono (path = email_sanitizado/arquivo); leitura pública.
create policy "media_read" on storage.objects
  for select using (bucket_id = 'media');
create policy "media_write" on storage.objects
  for insert with check (bucket_id = 'media' and auth.role() = 'authenticated');

-- =============================================================================
-- AGENDADOR — pg_cron chama a Edge Function "scheduler" a cada minuto.
-- A função busca posts SCHEDULED vencidos e publica.
--
-- IMPORTANTE: substitua <PROJECT_REF> e <SERVICE_ROLE_KEY> abaixo.
-- (Pegue em Project Settings → API. NUNCA exponha a service role no frontend.)
-- =============================================================================
select cron.schedule(
  'meupost-scheduler',
  '* * * * *',  -- a cada minuto
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.functions.supabase.co/scheduler',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Para remover o agendador depois:
-- select cron.unschedule('meupost-scheduler');
