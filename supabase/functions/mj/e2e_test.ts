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
async function say(user: string, msg: string) {
  const body = JSON.stringify({ events: [{
    type: "message", replyToken: "rt", source: { type: "group", groupId: GROUP, userId: user },
    message: { type: "text", text: msg },
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

  eq((await api(OTHER, "claim", { code, player_id: id("阿華") })).status, 200);
  eq((await api(OTHER, "claim", { code, player_id: id("老王") })).body.error, "你已經認領過了");
  eq((await api(OTHER, `room?code=${code}`)).body.me.player, id("阿華"));

  ok((await say(ADMIN, "/撤銷")).includes("已刪除最後一場"));
  const lastMsgs = sent.at(-1)!.body.messages;
  eq(lastMsgs.at(-1).quickReply.items.map((i: any) => i.action.text),
    ["/戰績", "/最近", "/記分頁", "/撤銷", "/說明"], "回覆的最後一則要帶快速回覆按鈕");
  eq((await api(ADMIN, `room?code=${code}`)).body.totalGames, 2);

  // 資料真的寫進檔案
  const saved = JSON.parse(await Deno.readTextFile(dataFile));
  eq(saved.rooms.length, 1);
  eq(saved.games.length, 2);
  console.log = origLog;
});
