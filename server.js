// سابا — سيرفر خفيف بدون أي مكتبات خارجية
// يخدم الملفات الثابتة + يحفظ حالة كل غرفة ويبثّها للأوفرلاي عبر SSE
// كل غرفة محمية برمز دخول: أول POST يسجّل الرمز، وأي تعديل بعده لازم يطابقه
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const rooms = new Map(); // roomId -> { state, clients:Set<res>, pin }

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-room-pin',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { state: null, clients: new Set(), pin: null });
  return rooms.get(id);
}

function broadcast(id) {
  const room = rooms.get(id);
  if (!room) return;
  const payload = `data: ${JSON.stringify(room.state || {})}\n\n`;
  for (const res of room.clients) {
    try { res.write(payload); } catch (_) { room.clients.delete(res); }
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 600000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') return json(res, 204, {});

  // حالة الغرفة (قراءة عامة — الأوفرلاي وصفحة المشاهدين)
  if (p === '/api/state') {
    const roomId = (url.searchParams.get('room') || 'default').slice(0, 40);
    if (req.method === 'GET') return json(res, 200, getRoom(roomId).state || { empty: true });

    if (req.method === 'POST') {
      const body = await readBody(req);
      const pin = String(body.pin || req.headers['x-room-pin'] || '').trim();
      const room = getRoom(roomId);

      if (!room.pin) {
        if (!pin) return json(res, 400, { error: 'pin_required', message: 'هذه الغرفة تحتاج رمز دخول' });
        room.pin = pin;
      } else if (room.pin !== pin) {
        return json(res, 403, { error: 'bad_pin', message: 'رمز الدخول غير صحيح' });
      }

      // تغيير الرمز من داخل الاستوديو (يتطلب الرمز الحالي)
      if (body.newPin) {
        const np = String(body.newPin).trim();
        if (/^\d{4,6}$/.test(np)) room.pin = np;
      }

      room.state = body.state || null;
      broadcast(roomId);
      return json(res, 200, { ok: true });
    }
  }

  // بثّ مباشر للأوفرلاي (SSE)
  if (p === '/api/live') {
    const roomId = (url.searchParams.get('room') || 'default').slice(0, 40);
    const room = getRoom(roomId);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 2000\n\n`);
    if (room.state) res.write(`data: ${JSON.stringify(room.state)}\n\n`);
    room.clients.add(res);
    const ka = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
    req.on('close', () => { clearInterval(ka); room.clients.delete(res); });
    return;
  }

  // اختصارات
  let filePath = p;
  if (filePath === '/') filePath = '/index.html';
  if (filePath === '/overlay') filePath = '/overlay.html';
  if (filePath === '/watch') filePath = '/watch.html';

  const abs = path.join(ROOT, decodeURIComponent(filePath));
  if (!abs.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }

  fs.readFile(abs, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`\n  ✦ سابا يعمل الآن`);
  console.log(`  → الاستوديو:  http://localhost:${PORT}`);
  console.log(`  → الأوفرلاي:  http://localhost:${PORT}/overlay`);
  console.log(`  → صفحة المشاهدين: http://localhost:${PORT}/watch\n`);
});
