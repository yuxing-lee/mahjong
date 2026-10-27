// 端到端測試：用 JSON 檔儲存，模擬 LINE webhook 和 LIFF API 呼叫
import { deepStrictEqual as eq, ok } from "node:assert";

const dataFile = await Deno.makeTempFile({ suffix: ".json" });
await Deno.remove(dataFile);
Deno.env.set("STORE", "file");
Deno.env.set("DATA_FILE", dataFile);
Deno.env.set("LINE_CHANNEL_SECRET", "test-secret");
Deno.env.set("LINE_CHANNEL_ACCESS_TOKEN", ""); // 不打 LINE，改印到 console
Deno.env.set("DEV_FAKE_LOGIN", "1");
Deno.env.set("LIFF_ID", "1234-abcd");

const { handler, signBody } = await import("./index.ts");

// 攔截 Bot 送出的訊息
const sent: { kind: string; body: any }[] = [];
const origLog = console.log;
console.log = (tag: unknown, payload?: unknown) => {
  const m = String(tag).match(/^\[LINE (\w+)\]$/);
  if (m) sent.push({ kind: m[1], body: JSON.parse(String(payload)) });
  else origLog(tag, payload);
};
const lastText = () => {
  const msgs = sent.at(-1)!.body.messages;
  return msgs.map((m: any) => m.text ?? m.altText).join("\n");
};

