// 麻將計分 LINE 版：Bot webhook + LIFF API
//
// 路由（本機是 http://localhost:8000/...，Supabase 上是 .../functions/v1/mj/...）：
//   POST webhook          ← LINE Messaging API webhook
//   GET  api/room?code=   ← LIFF 讀取房間資料
//   GET  api/analysis?code=&player=  ← 個人分析
//   POST api/game         ← 管理員記一場
//   POST api/game/delete  ← 管理員刪一場
//   POST api/game/date    ← 管理員改某場的日期
//   POST api/player       ← 管理員加玩家
//   POST api/claim        ← 玩家認領自己的名字
//
// 環境變數：
//   STORE=file（預設，存在 DATA_FILE，預設 ./data.json）或 supabase
//   LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN  (Messaging API channel)
//   LINE_LOGIN_CHANNEL_ID                           (LIFF 所在的 LINE Login channel)
//   LIFF_ID
//   PORT（本機執行時的埠號，預設 8000）
//   DEV_FAKE_LOGIN=1（僅本機測試：API 接受 "dev:<userId>" 當作登入，正式環境不要開）
// 沒設定 LINE_CHANNEL_ACCESS_TOKEN 時，Bot 要送的訊息只會印在 console，方便本機測試。

import {
  type Analysis, computeAnalysis, computeStandings, cumulativeSeries, formatGameLine, makeRoomCode,
  parseScoreText, signed, type Standing, validateEntries,
} from "./logic.ts";
import { isRoomAdmin, makeStore, parsePlayedAt, type Room, UserError } from "./store.ts";

const env = (k: string) => Deno.env.get(k) ?? "";
const store = await makeStore();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function cleanNames(names: string[]) {
  return [...new Set(names.map((n) => n.trim()).filter(Boolean))]
    .filter((n) => n.length <= 20 && !/[0-9０-９+\-＋－]/.test(n));
}

// ───────────────────────── LINE API ─────────────────────────

type Message = Record<string, unknown>;

async function lineCall(path: string, body: unknown) {
  const token = env("LINE_CHANNEL_ACCESS_TOKEN");
  if (!token) {
    console.log(`[LINE ${path}]`, JSON.stringify(body));
    return;
  }
  const res = await fetch(`https://api.line.me/v2/bot/message/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`LINE ${path} failed`, res.status, await res.text());
}

// 快速回覆按鈕：出現在輸入框上方，點了就會用使用者的名義送出指令（群組也能用）
const QUICK_COMMANDS = ["/戰績", "/最近", "/分析", "/記分頁", "/撤銷", "/說明"];
const quickReply = {
  items: QUICK_COMMANDS.map((cmd) => ({
    type: "action",
    action: { type: "message", label: cmd.slice(1), text: cmd },
  })),
};

const reply = (replyToken: string, messages: Message[], withQuickReply = true) => {
  const msgs = messages.slice(0, 5);
  // 只掛在最後一則訊息上（LINE 只看最後一則的 quickReply）
  if (msgs.length && withQuickReply) msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], quickReply };
  return lineCall("reply", { replyToken, messages: msgs });
};
async function lineGet(path: string) {
  const token = env("LINE_CHANNEL_ACCESS_TOKEN");
  if (!token) return null;
  const res = await fetch(`https://api.line.me/v2/bot/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? await res.json() : null;
}

/** 群組成員的 LINE 顯示名稱；拿不到就用認領的玩家名字 */
async function displayName(groupId: string | null, roomId: string, lineUserId: string) {
  if (groupId) {
    const p = await lineGet(`group/${groupId}/member/${lineUserId}`).catch(() => null);
    if (p?.displayName) return p.displayName as string;
  }
  const claimed = (await store.playersOf(roomId)).find((pl) => pl.line_user_id === lineUserId);
  return claimed?.name ?? "（未知成員）";
}

const push = (to: string, messages: Message[]) =>
  lineCall("push", { to, messages: messages.slice(0, 5) });

const text = (t: string): Message => ({ type: "text", text: t.slice(0, 4900) });

export async function signBody(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

async function verifyIdToken(req: Request): Promise<{ userId: string }> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "缺少登入資訊");
  if (env("DEV_FAKE_LOGIN") === "1" && token.startsWith("dev:")) return { userId: token.slice(4) };
  const res = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: token, client_id: env("LINE_LOGIN_CHANNEL_ID") }),
  });
  if (!res.ok) {
    // 常見：IdToken expired.（過期）、Invalid IdToken Audience.（LINE_LOGIN_CHANNEL_ID 設錯）
    const detail = await res.json().catch(() => ({}));
    const reason = String(detail.error_description ?? detail.error ?? res.status);
    console.error("LINE id_token verify failed:", reason);
    if (/expired/i.test(reason)) throw new HttpError(401, "登入已過期，請關掉頁面重新開啟");
    if (/audience/i.test(reason)) throw new HttpError(401, "LINE Login Channel ID 設定不符，請檢查 LINE_LOGIN_CHANNEL_ID");
    throw new HttpError(401, `LINE 登入驗證失敗：${reason}`);
  }
  const info = await res.json();
  return { userId: info.sub };
}

