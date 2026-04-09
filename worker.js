/**
 * Cloudflare Worker — Notion proxy for 麻將結算工具
 *
 * 部署步驟：
 * 1. 登入 https://dash.cloudflare.com → Workers & Pages → Create Worker
 * 2. 貼上此檔內容並部署
 * 3. 在 Worker 設定 → Variables and Secrets 加入：
 *      NOTION_TOKEN  = secret_xxxxxxxxxxxxxxxx   （Integration token）
 *      NOTION_DB_ID  = xxxxxxxxxxxxxxxxxxxxxxxx   （32 碼 Database ID）
 * 4. 複製 Worker 網址（例如 https://mahjong-notion.yourname.workers.dev）
 * 5. 在麻將結算工具的「Notion 設定」欄位貼上此網址
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin':  '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const { NOTION_TOKEN, NOTION_DB_ID } = env;

    if (!NOTION_TOKEN || !NOTION_DB_ID) {
      return json({ error: 'Notion not configured on worker' }, 503);
    }

    let record;
    try {
      record = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    const notionBody = buildNotionPage(record, NOTION_DB_ID);

    let notionRes;
    try {
      notionRes = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: {
          'Authorization':  `Bearer ${NOTION_TOKEN}`,
          'Content-Type':   'application/json',
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify(notionBody),
      });
    } catch (e) {
      return json({ error: e.message }, 502);
    }

    const data = await notionRes.text();
    return new Response(data, {
      status: notionRes.status,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function buildNotionPage(record, dbId) {
  const d   = new Date(record.date);
  const pad = n => String(n).padStart(2, '0');
  const datetimeStr = `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const title       = `第 ${record.session} 場　${datetimeStr}`;

  const dongInfo = record.dong
    ? `東錢：$${fmt(record.dong)}　將數：${record.rounds}　東錢合計：$${fmt(record.dongTotal || record.dong * record.rounds)}`
    : '東錢：無';
  const metaText = `底錢：$${fmt(record.bottom)}　${dongInfo}`;

  const playerLines = record.players.map(p => {
    const sign    = p.pnl >= 0 ? '+' : '-';
    const hostTag = (p.isHost && record.dong) ? '（場主）' : '';
    return `${p.name}${hostTag}：${sign}$${fmt(Math.abs(p.pnl))}`;
  });

  return {
    parent: { database_id: dbId },
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
