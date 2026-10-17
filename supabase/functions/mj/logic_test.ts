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
