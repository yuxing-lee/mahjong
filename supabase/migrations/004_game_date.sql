-- 記分時可以指定日期（補記以前的牌局）
-- 新增 record_game_at；舊的 record_game 保留不動（不刪，避免影響舊版程式）
create or replace function public.record_game_at(
  p_room_id uuid, p_created_by text, p_note text, p_scores jsonb, p_played_at timestamptz default now()
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

  insert into games(room_id, created_by, note, played_at)
    values (p_room_id, p_created_by, nullif(p_note, ''), coalesce(p_played_at, now()))
    returning id into v_game_id;

  insert into scores(game_id, player_id, points)
    select v_game_id, (s->>'player_id')::uuid, (s->>'points')::int
    from jsonb_array_elements(p_scores) s;

  return v_game_id;
end;
$$;

revoke all on function public.record_game_at(uuid, text, text, jsonb, timestamptz) from public, anon, authenticated;
