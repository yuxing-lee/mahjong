// 純邏輯：不碰網路或資料庫，方便測試

export type Player = {
  id: string; name: string; line_user_id: string | null;
  /** 台費帳戶（例如場主的設備錢）：照樣記分，但不列入個人分析 */
  is_house?: boolean;
};
export type Score = { game_id: string; player_id: string; points: number };
export type Game = { id: string; played_at: string; note: string | null };

export type Standing = {
  player_id: string;
  name: string;
  total: number;
  games: number;
  wins: number; // 該場得分 > 0
  winRate: number; // 0~1
  avg: number;
  best: number;
  worst: number;
};

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉 I O 0 1

export function makeRoomCode(len = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/**
 * 解析「名字+分數」清單，例如：
 *   "小明+100 阿華-30 老王-70"
 *   "小明 100 阿華 -30 老王 -70"
 *   "小明：+100、阿華：-30"
 */
export function parseScoreText(text: string): { name: string; points: number }[] {
  const out: { name: string; points: number }[] = [];
  const re = /([^\s+\-－＋0-9０-９:：,，、]+)[\s:：]*([+\-－＋]?[0-9０-９]+)/g;
  const normalized = text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[＋]/g, "+")
    .replace(/[－−]/g, "-");
  for (const m of normalized.matchAll(re)) {
    out.push({ name: m[1], points: parseInt(m[2], 10) });
  }
  return out;
}

export type ScoreCheck =
  | { ok: true; entries: { player: Player; points: number }[] }
  | { ok: false; error: string };

export function validateEntries(
  parsed: { name: string; points: number }[],
  players: Player[],
): ScoreCheck {
  if (parsed.length < 2) {
    return { ok: false, error: "至少要輸入兩位玩家的分數，例如：/記 小明+100 阿華-50 老王-50" };
  }
  const byName = new Map(players.map((p) => [p.name, p]));
  const unknown = parsed.filter((e) => !byName.has(e.name)).map((e) => e.name);
  if (unknown.length) {
    return {
      ok: false,
      error: `找不到玩家：${unknown.join("、")}\n先用「/加人 ${unknown.join(" ")}」加入房間`,
    };
  }
  const seen = new Set<string>();
  for (const e of parsed) {
    if (seen.has(e.name)) return { ok: false, error: `「${e.name}」重複輸入了` };
    seen.add(e.name);
  }
  const sum = parsed.reduce((a, e) => a + e.points, 0);
  if (sum !== 0) {
    return { ok: false, error: `分數總和是 ${sum > 0 ? "+" : ""}${sum}，必須等於 0，請再檢查一次` };
  }
  return { ok: true, entries: parsed.map((e) => ({ player: byName.get(e.name)!, points: e.points })) };
}

export function computeStandings(players: Player[], scores: Score[]): Standing[] {
  const map = new Map<string, Standing>();
  for (const p of players) {
    map.set(p.id, {
      player_id: p.id, name: p.name, total: 0, games: 0, wins: 0,
      winRate: 0, avg: 0, best: 0, worst: 0,
    });
  }
  for (const s of scores) {
    const st = map.get(s.player_id);
    if (!st) continue;
    if (st.games === 0) { st.best = s.points; st.worst = s.points; }
    st.total += s.points;
    st.games += 1;
    if (s.points > 0) st.wins += 1;
    st.best = Math.max(st.best, s.points);
    st.worst = Math.min(st.worst, s.points);
  }
  const list = [...map.values()];
  for (const st of list) {
    st.winRate = st.games ? st.wins / st.games : 0;
    st.avg = st.games ? Math.round((st.total / st.games) * 10) / 10 : 0;
  }
  return list.sort((a, b) => b.total - a.total || b.games - a.games);
}

/** 每位玩家依場次順序的累計分數，給走勢圖用（games 需由舊到新） */
export function cumulativeSeries(players: Player[], games: Game[], scores: Score[]) {
  const byGame = new Map<string, Map<string, number>>();
  for (const s of scores) {
    if (!byGame.has(s.game_id)) byGame.set(s.game_id, new Map());
    byGame.get(s.game_id)!.set(s.player_id, s.points);
  }
  const running = new Map(players.map((p) => [p.id, 0]));
  const series = players.map((p) => ({ player_id: p.id, name: p.name, values: [] as number[] }));
  for (const g of games) {
    const gm = byGame.get(g.id) ?? new Map();
    for (const sr of series) {
      running.set(sr.player_id, running.get(sr.player_id)! + (gm.get(sr.player_id) ?? 0));
      sr.values.push(running.get(sr.player_id)!);
    }
  }
  return { labels: games.map((_, i) => `#${i + 1}`), series };
}

export function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

export function formatGameLine(entries: { name: string; points: number }[]): string {
  return [...entries]
    .sort((a, b) => b.points - a.points)
    .map((e) => `${e.name} ${signed(e.points)}`)
    .join("｜");
}

// ───────────────────────── 個人分析 ─────────────────────────

export type PartnerStat = {
  player_id: string; name: string;
  games: number; wins: number; winRate: number; avg: number; total: number;
};
export type RivalStat = {
  player_id: string; name: string;
  games: number;
  /** 同桌時「我 - 對方」的平均分差；正數代表我比較好 */
  avgDiff: number;
  /** 同桌時我分數比對方高的比例 */
  aheadRate: number;
};
export type TableStat = {
  player_ids: string[]; names: string[];
  games: number; wins: number; winRate: number; avg: number; total: number;
};
export type MonthStat = { month: string; games: number; wins: number; total: number; avg: number };
export type GameRef = { game_id: string; played_at: string; points: number };

