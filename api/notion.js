const https = require('https');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
  const NOTION_DB_ID = process.env.NOTION_DB_ID || '';

  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    return res.status(503).json({ error: 'Notion not configured' });
  }

  const record = req.body;
  if (!record || typeof record !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const notionBody = buildNotionPage(record, NOTION_DB_ID);

  try {
    const result = await postToNotion(notionBody, NOTION_TOKEN);
    if (result.status >= 400) {
      console.error('[notion] API error', result.status, JSON.stringify(result.data));
    }
    return res.status(result.status).json(result.data);
  } catch (e) {
    console.error('[notion] Request failed:', e.message);
    return res.status(502).json({ error: e.message });
  }
};

// ── Notion page builder ──────────────────────────────────────────────────────

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

  // Notion accepts DB ID with or without dashes; strip to be safe
  const cleanDbId = dbId.replace(/-/g, '');

  return {
    parent: { database_id: cleanDbId },
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

// ── Notion API request ───────────────────────────────────────────────────────

function postToNotion(body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req  = https.request({
      hostname: 'api.notion.com',
      path:     '/v1/pages',
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Notion-Version': '2022-06-28',
      },
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
