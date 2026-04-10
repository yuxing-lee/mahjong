const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT         = process.env.PORT         || 3000;
const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
const NOTION_DB_ID = process.env.NOTION_DB_ID || '';

// ── Notion page builder ──────────────────────────────────────────────────────
function buildNotionPage(record) {
  const d   = new Date(record.date);
  const pad = n => String(n).padStart(2, '0');
  const datetimeStr = record.dateStr ||
    `${d.getFullYear()}/${pad(d.getMonth()+1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const isoDate = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const title   = `第 ${record.session} 場　${datetimeStr}`;
  const dongTotal = record.dongTotal || (record.dong * (record.rounds || 1));

  const playerLines = record.players.map(p => {
    const sign    = p.pnl >= 0 ? '+' : '-';
    const abs     = Math.abs(p.pnl).toLocaleString('en-US');
    const hostTag = (p.isHost && record.dong) ? '（場主）' : '';
    return `${p.name}${hostTag}：${sign}$${abs}`;
  });
  if (record.dong > 0) {
    playerLines.push(`東家收入：+$${dongTotal.toLocaleString('en-US')}`);
  }

  const dongInfo = record.dong
    ? `東錢：$${record.dong.toLocaleString('en-US')}　將數：${record.rounds}　東錢合計：$${dongTotal.toLocaleString('en-US')}`
    : '東錢：無';
  const metaText = `底錢：$${record.bottom.toLocaleString('en-US')}　${dongInfo}`;

  return {
    parent: { database_id: NOTION_DB_ID },
    properties: {
      title:    { title:     [{ type: 'text', text: { content: title } }] },
      日期:     { date:      { start: isoDate } },
      場次:     { number:    record.session },
      底錢:     { number:    record.bottom },
      東錢:     { number:    record.dong || 0 },
      將數:     { number:    record.rounds || 0 },
      東錢合計: { number:    record.dong ? dongTotal : 0 },
      玩家結算: { rich_text: [{ type: 'text', text: { content: playerLines.join('\n') } }] },
    },
    children: [
      paragraph(metaText),
      { object: 'block', type: 'divider', divider: {} },
      ...playerLines.map(paragraph),
    ]
  };
}

function paragraph(text) {
  return {
    object: 'block', type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text } }] }
  };
}

// ── Notion API helpers ───────────────────────────────────────────────────────
function notionRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      'Authorization':  `Bearer ${NOTION_TOKEN}`,
      'Content-Type':   'application/json',
      'Notion-Version': '2022-06-28',
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);

    const req = https.request({ hostname: 'api.notion.com', path, method, headers }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ── Parse Notion query results into plain record objects ─────────────────────
function parseNotionPages(pages) {
  return pages.map(page => {
    const p = page.properties;
    const getText  = key => p[key]?.rich_text?.[0]?.plain_text || '';
    const getNum   = key => p[key]?.number ?? 0;
    const getDate  = key => p[key]?.date?.start || '';
    const getTitle = key => p[key]?.title?.[0]?.plain_text || '';

    const playersText = getText('玩家結算');
    const dateStr = getDate('日期');

    return {
      notionId:    page.id,
      session:     getNum('場次'),
      date:        dateStr,
      bottom:      getNum('底錢'),
      dong:        getNum('東錢'),
      rounds:      getNum('將數'),
      dongTotal:   getNum('東錢合計'),
      title:       getTitle('Name'),
      playersText, // raw lines e.g. "阿明（場主）：+$1,200\n小華：-$600"
    };
  });
}

// ── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {

  // POST /api/notion — save mahjong record to Notion DB
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
        const record = JSON.parse(raw);
        const result = await notionRequest('POST', '/v1/pages', buildNotionPage(record));
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(result.body);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /api/notion — fetch records from Notion DB
  if (req.method === 'GET' && req.url === '/api/notion') {
    if (!NOTION_TOKEN || !NOTION_DB_ID) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Notion not configured on server' }));
      return;
    }
    (async () => {
      try {
        const result = await notionRequest(
          'POST',
          `/v1/databases/${NOTION_DB_ID}/query`,
          { sorts: [{ property: '場次', direction: 'descending' }], page_size: 100 }
        );
        if (result.status !== 200) {
          res.writeHead(result.status, { 'Content-Type': 'application/json' });
          res.end(result.body);
          return;
        }
        const data = JSON.parse(result.body);
        const records = parseNotionPages(data.results || []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(records));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
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