const liffUrl = (room: Room) => `https://liff.line.me/${env("LIFF_ID") || "2011866186-iudTebek"}?room=${room.code}`;

// ───────────────────────── 訊息樣式 ─────────────────────────

function standingsFlex(room: Room, list: Standing[], title = "目前戰績"): Message {
  const rows = list.filter((s) => s.games > 0).slice(0, 12).map((s, i) => ({
    type: "box", layout: "horizontal", spacing: "sm",
    contents: [
      { type: "text", text: `${i + 1}`, size: "sm", color: "#999999", flex: 1 },
      { type: "text", text: s.name, size: "sm", flex: 4, weight: i === 0 ? "bold" : "regular" },
      { type: "text", text: `${s.games}場 ${Math.round(s.winRate * 100)}%`, size: "xs", color: "#888888", flex: 4, align: "end", gravity: "center" },
      { type: "text", text: signed(s.total), size: "sm", flex: 3, align: "end",
        color: s.total > 0 ? "#C0392B" : s.total < 0 ? "#2E7D32" : "#555555", weight: "bold" },
    ],
  }));
  return {
    type: "flex",
    altText: `${room.name}｜${title}`,
    contents: {
      type: "bubble",
      body: {
        type: "box", layout: "vertical", spacing: "md",
        contents: [
          { type: "text", text: room.name, weight: "bold", size: "lg" },
          { type: "text", text: title, size: "xs", color: "#888888" },
          { type: "separator" },
          ...(rows.length ? rows : [{ type: "text", text: "還沒有任何對局", size: "sm", color: "#888888" }]),
        ],
      },
      footer: {
        type: "box", layout: "vertical",
        contents: [{
          type: "button", style: "primary", color: "#1F2937", height: "sm",
          action: { type: "uri", label: "開啟記分頁", uri: liffUrl(room) },
        }],
      },
    },
  };
}

const pct = (r: number) => `${Math.round(r * 100)}%`;
/** 夥伴、剋星這類「挑一個代表」的統計，至少要同桌幾場才列出 */
const MIN_PAIR_GAMES = 3;

function analysisText(a: Analysis, room: Room) {
  if (!a.games) return `${a.name} 還沒有任何對局。`;
  const pairs = a.partners.filter((p) => p.games >= MIN_PAIR_GAMES);
  const rivals = a.rivals.filter((p) => p.games >= MIN_PAIR_GAMES);
  const streak = a.streak > 0 ? `連勝 ${a.streak} 場 🔥` : a.streak < 0 ? `連敗 ${-a.streak} 場` : "—";
  const lines = [
    `📊 ${a.name} 的分析（${a.games} 場）`,
    `勝率 ${pct(a.winRate)}｜場均 ${signed(a.avg)}｜累計 ${signed(a.total)}`,
    `近 ${a.last10Games} 場場均 ${signed(a.last10Avg)}｜目前 ${streak}`,
  ];
  if (pairs.length) {
    const b = pairs[0];
    lines.push(`🤝 最順的同桌：${b.name}（${b.games} 場，勝率 ${pct(b.winRate)}，場均 ${signed(b.avg)}）`);
  }
  if (rivals.length) {
    const top = rivals[0], low = rivals[rivals.length - 1];
    if (low.avgDiff < 0) lines.push(`😈 剋星：${low.name}（同桌 ${low.games} 場，平均輸他 ${-low.avgDiff}）`);
    if (top.avgDiff > 0 && top !== low) lines.push(`💰 提款機：${top.name}（同桌 ${top.games} 場，平均贏他 ${top.avgDiff}）`);
  }
  if (!pairs.length) lines.push(`（同桌滿 ${MIN_PAIR_GAMES} 場才會分析夥伴和對手）`);
  lines.push("", `完整分析：記分頁 → 分析\n${liffUrl(room)}`);
  return lines.join("\n");
}

