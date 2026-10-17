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

Deno.test("台費帳戶不列入分析", () => {
  const players = [...P.slice(0, 3), { id: "d", name: "東", line_user_id: null, is_house: true }];
  const games = [{ id: "g1", played_at: "2026-10-01T12:00:00Z", note: null }, { id: "g2", played_at: "2026-10-02T12:00:00Z", note: null }];
  const scores = [
    { game_id: "g1", player_id: "a", points: 100 }, { game_id: "g1", player_id: "b", points: -80 }, { game_id: "g1", player_id: "d", points: -20 },
    { game_id: "g2", player_id: "a", points: -50 }, { game_id: "g2", player_id: "b", points: 70 }, { game_id: "g2", player_id: "d", points: -20 },
  ];
  const r = computeAnalysis("a", players, games, scores)!;
  assertEquals(r.partners.map((p) => p.name), ["阿華"]);
  assertEquals(r.rivals.map((p) => p.name), ["阿華"]);
  assertEquals(r.tables.length, 1);
  assertEquals(r.tables[0].names, ["阿華"]);
  assertEquals(r.games, 2); // 自己的場次照算
  assertEquals(computeAnalysis("d", players, games, scores), null);
});

import { validateSplit } from "./logic.ts";

Deno.test("拆桌檢查", () => {
  const H = new Set(["h"]);
  const orig = [
    { player_id: "a", points: 300 }, { player_id: "b", points: -200 }, { player_id: "c", points: -100 }, { player_id: "d", points: -100 },
    { player_id: "e", points: 200 }, { player_id: "f", points: -100 }, { player_id: "g", points: -150 }, { player_id: "i", points: -50 },
    { player_id: "h", points: 200 },
  ];
  const t1 = [{ player_id: "a", points: 300 }, { player_id: "b", points: -200 }, { player_id: "c", points: -100 }, { player_id: "d", points: -100 }, { player_id: "h", points: 100 }];
  const t2 = [{ player_id: "e", points: 200 }, { player_id: "f", points: -100 }, { player_id: "g", points: -150 }, { player_id: "i", points: -50 }, { player_id: "h", points: 100 }];
  assertEquals(validateSplit(orig, [t1, t2], H), null);
  assertEquals(validateSplit(orig, [t1], H), "至少要拆成兩桌");
  // 台費分錯
  const t1b = t1.map((e) => e.player_id === "h" ? { ...e, points: 150 } : e);
  assertEquals(validateSplit(orig, [t1b, t2], H)?.includes("總和"), true);
  // 有人沒分到
  assertEquals(validateSplit(orig, [t1, t2.filter((e) => e.player_id !== "i").map((e) => e.player_id === "h" ? { ...e, points: 50 } : e)], H), "每位玩家至少要分到一桌");
  // 改了玩家分數
  const t2c = t2.map((e) => e.player_id === "e" ? { ...e, points: 250 } : e.player_id === "f" ? { ...e, points: -150 } : e);
  assertEquals(validateSplit(orig, [t1, t2c], H), "同一個人在各桌的分數加起來，要和原本一樣");
  // 中途換桌：a 的 +300 拆成 桌1 +250、桌2 +50
  const t2ok = [{ player_id: "e", points: 200 }, { player_id: "f", points: -100 }, { player_id: "g", points: -150 }, { player_id: "i", points: -50 }, { player_id: "a", points: 50 }, { player_id: "h", points: 50 }];
  const t1ok = [{ player_id: "a", points: 250 }, { player_id: "b", points: -200 }, { player_id: "c", points: -100 }, { player_id: "d", points: -100 }, { player_id: "h", points: 150 }];
  assertEquals(validateSplit(orig, [t1ok, t2ok], H), null);
  // 換桌的人兩邊加起來不對
  const t2bad = t2ok.map((e) => e.player_id === "a" ? { ...e, points: 100 } : e.player_id === "h" ? { ...e, points: 0 } : e);
  assertEquals(validateSplit(orig, [t1ok, t2bad], H), "同一個人在各桌的分數加起來，要和原本一樣");
});
