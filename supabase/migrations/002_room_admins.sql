-- 多位管理員：建房的人（rooms.admin_line_user_id）是房主，這張表放額外加的管理員
create table public.room_admins (
  room_id      uuid not null references public.rooms(id) on delete cascade,
  line_user_id text not null,
  added_by     text not null,
  created_at   timestamptz not null default now(),
  primary key (room_id, line_user_id)
);
alter table public.room_admins enable row level security;
