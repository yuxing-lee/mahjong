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
    ["/戰績", "/最近", "/分析", "/記分頁", "/撤銷", "/說明"], "回覆的最後一則要帶快速回覆按鈕");
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
