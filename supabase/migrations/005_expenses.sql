-- 額外消費（例如飲料錢）：跟牌局輸贏分開記，只記品項、總金額、日期
create table public.expenses (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms(id) on delete cascade,
  item       text not null check (char_length(item) between 1 and 30),
  amount     integer not null check (amount > 0 and amount <= 1000000),
  spent_at   timestamptz not null default now(),
  created_by text not null,
  created_at timestamptz not null default now()
);
create index expenses_room_spent_idx on public.expenses (room_id, spent_at desc);
alter table public.expenses enable row level security;
