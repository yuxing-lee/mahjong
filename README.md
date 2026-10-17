# 麻將計分 LINE 版（第一版）

LINE 群組 Bot ＋ LIFF 記分頁。管理員一個人記分就能運作，其他牌友不用加好友，想看個人戰績的人再自己「認領」名字。

資料預設存在**本機 JSON 檔**，不需要任何雲端資料庫。Supabase 版完整保留，之後把 `STORE` 改成 `supabase` 就能切換。

```
mahjong-line/
├─ deno.json                          dev / test / check 指令
├─ .env.example                       環境變數範本
├─ liff/index.html                    LIFF 記分頁（單一檔案，內建試玩模式）
└─ supabase/
   ├─ migrations/001_init.sql         Supabase 資料表（改用 Supabase 時才需要）
   └─ functions/mj/
      ├─ index.ts                     Bot webhook + LIFF API
      ├─ logic.ts                     解析分數、計算戰績
      ├─ store.ts                     儲存介面，依 STORE 選擇實作
      ├─ store_file.ts                JSON 檔儲存（預設）
      ├─ store_supabase.ts            Supabase 儲存（保留）
      ├─ logic_test.ts / e2e_test.ts  測試
```

## 先玩看看（不用 LINE、不用伺服器）

直接用瀏覽器打開 `liff/index.html`。`LIFF_ID` 還沒設定時，頁面會進入**試玩模式**：內建 4 位玩家、5 場範例資料，可以試記分、補平、排行、走勢、紀錄和認領，資料只存在這台裝置。網址加上 `?demo=1` 也可以強制進入試玩模式。

## 群組指令

| 指令 | 誰能用 | 說明 |
|---|---|---|
| `/開房 週五麻將` | 任何人（建的人＝管理員） | 把群組設成計分房 |
| `/加人 小明 阿華 老王 阿美` | 管理員 | 加玩家 |
| `/記 小明+100 阿華-30 老王-70` | 管理員 | 記一場，總和必須是 0（也接受「小明 100 阿華 -30」和全形數字） |
| `/戰績` | 所有人 | 排行榜卡片（附「開啟記分頁」按鈕） |
| `/最近` | 所有人 | 最近 5 場 |
| `/撤銷` | 管理員 | 刪最後一場 |
| `/刪房` | 管理員 | 刪除房間和所有紀錄（會先要求輸入 `/刪房 確認`） |
| `/設管理員 @某人` | 管理員 | 把他設成管理員（也可以用已認領的名字：`/設管理員 阿華`） |
| `/移除管理員 @某人` | 管理員 | 取消管理員（房主不能被移除） |
| `/管理員` | 所有人 | 列出房主和管理員 |
| `/記分頁` | 所有人 | 取得 LIFF 連結 |
| `/說明` | 所有人 | 指令列表 |

不是 `/` 開頭的訊息 Bot 一律不回，不會洗版。指令都用「回覆」，不計入官方帳號的訊息額度；只有從記分頁送出一場時會「主動推播」一則到群組，這會計入額度。

## 本機執行（JSON 檔模式）

需要 [Deno 2](https://deno.com)。

```bash
cp .env.example .env      # 填入 LINE 的值；STORE 維持 file
deno task dev             # http://localhost:8000，資料寫在 ./data.json
deno task test            # 單元測試 + 端到端測試
```

LINE 必須用 HTTPS 才能呼叫 webhook，本機可以開一條通道：

```bash
cloudflared tunnel --url http://localhost:8000   # 或 ngrok http 8000
```

- Webhook URL：`https://<通道網址>/webhook`
- 記分頁的 `API_BASE`：`https://<通道網址>/api`

沒填 `LINE_CHANNEL_ACCESS_TOKEN` 時，Bot 要送出的訊息只會印在終端機，方便先測流程。

> JSON 檔模式適合試做和小規模使用。伺服器必須一直開著，資料才會在；要 24 小時運作，可以放在家裡常開的電腦或 VPS，或改用 Supabase。記得定期備份 `data.json`。

## LINE 設定

兩個 channel 必須建在**同一個 Provider** 底下，userId 才會對得上。

1. **Messaging API channel**（在 LINE Official Account Manager 建好官方帳號後啟用）
   - 記下 **Channel secret**，並發行 **Channel access token（long-lived）**
   - 填入 Webhook URL，並開啟「Use webhook」
   - 官方帳號設定：開啟「**允許加入群組或多人聊天室**」，關閉「自動回應訊息」和「加入好友的歡迎訊息」
2. **LINE Login channel**
   - 記下 **Channel ID**（填入 `LINE_LOGIN_CHANNEL_ID`）
   - LIFF 分頁 → 新增：Size 選 `Full`，Scope 勾選 `openid`、`profile`，Endpoint URL 填記分頁的網址
   - 記下 **LIFF ID**，填入 `.env` 和 `liff/index.html`
3. 記分頁 `liff/index.html` 要放在任何 HTTPS 靜態空間，例如 Vercel（`npx vercel deploy liff --prod`）或 GitHub Pages。

### 測試流程
1. 把官方帳號拉進牌友群組，Bot 會貼出說明
2. 依序輸入 `/開房 週五麻將`、`/加人 ...`、`/記 ...`、`/戰績`
3. 點卡片上的「開啟記分頁」，試試記分、走勢圖、紀錄、認領

## 之後切換到 Supabase

1. 建立專案，執行 `supabase/migrations/001_init.sql`
2. 部署 `supabase/functions/mj`，並**關閉 Verify JWT**（webhook 用 LINE 簽章驗證，API 用 LINE ID token 驗證）
3. 在 Edge Function secrets 設定 `STORE=supabase` 和四個 LINE 變數（`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 由平台自動提供）
4. 把 Webhook URL 和 `API_BASE` 改成 `https://<專案ref>.supabase.co/functions/v1/mj/...`

如果想把 `data.json` 的舊資料搬過去，再請 Claude 寫一支匯入腳本。

## 之後可以加的功能
- 多位管理員、轉移管理員
- 一場拆成多將、底台設定、自動換算
- 月度排行、兩人對戰勝率
- 匯出 CSV