export type Analysis = {
  player_id: string; name: string;
  games: number; wins: number; winRate: number; total: number; avg: number;
  last10Avg: number; last10Games: number;
  /** 正數＝目前連勝幾場、負數＝目前連敗幾場、0＝沒有連續 */
  streak: number;
  longestWinStreak: number;
  best: GameRef | null; worst: GameRef | null;
  partners: PartnerStat[];
  rivals: RivalStat[];
  tables: TableStat[];
  months: MonthStat[];
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** 以台灣時間（UTC+8）算月份 */
export function monthOf(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3600e3);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * 以某位玩家為主角的分析。games 需由舊到新。
 * 「贏」的定義和排行一致：該場得分 > 0。
 */
export function computeAnalysis(playerId: string, players: Player[], games: Game[], scores: Score[]): Analysis | null {
  const me = players.find((p) => p.id === playerId);
  if (!me || me.is_house) return null;
  const nameOf = new Map(players.map((p) => [p.id, p.name]));
  // 台費帳戶不算「同桌的人」
  const house = new Set(players.filter((p) => p.is_house).map((p) => p.id));
  const byGame = new Map<string, Map<string, number>>();
  for (const s of scores) {
    if (!byGame.has(s.game_id)) byGame.set(s.game_id, new Map());
    byGame.get(s.game_id)!.set(s.player_id, s.points);
  }

  const mine: { game: Game; points: number; others: Map<string, number> }[] = [];
  for (const g of games) {
    const gm = byGame.get(g.id);
    if (!gm || !gm.has(playerId)) continue;
    const others = new Map([...gm].filter(([id]) => id !== playerId && !house.has(id)));
    mine.push({ game: g, points: gm.get(playerId)!, others });
  }

  const pts = mine.map((m) => m.points);
  const wins = pts.filter((p) => p > 0).length;
  const total = pts.reduce((a, b) => a + b, 0);
  const last10 = pts.slice(-10);

  // 連勝 / 連敗
  let streak = 0;
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    if (p === 0) break;
    if (streak === 0) streak = p > 0 ? 1 : -1;
    else if ((p > 0) === (streak > 0)) streak += streak > 0 ? 1 : -1;
    else break;
  }
  let longestWinStreak = 0, run = 0;
  for (const p of pts) { run = p > 0 ? run + 1 : 0; longestWinStreak = Math.max(longestWinStreak, run); }

  let best: GameRef | null = null, worst: GameRef | null = null;
  for (const m of mine) {
    const ref = { game_id: m.game.id, played_at: m.game.played_at, points: m.points };
    if (!best || m.points > best.points) best = ref;
    if (!worst || m.points < worst.points) worst = ref;
  }

  // 同桌夥伴、對手
  const pAgg = new Map<string, { games: number; wins: number; total: number; diff: number; ahead: number }>();
  for (const m of mine) {
    for (const [oid, opts] of m.others) {
      const a = pAgg.get(oid) ?? { games: 0, wins: 0, total: 0, diff: 0, ahead: 0 };
      a.games += 1;
      if (m.points > 0) a.wins += 1;
      a.total += m.points;
      a.diff += m.points - opts;
      if (m.points > opts) a.ahead += 1;
      pAgg.set(oid, a);
    }
  }
  const partners: PartnerStat[] = [...pAgg].map(([id, a]) => ({
    player_id: id, name: nameOf.get(id) ?? "?",
    games: a.games, wins: a.wins, winRate: a.wins / a.games, avg: round1(a.total / a.games), total: a.total,
  })).sort((x, y) => y.winRate - x.winRate || y.avg - x.avg || y.games - x.games);
  const rivals: RivalStat[] = [...pAgg].map(([id, a]) => ({
    player_id: id, name: nameOf.get(id) ?? "?",
    games: a.games, avgDiff: round1(a.diff / a.games), aheadRate: a.ahead / a.games,
  })).sort((x, y) => y.avgDiff - x.avgDiff || y.games - x.games);

  // 整桌組合（同桌的其他人完全相同才算同一組）
  const tAgg = new Map<string, { ids: string[]; games: number; wins: number; total: number }>();
  for (const m of mine) {
    const ids = [...m.others.keys()].sort();
    const key = ids.join(",");
    const a = tAgg.get(key) ?? { ids, games: 0, wins: 0, total: 0 };
    a.games += 1;
    if (m.points > 0) a.wins += 1;
    a.total += m.points;
    tAgg.set(key, a);
  }
  const tables: TableStat[] = [...tAgg.values()].map((a) => ({
    player_ids: a.ids, names: a.ids.map((id) => nameOf.get(id) ?? "?"),
    games: a.games, wins: a.wins, winRate: a.wins / a.games, avg: round1(a.total / a.games), total: a.total,
  })).sort((x, y) => y.games - x.games || y.winRate - x.winRate);

  // 每月
  const mAgg = new Map<string, MonthStat>();
  for (const m of mine) {
    const key = monthOf(m.game.played_at);
    const a = mAgg.get(key) ?? { month: key, games: 0, wins: 0, total: 0, avg: 0 };
    a.games += 1;
    if (m.points > 0) a.wins += 1;
    a.total += m.points;
    mAgg.set(key, a);
  }
  const months = [...mAgg.values()].map((a) => ({ ...a, avg: round1(a.total / a.games) }))
    .sort((x, y) => y.month.localeCompare(x.month));

  return {
    player_id: me.id, name: me.name,
    games: pts.length, wins, winRate: pts.length ? wins / pts.length : 0, total,
    avg: pts.length ? round1(total / pts.length) : 0,
    last10Avg: last10.length ? round1(last10.reduce((a, b) => a + b, 0) / last10.length) : 0,
    last10Games: last10.length,
    streak, longestWinStreak, best, worst,
    partners, rivals, tables, months,
  };
}