/** 台灣時間的 M/D */
function mdTaipei(iso: string) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600e3);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function gameResultText(room: Room, entries: { name: string; points: number }[], gameNo: number, playedAt?: string) {
  // 補記以前的牌局時，標上日期
  const date = playedAt && mdTaipei(playedAt) !== mdTaipei(new Date().toISOString()) ? `（${mdTaipei(playedAt)}）` : "";
  return `🀄 ${room.name}｜第 ${gameNo} 場${date}\n${formatGameLine(entries)}`;
}

const HELP = [
  "🀄 麻將計分小幫手",
  "",
  "/開房 房間名稱　把這個群組設成計分房（建房的人是管理員）",
  "/加人 小明 阿華 老王　加入玩家",
  "/記 小明+100 阿華-30 老王-70　記一場（總和要是 0）",
  "/戰績　看排行榜",
  "/最近　看最近 5 場",
  "/分析 名字　某人的勝率、最順的同桌、剋星（不打名字＝看自己）",
  "/撤銷　刪掉最後一場（管理員）",
  "/刪房　刪除這個房間和所有紀錄（管理員）",
  "/設台費 名字　把場主設備錢之類的帳戶排除在分析外（管理員）",
  "/設管理員 @某人　把他設成管理員（管理員）",
  "/移除管理員 @某人　取消他的管理員（管理員）",
  "/管理員　看目前有哪些管理員",
  "/記分頁　開啟記分頁面",
  "",
  "＊輸入框上方的按鈕點了就會送出指令",
  "＊加人、記分、撤銷、刪房、設管理員只有管理員能操作",
  "＊分數只作為遊戲紀錄，不具任何金錢價值",
].join("\n");

// ───────────────────────── Webhook ─────────────────────────

/** 從 @標記 或「已認領的玩家名字」找出要操作的 LINE 使用者 */
// deno-lint-ignore no-explicit-any
async function resolveTargets(ev: any, room: Room): Promise<string[]> {
  // deno-lint-ignore no-explicit-any
  const mentioned = ((ev.message?.mention?.mentionees ?? []) as any[])
    .filter((m) => m.type !== "all" && m.userId && !m.isSelf)
    .map((m) => m.userId as string);
  if (mentioned.length) return [...new Set(mentioned)];
  const names = String(ev.message?.text ?? "").split(/\s+/).slice(1).map((n) => n.replace(/^@/, "")).filter(Boolean);
  const players = await store.playersOf(room.id);
  return [...new Set(names.map((n) => players.find((p) => p.name === n)?.line_user_id).filter((x): x is string => !!x))];
}

