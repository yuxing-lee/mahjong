-- 麻將計分 LINE 版：初始資料表
-- 所有存取都經過 Edge Function（service role），前端不直接連資料庫，
-- 所以各表都開 RLS、不給 anon / authenticated 任何 policy。

create extension if not exists pgcrypto;

create table public.rooms (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,           -- 給 LIFF 連結用的短代碼
  name               text not null,
  line_group_id      text unique,                    -- 綁定的 LINE 群組
  admin_line_user_id text not null,                  -- 管理員（建房的人）
  created_at         timestamptz not null default now()
);

create table public.players (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.rooms(id) on delete cascade,
  name         text not null,
  line_user_id text,                                 -- 認領後才有
  created_at   timestamptz not null default now(),
  unique (room_id, name)
);
create unique index players_room_line_user_uniq
  on public.players(room_id, line_user_id) where line_user_id is not null;

create table public.games (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms(id) on delete cascade,
  note       text,
  created_by text not null,
  played_at  timestamptz not null default now()
);
create index games_room_played_idx on public.games(room_id, played_at desc);

create table public.scores (
  game_id   uuid not null references public.games(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  points    integer not null,
  primary key (game_id, player_id)
);
create index scores_player_idx on public.scores(player_id);

alter table public.rooms   enable row level security;
alter table public.players enable row level security;
alter table public.games   enable row level security;
alter table public.scores  enable row level security;

-- 一次寫入一場（game + scores），並在資料庫端再檢查一次總和為零
create or replace function public.record_game(
  p_room_id uuid, p_created_by text, p_note text, p_scores jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game_id uuid;
  v_sum     integer;
  v_count   integer;
begin
  select coalesce(sum((s->>'points')::int), 0), count(*)
    into v_sum, v_count
    from jsonb_array_elements(p_scores) s;

  if v_count < 2 then
    raise exception '至少需要兩位玩家';
  end if;
  if v_sum <> 0 then
    raise exception '分數總和必須為 0（目前 %）', v_sum;
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_scores) s
    left join players p on p.id = (s->>'player_id')::uuid and p.room_id = p_room_id
    where p.id is null
  ) then
    raise exception '有玩家不屬於這個房間';
  end if;

  insert into games(room_id, created_by, note)
    values (p_room_id, p_created_by, nullif(p_note, ''))
    returning id into v_game_id;

  insert into scores(game_id, player_id, points)
    select v_game_id, (s->>'player_id')::uuid, (s->>'points')::int
    from jsonb_array_elements(p_scores) s;

  return v_game_id;
end;
$$;

revoke all on function public.record_game(uuid, text, text, jsonb) from public, anon, authenticated;
