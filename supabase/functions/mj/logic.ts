// 純邏輯：不碰網路或資料庫，方便測試

export type Player = { id: string; name: string; line_user_id: string | null };
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
