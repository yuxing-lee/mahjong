-- 把「一次記了兩桌」的一場拆成多場（同一個交易：新增各桌、刪掉原本那場）
-- 前端／Edge Function 已經檢查過分數對得上，這裡再檢查每桌總和為 0 和玩家屬於房間
create or replace function public.split_game(p_room_id uuid, p_game_id uuid, p_tables jsonb)
returns setof uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_game   games%rowtype;
  v_table  jsonb;
  v_idx    int := 0;
  v_new_id uuid;
  v_sum    int;
begin
  select * into v_game from games where id = p_game_id and room_id = p_room_id for update;
  if not found then
    raise exception '找不到這一場';
  end if;
  if jsonb_array_length(p_tables) < 2 then
    raise exception '至少要拆成兩桌';
  end if;

  for v_table in select value from jsonb_array_elements(p_tables) loop
    v_idx := v_idx + 1;
    select coalesce(sum((s->>'points')::int), 0) into v_sum from jsonb_array_elements(v_table) s;
    if v_sum <> 0 then
      raise exception '第 % 桌的總和不是 0（%）', v_idx, v_sum;
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_table) s
      left join players p on p.id = (s->>'player_id')::uuid and p.room_id = p_room_id
      where p.id is null
    ) then
      raise exception '有玩家不屬於這個房間';
    end if;

    insert into games(room_id, created_by, note, played_at)
      values (p_room_id, v_game.created_by,
              concat_ws('・', nullif(v_game.note, ''), '第' || v_idx || '桌'),
              -- 同一時間的多桌依序差 1 毫秒，排序才固定
              v_game.played_at + (v_idx - 1) * interval '1 millisecond')
      returning id into v_new_id;
    insert into scores(game_id, player_id, points)
      select v_new_id, (s->>'player_id')::uuid, (s->>'points')::int from jsonb_array_elements(v_table) s;
    return next v_new_id;
  end loop;

  delete from games where id = p_game_id;
end;
$$;

revoke all on function public.split_game(uuid, uuid, jsonb) from public, anon, authenticated;
