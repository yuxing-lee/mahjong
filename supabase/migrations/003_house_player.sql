-- 台費帳戶：例如場主收的設備錢（玩家名「東」）。照樣記分、照樣出現在排行，但不列入個人分析
alter table public.players add column is_house boolean not null default false;
