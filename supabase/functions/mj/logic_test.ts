import { deepStrictEqual as assertEquals } from "node:assert";
import { computeStandings, cumulativeSeries, makeRoomCode, parseScoreText, validateEntries } from "./logic.ts";

const P = [
  { id: "a", name: "小明", line_user_id: null },
  { id: "b", name: "阿華", line_user_id: null },
  { id: "c", name: "老王", line_user_id: null },
  { id: "d", name: "阿美", line_user_id: null },
];

Deno.test("parse 多種寫法", () => {
  const want = [{ name: "小明", points: 100 }, { name: "阿華", points: -30 }, { name: "老王", points: -70 }];
  assertEquals(parseScoreText("小明+100 阿華-30 老王-70"), want);
  assertEquals(parseScoreText("小明 100 阿華 -30 老王 -70"), want);
  assertEquals(parseScoreText("小明：+100、阿華：-30，老王：-70"), want);
  assertEquals(parseScoreText("小明＋１００ 阿華－３０ 老王－７０"), want);
});

Deno.test("驗證：總和、未知玩家、重複", () => {
  assertEquals(validateEntries(parseScoreText("小明+100 阿華-30 老王-70"), P).ok, true);
  assertEquals(validateEntries(parseScoreText("小明+100 阿華-30"), P).ok, false);
  assertEquals(validateEntries(parseScoreText("小明+100 路人-100"), P).ok, false);
  assertEquals(validateEntries(parseScoreText("小明+100 小明-100"), P).ok, false);
  assertEquals(validateEntries(parseScoreText("小明+100"), P).ok, false);
});

Deno.test("戰績與走勢", () => {
  const games = [{ id: "g1", played_at: "", note: null }, { id: "g2", played_at: "", note: null }];
  const scores = [
    { game_id: "g1", player_id: "a", points: 100 }, { game_id: "g1", player_id: "b", points: -100 },
    { game_id: "g2", player_id: "a", points: -50 }, { game_id: "g2", player_id: "c", points: 50 },
  ];
  const st = computeStandings(P, scores);
  assertEquals(st[0].name, "小明");
  assertEquals(st[0].total, 50);
  assertEquals(st[0].games, 2);
  assertEquals(st[0].winRate, 0.5);
  assertEquals(st.find((s) => s.name === "阿美")!.games, 0);
  const cs = cumulativeSeries(P, games, scores);
  assertEquals(cs.series[0].values, [100, 50]);
  assertEquals(cs.series[1].values, [-100, -100]);
});

Deno.test("房號格式", () => {
  const c = makeRoomCode();
  assertEquals(/^[A-HJ-NP-Z2-9]{6}$/.test(c), true);
});

import { computeAnalysis, monthOf } from "./logic.ts";

Deno.test("個人分析：同桌、對手、整桌、連勝、月份", () => {
  // a=小明 b=阿華 c=老王 d=阿美
  const g = (id: string, at: string) => ({ id, played_at: at, note: null });
  const games = [
    g("g1", "2026-09-30T15:00:00Z"), // 台灣時間 9/30 23:00 → 2026-09
    g("g2", "2026-10-05T12:00:00Z"),
    g("g3", "2026-10-06T12:00:00Z"),
    g("g4", "2026-10-07T12:00:00Z"),
  ];
  const sc = (game_id: string, rows: [string, number][]) => rows.map(([player_id, points]) => ({ game_id, player_id, points }));
  const scores = [
    ...sc("g1", [["a", -50], ["b", 80], ["c", -30]]),
    ...sc("g2", [["a", 100], ["b", -60], ["c", -40]]),
    ...sc("g3", [["a", 30], ["b", -10], ["d", -20]]),
    ...sc("g4", [["a", 20], ["b", -20]]),
  ];
  const r = computeAnalysis("a", P, games, scores)!;
  assertEquals([r.games, r.wins, r.total, r.avg], [4, 3, 100, 25]);
  assertEquals(r.streak, 3);
  assertEquals(r.longestWinStreak, 3);
  assertEquals(r.best!.game_id, "g2");
  assertEquals(r.worst!.game_id, "g1");

  const hua = r.partners.find((p) => p.name === "阿華")!;
  assertEquals([hua.games, hua.wins, hua.avg], [4, 3, 25]);
  const wang = r.partners.find((p) => p.name === "老王")!;
  assertEquals([wang.games, wang.wins], [2, 1]);

  // 對阿華：(-50-80)+(100+60)+(30+10)+(20+20) = 110 / 4 = 27.5
  const rh = r.rivals.find((x) => x.name === "阿華")!;
  assertEquals([rh.avgDiff, rh.aheadRate], [27.5, 0.75]);

  // 整桌：{阿華,老王} 2 場、{阿華,阿美} 1 場、{阿華} 1 場
  assertEquals(r.tables[0].names.sort(), ["老王", "阿華"].sort());
  assertEquals(r.tables[0].games, 2);
  assertEquals(r.tables.length, 3);

  assertEquals(monthOf("2026-09-30T15:00:00Z"), "2026-09"); // 台灣 9/30 23:00
  assertEquals(monthOf("2026-09-30T16:30:00Z"), "2026-10"); // 台灣 10/1 00:30
  assertEquals(r.months.map((m) => m.month), ["2026-10", "2026-09"]);

  assertEquals(computeAnalysis("zzz", P, games, scores), null);

  // 連敗與 0 分中斷
  const r2 = computeAnalysis("b", P, games, scores)!;
  assertEquals(r2.streak, -3);
});