const GROUP = "Cgroup1", ADMIN = "Uadmin", OTHER = "Uother";
async function say(user: string, msg: string, mentionUserIds: string[] = []) {
  const body = JSON.stringify({ events: [{
    type: "message", replyToken: "rt", source: { type: "group", groupId: GROUP, userId: user },
    message: {
      type: "text", text: msg,
      ...(mentionUserIds.length ? { mention: { mentionees: mentionUserIds.map((id) => ({ type: "user", userId: id, index: 0, length: 1 })) } } : {}),
    },
  }] });
  const res = await handler(new Request("http://x/webhook", {
    method: "POST", body, headers: { "x-line-signature": await signBody(body, "test-secret") },
  }));
  eq(res.status, 200);
  return lastText();
}
async function api(user: string, path: string, payload?: unknown) {
  const res = await handler(new Request(`http://x/api/${path}`, {
    method: payload ? "POST" : "GET",
    headers: { authorization: `Bearer dev:${user}`, "content-type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  }));
  return { status: res.status, body: await res.json() };
}

Deno.test("簽章錯誤會被擋", async () => {
  const res = await handler(new Request("http://x/webhook", {
    method: "POST", body: "{}", headers: { "x-line-signature": "nope" },
  }));
  eq(res.status, 401);
});

Deno.test("群組完整流程 + LIFF API", async () => {
  ok((await say(ADMIN, "/戰績")).includes("還沒有房間"));
  const created = await say(ADMIN, "/開房 週五麻將");
  ok(created.includes("已建立房間「週五麻將」"));
  const code = created.match(/room=([A-Z0-9]{6})/)![1];

  ok((await say(OTHER, "/加人 路人")).includes("只有管理員"));
  ok((await say(ADMIN, "/加人 小明 阿華 老王 阿美 A1")).includes("已加入：小明、阿華、老王、阿美"));
  ok((await say(ADMIN, "/記 小明+100 阿華-30 老王-60")).includes("總和是 +10"));
  ok((await say(ADMIN, "/記 小明+100 路人-100")).includes("找不到玩家：路人"));
  const rec = await say(ADMIN, "/記 小明+100 阿華-30 老王-70");
  ok(rec.includes("第 1 場") && rec.includes("小明 +100"));
  await say(ADMIN, "/記 阿美 50 小明 -50");
  ok((await say(OTHER, "/最近")).includes("#2 阿美 +50｜小明 -50"));

  // LIFF API
  const room = await api(OTHER, `room?code=${code}`);
  eq(room.status, 200);
  eq(room.body.me.isAdmin, false);
  eq(room.body.totalGames, 2);
  eq(room.body.standings[0].name, "小明"); // 同分 50，場數多者在前
  eq(room.body.recent[0].no, 2);

  eq((await api(OTHER, "game", { code, scores: [] })).status, 403);
  const players = room.body.players as { id: string; name: string }[];
  const id = (n: string) => players.find((p) => p.name === n)!.id;
  eq((await api(ADMIN, "game", { code, scores: [{ player_id: id("小明"), points: 10 }, { player_id: id("阿華"), points: -5 }] })).status, 400);
  eq((await api(ADMIN, "game", { code, scores: [{ player_id: id("小明"), points: 10 }, { player_id: id("阿華"), points: -10 }], note: "東風" })).status, 200);
  ok(sent.some((s) => s.kind === "push" && s.body.to === GROUP), "記分頁送出後要推播到群組");
  ok(!JSON.stringify(sent.filter((s) => s.kind === "push").at(-1)!.body).includes("累計"), "推播不附累計");

  eq((await api(OTHER, "claim", { code, player_id: id("阿華") })).status, 200);
  eq((await api(OTHER, "claim", { code, player_id: id("老王") })).body.error, "你已經認領過了");
  eq((await api(OTHER, `room?code=${code}`)).body.me.player, id("阿華"));

  // 分析：群組指令 + API
  ok((await say(ADMIN, "/分析 小明")).includes("小明 的分析"));
  ok((await say(ADMIN, "/分析 路人")).includes("找不到玩家"));
  ok((await say(ADMIN, "/分析")).includes("用法"), "管理員沒認領名字時要提示");
  const an = await api(OTHER, `analysis?code=${code}&player=${id("小明")}`);
  eq(an.status, 200);
  eq(an.body.name, "小明");
  ok(an.body.partners.length > 0 && an.body.minPairGames === 3);
  eq((await api(OTHER, `analysis?code=${code}&player=nope`)).status, 404);

  // 補記日期：記在過去、推播標日期、排序在前面；可以改日期；不能是未來
  const past = "2026-01-15T13:00:00.000Z";
  eq((await api(ADMIN, "game", { code, scores: [{ player_id: id("小明"), points: 7 }, { player_id: id("阿華"), points: -7 }], played_at: past })).status, 200);
  ok(JSON.stringify(sent.filter((s) => s.kind === "push").at(-1)!.body).includes("第 1 場（1/15）"), "補記的場次依日期排在第 1 場並標日期");
  let rm = (await api(ADMIN, `room?code=${code}`)).body;
  const backdated = rm.recent.find((g: any) => g.played_at === past);
  eq(backdated.no, 1);
  eq((await api(ADMIN, "game", { code, scores: [{ player_id: id("小明"), points: 1 }, { player_id: id("阿華"), points: -1 }], played_at: "2999-01-01" })).body.error, "日期不能是未來");
  eq((await api(OTHER, "game/date", { code, game_id: backdated.id, played_at: "2026-02-01T00:00:00Z" })).status, 403);
  eq((await api(ADMIN, "game/date", { code, game_id: backdated.id, played_at: "2026-02-01T00:00:00Z" })).status, 200);
  rm = (await api(ADMIN, `room?code=${code}`)).body;
  eq(rm.recent.find((g: any) => g.id === backdated.id).played_at, "2026-02-01T00:00:00.000Z");
  eq((await api(ADMIN, "game/date", { code, game_id: "nope", played_at: "2026-02-01T00:00:00Z" })).status, 404);
  eq((await api(ADMIN, "game/delete", { code, game_id: backdated.id })).status, 200);

  // 拆兩桌：先記一場「兩桌合在一起」的，再拆開
  await say(ADMIN, "/加人 甲 乙 丙 丁");
  await say(ADMIN, "/設台費 阿美");

  // 群組選單：Flex 按鈕卡片，連到記分頁指定分頁
  ok((await say(OTHER, "/選單")).includes("選單"));
  const menu = JSON.stringify(sent.at(-1)!.body);
  ok(menu.includes(`room=${code}&tab=analysis`) && menu.includes("阿美的消費") && menu.includes("/消費"), menu);
  ok(JSON.stringify(sent.at(-1)!.body.messages.at(-1).quickReply).includes("/選單"), "快速按鈕要有選單");

  // 額外消費：跟牌局分開，只記品項和總金額
  ok((await say(OTHER, "/消費 飲料 300")).includes("只有管理員"));
  ok((await say(ADMIN, "/消費 飲料")).includes("用法"));
  ok((await say(ADMIN, "/消費 飲料 0")).includes("大於 0"));
  const ex = await say(ADMIN, "/消費 飲料 300");
  ok(ex.includes("已記錄") && ex.includes("額外消費 -300") && ex.includes("（阿美）") && ex.includes("飲料 300"), ex);
  ok((await say(OTHER, "/消費")).includes("額外消費 -300"), "所有人都能看帳");
  eq((await api(OTHER, "expense", { code, item: "宵夜", amount: 200 })).status, 403);
  eq((await api(ADMIN, "expense", { code, item: "", amount: 200 })).status, 400);
  eq((await api(ADMIN, "expense", { code, item: "宵夜", amount: 200, spent_at: "2026-02-01T12:00:00Z" })).status, 200);
  let er = (await api(ADMIN, `room?code=${code}`)).body;
  eq(er.expenses.map((e: any) => [e.item, e.amount]), [["飲料", 300], ["宵夜", 200]]);
  ok(er.houseMonths.some((m: any) => m.month === "2026-02" && m.expense === 200));
  eq(er.totalGames, rm.totalGames - 1, "消費不算場數");
  const snack = er.expenses.find((e: any) => e.item === "宵夜");
  eq((await api(OTHER, "expense/delete", { code, expense_id: snack.id })).status, 403);
  eq((await api(ADMIN, "expense/delete", { code, expense_id: snack.id })).status, 200);
  eq((await api(ADMIN, "expense/delete", { code, expense_id: snack.id })).status, 404);
  er = (await api(ADMIN, `room?code=${code}`)).body;
  eq(er.expenses.length, 1);
  const merged = "/記 小明+300 阿華-200 老王-100 甲-100 乙+200 丙-100 丁-150 阿美+150";
  ok((await say(ADMIN, merged)).includes("小明 +300"));
  let rs = (await api(ADMIN, `room?code=${code}`)).body;
  const mg = rs.recent[0];
  eq(mg.scores.length, 8);
  const pid = (n: string) => rs.players.find((p: any) => p.name === n).id;
  const T = (rows: [string, number][]) => rows.map(([n, points]) => ({ player_id: pid(n), points }));
  const good = [
    T([["小明", 300], ["阿華", -200], ["老王", -100], ["甲", -100], ["阿美", 100]]),
    T([["乙", 200], ["丙", -100], ["丁", -150], ["阿美", 50]]),
  ];
  eq((await api(OTHER, "game/split", { code, game_id: mg.id, tables: good })).status, 403);
  const bad = [good[0], T([["乙", 200], ["丙", -100], ["丁", -100], ["阿美", 0]])];
  ok(String((await api(ADMIN, "game/split", { code, game_id: mg.id, tables: bad })).body.error).length > 0);
  const total0 = rs.totalGames;
  eq((await api(ADMIN, "game/split", { code, game_id: mg.id, tables: good })).status, 200);
  rs = (await api(ADMIN, `room?code=${code}`)).body;
  eq(rs.totalGames, total0 + 1);
  const parts = rs.recent.filter((g: any) => /第[12]桌/.test(g.note ?? ""));
  eq(parts.length, 2);
  eq(parts.map((g: any) => g.scores.length).sort(), [4, 5]);
  eq((await api(ADMIN, "game/split", { code, game_id: mg.id, tables: good })).status, 404, "原本那場已經不在了");
  for (const g of parts) await api(ADMIN, "game/delete", { code, game_id: g.id });
  await say(ADMIN, "/取消台費 阿美");

  // 台費帳戶
  ok((await say(OTHER, "/設台費 阿美")).includes("只有管理員")); // OTHER 此時還不是管理員
  ok((await say(ADMIN, "/設台費")).includes("目前的台費帳戶：沒有"));
  ok((await say(ADMIN, "/設台費 阿美")).includes("設為台費帳戶"));
  ok((await say(ADMIN, "/分析 阿美")).includes("台費帳戶"));
  eq((await api(OTHER, `analysis?code=${code}&player=${id("阿美")}`)).status, 404);
  const mingAn = (await api(OTHER, `analysis?code=${code}&player=${id("小明")}`)).body;
  ok(!mingAn.partners.some((p: any) => p.name === "阿美"), "分析裡不能出現台費帳戶");
  eq((await api(OTHER, `room?code=${code}`)).body.players.find((p: any) => p.name === "阿美").house, true);
  ok((await say(ADMIN, "/取消台費 阿美")).includes("恢復成一般玩家"));

  // 記分後只回這一場，不附累計
  const recMsgs = (await say(ADMIN, "/記 小明+5 阿華-5"), sent.at(-1)!.body.messages);
  eq(recMsgs.length, 1);
  ok(!JSON.stringify(recMsgs).includes("累計"));
  await say(ADMIN, "/撤銷");

  // 多位管理員：@標記 或 已認領的名字都可以
  const THIRD = "Uthird";
  ok((await say(OTHER, "/設管理員 @x", [THIRD])).includes("只有管理員"));
  ok((await say(ADMIN, "/設管理員")).includes("用法"));
  ok((await say(ADMIN, "/設管理員 阿華")).includes("已設為管理員"), "OTHER 認領了阿華，可以用名字設定");
  ok((await say(OTHER, "/加人 新人")).includes("已加入：新人"), "新管理員可以加人");
  eq((await api(OTHER, `room?code=${code}`)).body.me.isAdmin, true);
  ok((await say(OTHER, "/設管理員 @x", [THIRD])).includes("已設為管理員"));
  ok((await say(ADMIN, "/管理員")).includes("房主"));
  ok((await say(OTHER, "/移除管理員 @x", [ADMIN])).includes("房主不能移除"));
  ok((await say(ADMIN, "/移除管理員 @x", [THIRD])).includes("已移除管理員"));
  ok((await say(THIRD, "/記 小明+1 阿華-1")).includes("只有管理員"));

  ok((await say(ADMIN, "/撤銷")).includes("已刪除最後一場"));
  const lastMsgs = sent.at(-1)!.body.messages;
  eq(lastMsgs.at(-1).quickReply.items.map((i: any) => i.action.text),
    ["/選單", "/戰績", "/最近", "/分析", "/記分頁", "/撤銷", "/說明"], "回覆的最後一則要帶快速回覆按鈕");
  eq((await api(ADMIN, `room?code=${code}`)).body.totalGames, 2);

  // 資料真的寫進檔案
  const saved = JSON.parse(await Deno.readTextFile(dataFile));
  eq(saved.rooms.length, 1);
  eq(saved.games.length, 2);

  // 刪房：非管理員不行、要二次確認、刪完可以重開
  ok((await say(THIRD, "/刪房 確認")).includes("只有管理員")); // OTHER 已是管理員，改用非管理員測
  ok((await say(ADMIN, "/刪房")).includes("確定要刪除房間「週五麻將」"));
  ok((await say(ADMIN, "/刪房 確認")).includes("已刪除房間"));
  ok((await say(ADMIN, "/戰績")).includes("還沒有房間"));
  const after = JSON.parse(await Deno.readTextFile(dataFile));
  eq([after.rooms.length, after.players.length, after.games.length, after.scores.length], [0, 0, 0, 0]);
  ok((await say(ADMIN, "/開房 新房")).includes("已建立房間「新房」"));
  console.log = origLog;
});