// deno-lint-ignore no-explicit-any
async function handleEvent(ev: any) {
  const src = ev.source ?? {};
  const groupId: string | undefined = src.groupId ?? src.roomId;
  const userId: string | undefined = src.userId;

  if (ev.type === "join") return void await reply(ev.replyToken, [text(HELP)]);
  if (ev.type === "leave" && groupId) return void await store.unlinkGroup(groupId);
  if (ev.type !== "message" || ev.message?.type !== "text") return;

  const raw: string = ev.message.text.trim();
  if (!raw.startsWith("/")) return; // 不是指令就不回，避免洗版
  const [cmd, ...rest] = raw.split(/\s+/);
  const args = rest.join(" ");
  const r = (msgs: Message[]) => reply(ev.replyToken, msgs);

  try {
    if (cmd === "/說明" || cmd === "/help") return void await r([text(HELP)]);

    if (!groupId) {
      return void await r([text("請把我加進牌友的 LINE 群組，再在群組裡輸入「/開房 房間名稱」開始使用。")]);
    }

    const room = await store.roomByGroup(groupId);
    const isAdmin = !!room && await isRoomAdmin(store, room, userId);

    if (cmd === "/開房") {
      if (room) return void await r([text(`這個群組已經有房間「${room.name}」了。\n記分頁：${liffUrl(room)}`)]);
      if (!userId) return void await r([text("讀不到你的 LINE 身分，請先把我加為好友再試一次。")]);
      const created = await store.createRoom({
        code: makeRoomCode(), name: args.slice(0, 30) || "麻將房",
        line_group_id: groupId, admin_line_user_id: userId,
      });
      return void await r([text(
        `✅ 已建立房間「${created.name}」，你是管理員。\n\n下一步：/加人 小明 阿華 老王 阿美\n記分頁：${liffUrl(created)}`,
      )]);
    }

    if (!room) return void await r([text("這個群組還沒有房間，請輸入「/開房 房間名稱」。")]);

    switch (cmd) {
      case "/記分頁":
      case "/選單":
        return void await r([text(`📋 ${room.name} 記分頁：\n${liffUrl(room)}`)]);

      case "/戰績":
      case "/排行": {
        const [players, { scores }] = await Promise.all([store.playersOf(room.id), store.gamesOf(room.id)]);
        return void await r([standingsFlex(room, computeStandings(players, scores))]);
      }

      case "/管理員": {
        const ids = [room.admin_line_user_id, ...(await store.adminsOf(room.id))];
        const names = await Promise.all(ids.map((id) => displayName(room.line_group_id, room.id, id)));
        return void await r([text(`👑 ${room.name} 的管理員\n${names.map((n, i) => `${i === 0 ? "房主" : "管理員"}：${n}`).join("\n")}`)]);
      }

      case "/分析": {
        const [players, { games, scores }] = await Promise.all([store.playersOf(room.id), store.gamesOf(room.id)]);
        const name = args.replace(/^@/, "").trim();
        const target = name
          ? players.find((p) => p.name === name)
          : players.find((p) => p.line_user_id && p.line_user_id === userId);
        if (!target) {
          return void await r([text(name
            ? `找不到玩家「${name}」。目前玩家：${players.map((p) => p.name).join("、")}`
            : `用法：/分析 名字\n或先到記分頁「認領」自己的名字，之後打 /分析 就會看自己的。`)]);
        }
        if (target.is_house) return void await r([text(`「${target.name}」是台費帳戶，不列入分析。`)]);
        return void await r([text(analysisText(computeAnalysis(target.id, players, games, scores)!, room))]);
      }

      case "/最近": {
        const [players, { games, scores }] = await Promise.all([store.playersOf(room.id), store.gamesOf(room.id)]);
        if (!games.length) return void await r([text("還沒有任何對局。")]);
        const names = new Map(players.map((p) => [p.id, p.name]));
        const lines = games.slice(-5).map((g, i, arr) => {
          const no = games.length - arr.length + i + 1;
          const es = scores.filter((s) => s.game_id === g.id)
            .map((s) => ({ name: names.get(s.player_id) ?? "?", points: s.points }));
          return `#${no} ${formatGameLine(es)}`;
        });
        return void await r([text(`🀄 ${room.name}｜最近 ${lines.length} 場\n${lines.join("\n")}`)]);
      }
    }

    if (["/加人", "/記", "/撤銷", "/刪房", "/設管理員", "/移除管理員", "/設台費", "/取消台費"].includes(cmd) && !isAdmin) {
      return void await r([text("只有管理員可以操作這個指令。")]);
    }

    switch (cmd) {
      case "/加人": {
        const names = cleanNames(args.split(/[\s,，、]+/));
        if (!names.length) return void await r([text("用法：/加人 小明 阿華 老王（名字不能有數字或 +、-）")]);
        const added = await store.insertPlayers(room.id, names);
        const all = (await store.playersOf(room.id)).map((p) => p.name);
        return void await r([text(
          (added.length ? `✅ 已加入：${added.join("、")}` : "沒有新加入的玩家（名字已存在）") +
            `\n目前玩家：${all.join("、")}`,
        )]);
      }

      case "/記": {
        const players = await store.playersOf(room.id);
        const check = validateEntries(parseScoreText(args), players);
        if (!check.ok) return void await r([text(`⚠️ ${check.error}`)]);
        await store.recordGame(room.id, userId!, check.entries.map((e) => ({ player_id: e.player.id, points: e.points })), "");
        const { games } = await store.gamesOf(room.id);
        return void await r([
          text(gameResultText(room, check.entries.map((e) => ({ name: e.player.name, points: e.points })), games.length)),
        ]);
      }

      case "/撤銷": {
        const ok = await store.deleteLastGame(room.id);
        return void await r([text(ok ? "↩️ 已刪除最後一場。" : "沒有可以撤銷的對局。")]);
      }

      case "/設台費":
      case "/取消台費": {
        const players = await store.playersOf(room.id);
        const name = args.replace(/^@/, "").trim();
        const target = players.find((p) => p.name === name);
        if (!target) {
          const house = players.filter((p) => p.is_house).map((p) => p.name);
          return void await r([text(
            `用法：${cmd} 名字\n台費帳戶（例如場主的設備錢）照樣記分，但不列入個人分析。` +
              `\n目前的台費帳戶：${house.length ? house.join("、") : "沒有"}`,
          )]);
        }
        const on = cmd === "/設台費";
        await store.setHouse(room.id, target.id, on);
        return void await r([text(on
          ? `✅ 「${target.name}」設為台費帳戶，之後不列入分析。`
          : `✅ 「${target.name}」恢復成一般玩家。`)]);
      }

      case "/設管理員":
      case "/移除管理員": {
        const targets = await resolveTargets(ev, room);
        if (!targets.length) {
          return void await r([text(
            `用法：${cmd} @某人（在群組裡用 @ 標記他）\n` +
              `或是對方先在記分頁「認領」自己的名字，再輸入：${cmd} 名字`,
          )]);
        }
        const done: string[] = [];
        const skipped: string[] = [];
        for (const t of targets) {
          const name = await displayName(room.line_group_id, room.id, t);
          if (cmd === "/設管理員") {
            if (t === room.admin_line_user_id || (await store.adminsOf(room.id)).includes(t)) skipped.push(`${name}（已經是管理員）`);
            else { await store.addAdmin(room.id, t, userId!); done.push(name); }
          } else {
            if (t === room.admin_line_user_id) skipped.push(`${name}（房主不能移除）`);
            else if (await store.removeAdmin(room.id, t)) done.push(name);
            else skipped.push(`${name}（本來就不是管理員）`);
          }
        }
        const verb = cmd === "/設管理員" ? "設為管理員" : "移除管理員";
        return void await r([text([
          done.length ? `✅ 已${verb}：${done.join("、")}` : "",
          skipped.length ? `略過：${skipped.join("、")}` : "",
        ].filter(Boolean).join("\n"))]);
      }

      case "/刪房": {
        if (args.trim() !== "確認") {
          const { games } = await store.gamesOf(room.id);
          return void await reply(ev.replyToken, [{
            ...text(`⚠️ 確定要刪除房間「${room.name}」嗎？\n所有玩家和 ${games.length} 場紀錄都會一起刪除，無法復原。\n\n確定的話請輸入：/刪房 確認`),
            quickReply: { items: [
              { type: "action", action: { type: "message", label: "確認刪除", text: "/刪房 確認" } },
              { type: "action", action: { type: "message", label: "取消", text: "/戰績" } },
            ] },
          }], false);
        }
        await store.deleteRoom(room.id);
        return void await reply(ev.replyToken, [text(`🗑️ 已刪除房間「${room.name}」。\n要重新開始請輸入：/開房 房間名稱`)], false);
      }
    }

    await r([text(`看不懂「${cmd}」，輸入 /說明 看所有指令。`)]);
  } catch (e) {
    if (e instanceof UserError) return void await r([text(`⚠️ ${e.message}`)]);
    throw e;
  }
}

