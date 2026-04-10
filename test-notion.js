/**
 * Notion API 整合測試腳本
 * 用法: NOTION_TOKEN=... NOTION_DB_ID=... node test-notion.js
 */

const https = require('https');

const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
const NOTION_DB_ID = process.env.NOTION_DB_ID || '';

// ── 測試用假資料 ─────────────────────────────────────────────────────────────
const testRecord = {
  session: 99,
  date: Date.now(),
  dateStr: '2026/04/10 12:00',
  bottom: 300,
  dong: 200,
  rounds: 4,
  dongTotal: 800,
  players: [
    { name: '阿明', pnl: 1200,  isHost: true  },
    { name: '小華', pnl: -600,  isHost: false },
    { name: '阿珍', pnl: -200,  isHost: false },
    { name: '大雄', pnl: -400,  isHost: false },
  ],
};

// ── Notion page builder ──────────────────────────────────────────────────────
function buildNotionPage(record) {
  const datetimeStr = record.dateStr || (() => {
    const d   = new Date(record.date);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  })();
  const title = `第 ${record.session} 場　${datetimeStr}`;

  const dongInfo = record.dong
    ? `東錢：$${fmt(record.dong)}　將數：${record.rounds}　東錢合計：$${fmt(record.dongTotal || record.dong * record.rounds)}`
    : '東錢：無';
  const metaText = `底錢：$${fmt(record.bottom)}　${dongInfo}`;

  const playerLines = record.players.map(p => {
    const sign    = p.pnl >= 0 ? '+' : '-';
    const hostTag = (p.isHost && record.dong) ? '（場主）' : '';
    return `${p.name}${hostTag}：${sign}$${fmt(Math.abs(p.pnl))}`;
  });
  if (record.dong > 0) {
    const total = record.dongTotal || record.dong * (record.rounds || 1);
    playerLines.push(`東家收入：+$${fmt(total)}`);
  }

  return {
    parent: { database_id: NOTION_DB_ID },
    properties: {
      title: { title: [{ type: 'text', text: { content: title } }] },
    },
    children: [
      paragraph(metaText),
      { object: 'block', type: 'divider', divider: {} },
      ...playerLines.map(paragraph),
    ],
  };
}

function paragraph(text) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text } }] },
  };
}

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

// ── Notion API 請求 ──────────────────────────────────────────────────────────
function postToNotion(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request({
      hostname: 'api.notion.com',
      path:     '/v1/pages',
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${NOTION_TOKEN}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Notion-Version': '2022-06-28',
      },
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = { raw }; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── 執行測試 ─────────────────────────────────────────────────────────────────
(async () => {
  console.log('=== Notion API 測試 ===\n');

  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    console.error('❌ 缺少環境變數 NOTION_TOKEN 或 NOTION_DB_ID');
    process.exit(1);
  }

  console.log(`NOTION_DB_ID : ${NOTION_DB_ID}`);
  console.log(`NOTION_TOKEN : ${NOTION_TOKEN.slice(0, 10)}...\n`);

  const notionBody = buildNotionPage(testRecord);
  console.log('建立的頁面標題:', notionBody.properties.title.title[0].text.content);
  console.log('內文 blocks 數:', notionBody.children.length);
  console.log('');

  console.log('正在呼叫 Notion API...');
  try {
    const result = await postToNotion(notionBody);
    console.log(`HTTP 狀態碼: ${result.status}`);

    if (result.status === 200) {
      console.log('\n✅ 成功！已在 Notion 建立頁面');
      console.log('頁面 ID:', result.data.id);
      console.log('頁面 URL:', result.data.url);
    } else {
      console.log('\n❌ 失敗');
      console.log('錯誤詳情:', JSON.stringify(result.data, null, 2));
    }
  } catch (e) {
    console.error('\n❌ 網路錯誤:', e.message);
    process.exit(1);
  }
})();
