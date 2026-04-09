const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT       = process.env.PORT         || 3000;
const NOTION_TOKEN = process.env.NOTION_TOKEN  || '';
const NOTION_DB_ID = process.env.NOTION_DB_ID  || '';

// ── Notion page builder ──────────────────────────────────────────────────────
function buildNotionPage(record) {
  const d   = new Date(record.date);
  const pad = n => String(n).padStart(2, '0');
  const datetimeStr = `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const title       = `第 ${record.session} 場　${datetimeStr}`;

  const dongInfo = record.dong
    ? `東錢：$${record.dong.toLocaleString('en-US')}　將數：${record.rounds}　東錢合計：$${(record.dongTotal || record.dong * record.rounds).toLocaleString('en-US')}`
    : '東錢：無';
  const metaText = `底錢：$${record.bottom.toLocaleString('en-US')}　${dongInfo}`;

  const playerLines = record.players.map(p => {
    const sign    = p.pnl >= 0 ? '+' : '-';
    const abs     = Math.abs(p.pnl).toLocaleString('en-US');
    const hostTag = (p.isHost && record.dong) ? '（場主）' : '';
    return `${p.name}${hostTag}：${sign}$${abs}`;
  });

  return {
    parent: { database_id: NOTION_DB_ID },
    properties: {
      title: { title: [{ type: 'text', text: { content: title } }] }
    },
    children: [
      {
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: metaText } }] }
      },
      { object: 'block', type: 'divider', divider: {} },
      ...playerLines.map(line => ({
        object: 'block', type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: line } }] }
      }))
    ]
  };
}

// ── Notion API request (via built-in https) ──────────────────────────────────
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
        'Notion-Version': '2022-06-28'
      }
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {

  // POST /api/notion — proxy mahjong record to Notion
  if (req.method === 'POST' && req.url === '/api/notion') {
    if (!NOTION_TOKEN || !NOTION_DB_ID) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Notion not configured on server' }));
      return;
    }
    let raw = '';
    req.on('data', chunk => raw += chunk);
    req.on('end', async () => {
      try {
        const record     = JSON.parse(raw);
        const notionBody = buildNotionPage(record);
        const result     = await postToNotion(notionBody);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(result.body);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET / — serve the app
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end('Failed to read index.html');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`麻將結算工具 → http://localhost:${PORT}`);
  if (!NOTION_TOKEN) console.log('  ⚠  NOTION_TOKEN not set — Notion sync disabled');
  if (!NOTION_DB_ID) console.log('  ⚠  NOTION_DB_ID  not set — Notion sync disabled');
});