async function handleWebhook(req: Request) {
  const body = await req.text();
  const expected = await signBody(body, env("LINE_CHANNEL_SECRET"));
  if (req.headers.get("x-line-signature") !== expected) {
    return new Response("bad signature", { status: 401 });
  }
  const { events = [] } = JSON.parse(body);
  // 單一事件失敗不影響其他事件，也讓 LINE 收到 200
  await Promise.all(events.map((ev: unknown) =>
    handleEvent(ev).catch((e) => console.error("event error", e))
  ));
  return new Response("ok");
}

// ───────────────────────── LIFF API ─────────────────────────

async function handleApi(req: Request, route: string) {
  const me = await verifyIdToken(req);
  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const code = String(body.code ?? url.searchParams.get("code") ?? "");
  const room = code ? await store.roomByCode(code) : null;
  if (!room) throw new HttpError(404, "找不到這個房間");
  const isAdmin = await isRoomAdmin(store, room, me.userId);
  const requireAdmin = () => { if (!isAdmin) throw new HttpError(403, "只有管理員可以操作"); };

  if (route === "room" && req.method === "GET") {
    const [players, { games, scores }] = await Promise.all([store.playersOf(room.id), store.gamesOf(room.id)]);
    const names = new Map(players.map((p) => [p.id, p.name]));
    const recent = games.map((g, i) => ({ g, no: i + 1 })).slice(-30).reverse().map(({ g, no }) => ({
      id: g.id, played_at: g.played_at, note: g.note, no,
      scores: scores.filter((s) => s.game_id === g.id)
        .map((s) => ({ name: names.get(s.player_id) ?? "?", points: s.points }))
        .sort((a, b) => b.points - a.points),
    }));
    return json({
      room: { name: room.name, code: room.code, linked: !!room.line_group_id },
      me: { isAdmin, player: players.find((p) => p.line_user_id === me.userId)?.id ?? null },
      players: players.map((p) => ({ id: p.id, name: p.name, claimed: !!p.line_user_id, house: !!p.is_house })),
      standings: computeStandings(players, scores),
      series: cumulativeSeries(players, games, scores),
      recent,
      totalGames: games.length,
    });
  }

  if (route === "analysis" && req.method === "GET") {
    const [players, { games, scores }] = await Promise.all([store.playersOf(room.id), store.gamesOf(room.id)]);
    const a = computeAnalysis(String(url.searchParams.get("player") ?? ""), players, games, scores);
    if (!a) throw new HttpError(404, "找不到這位玩家，或他是台費帳戶");
    return json({ ...a, minPairGames: MIN_PAIR_GAMES });
  }

  if (route === "game" && req.method === "POST") {
    requireAdmin();
    const entries = (Array.isArray(body.scores) ? body.scores : [])
      .map((s: { player_id: unknown; points: unknown }) => ({ player_id: String(s.player_id), points: Math.trunc(Number(s.points)) }))
      .filter((s: { points: number }) => Number.isFinite(s.points));
    const playedAt = parsePlayedAt(body.played_at);
    const gameId = await store.recordGame(room.id, me.userId, entries, String(body.note ?? "").slice(0, 100), playedAt);

    if (room.line_group_id) {
      const [players, { games }] = await Promise.all([store.playersOf(room.id), store.gamesOf(room.id)]);
      const names = new Map(players.map((p) => [p.id, p.name]));
      const line = entries.map((e: { player_id: string; points: number }) => ({ name: names.get(e.player_id) ?? "?", points: e.points }));
      // 補記的牌局依日期排序，不一定是最後一場
      const no = games.findIndex((g) => g.id === gameId) + 1 || games.length;
      // 主動推播會計入官方帳號訊息額度；只推一則文字（累計請看 /戰績）
      await push(room.line_group_id, [text(gameResultText(room, line, no, playedAt))]);
    }
    return json({ ok: true });
  }

  if (route === "game/date" && req.method === "POST") {
    requireAdmin();
    const playedAt = parsePlayedAt(body.played_at);
    if (!playedAt) throw new HttpError(400, "請選擇日期");
    if (!(await store.setGameDate(room.id, String(body.game_id), playedAt))) throw new HttpError(404, "找不到這一場");
    return json({ ok: true });
  }

  if (route === "game/delete" && req.method === "POST") {
    requireAdmin();
    await store.deleteGame(room.id, String(body.game_id));
    return json({ ok: true });
  }

  if (route === "player" && req.method === "POST") {
    requireAdmin();
    const names = cleanNames([String(body.name ?? "")]);
    if (!names.length) throw new HttpError(400, "名字不能空白，也不能有數字或 +、-");
    const added = await store.insertPlayers(room.id, names);
    if (!added.length) throw new HttpError(400, "這個名字已經存在");
    return json({ ok: true });
  }

  if (route === "claim" && req.method === "POST") {
    await store.claimPlayer(room.id, String(body.player_id), me.userId);
    return json({ ok: true });
  }

  throw new HttpError(404, "not found");
}

// ───────────────────────── 入口 ─────────────────────────

export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const path = new URL(req.url).pathname.replace(/^\/(functions\/v1\/)?(mj\/?)?/, "");
  try {
    if (path === "webhook" && req.method === "POST") return await handleWebhook(req);
    if (path.startsWith("api/")) return await handleApi(req, path.slice(4));
    if (path === "" || path === "health") return json({ ok: true });
    return json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    if (e instanceof UserError) return json({ error: e.message }, 400);
    console.error(e);
    return json({ error: "伺服器錯誤" }, 500);
  }
}

if (import.meta.main) {
  // 本機用 `deno task dev`（會設定 PORT）；Supabase 上沒有 PORT，由平台決定埠號
  if (env("PORT")) Deno.serve({ port: Number(env("PORT")) }, handler);
  else Deno.serve(handler);
}
