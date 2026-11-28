// まちあわせ — 依存パッケージなしで動く待ち合わせアプリのサーバー
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_BODY = 16 * 1024;
const MAX_MEMBERS = 50;
const MAX_MESSAGES = 200;
const ROOM_TTL_AFTER_MEETUP = 2 * 24 * 60 * 60 * 1000; // 待ち合わせ時刻の2日後に削除
const STATUSES = ['未設定', '未出発', '向かってる', 'もうすぐ着く', '到着', '遅れる', '行けない'];
const INACTIVE_MS = 30 * 60 * 1000; // これ以上更新がないメンバーは他の人も外せる

// ---------- 永続化 ----------
let rooms = {};
try {
  rooms = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  rooms = {};
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(rooms));
    fs.renameSync(tmp, DATA_FILE);
  }, 500);
}

function cleanup() {
  const now = Date.now();
  for (const [id, room] of Object.entries(rooms)) {
    if (new Date(room.time).getTime() + ROOM_TTL_AFTER_MEETUP < now) delete rooms[id];
  }
  scheduleSave();
}
setInterval(cleanup, 60 * 60 * 1000).unref();
cleanup();

// ---------- ユーティリティ ----------
const newId = (bytes) => crypto.randomBytes(bytes).toString('base64url');

function str(v, max) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, max);
}

function coord(v, limit) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

function publicRoom(room) {
  return {
    id: room.id,
    title: room.title,
    place: room.place,
    note: room.note,
    time: room.time,
    lat: room.lat,
    lng: room.lng,
    createdAt: room.createdAt,
    members: Object.values(room.members).map((m) => ({
      id: m.id,
      name: m.name,
      status: m.status,
      eta: m.eta,
      etaAt: m.etaAt || null,
      arrivedAt: m.arrivedAt || null,
      lat: m.lat,
      lng: m.lng,
      locationAt: m.locationAt,
      updatedAt: m.updatedAt,
    })),
    messages: room.messages,
  };
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('リクエストが大きすぎます'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON が不正です'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// ---------- リアルタイム配信 (Server-Sent Events) ----------
const subscribers = new Map(); // roomId -> Set<res>

function broadcast(room) {
  const subs = subscribers.get(room.id);
  if (!subs) return;
  const payload = `data: ${JSON.stringify(publicRoom(room))}\n\n`;
  for (const res of subs) res.write(payload);
}

function changed(room) {
  scheduleSave();
  broadcast(room);
}

setInterval(() => {
  for (const subs of subscribers.values()) for (const res of subs) res.write(': ping\n\n');
}, 25000).unref();

// ---------- メンバー認証 ----------
function authMember(req, room) {
  const token = req.headers['x-member-token'];
  if (typeof token !== 'string') return null;
  return Object.values(room.members).find((m) => m.token === token) || null;
}

// ---------- API ----------
async function handleApi(req, res, parts) {
  // GET /api/rooms/health (スリープ防止の自己アクセス用)
  if (parts.length === 2 && parts[1] === 'health') return send(res, 200, { ok: true });

  // POST /api/rooms
  if (parts.length === 1 && req.method === 'POST') {
    const b = await readBody(req);
    const title = str(b.title, 60);
    const place = str(b.place, 100);
    const time = new Date(b.time);
    if (!title) return send(res, 400, { error: 'タイトルを入力してください' });
    if (!place) return send(res, 400, { error: '場所を入力してください' });
    if (Number.isNaN(time.getTime())) return send(res, 400, { error: '日時が不正です' });
    const lat = coord(b.lat, 90);
    const lng = coord(b.lng, 180);
    // リンクから作り直す場合は同じ ID を使う（まだ存在しない時だけ）
    const wanted = typeof b.id === 'string' && /^[A-Za-z0-9_-]{6,16}$/.test(b.id) ? b.id : null;
    if (wanted && rooms[wanted]) return send(res, 200, publicRoom(rooms[wanted]));
    const id = wanted || newId(6);
    rooms[id] = {
      id,
      title,
      place,
      note: str(b.note, 300),
      time: time.toISOString(),
      lat: lat !== null && lng !== null ? lat : null,
      lng: lat !== null && lng !== null ? lng : null,
      createdAt: new Date().toISOString(),
      members: {},
      messages: [],
    };
    scheduleSave();
    return send(res, 201, publicRoom(rooms[id]));
  }

  const room = rooms[parts[1]];
  if (!room) return send(res, 404, { error: 'まちあわせが見つかりません' });

  // GET /api/rooms/:id
  if (parts.length === 2 && req.method === 'GET') return send(res, 200, publicRoom(room));

  // GET /api/rooms/:id/events
  if (parts.length === 3 && parts[2] === 'events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\ndata: ${JSON.stringify(publicRoom(room))}\n\n`);
    if (!subscribers.has(room.id)) subscribers.set(room.id, new Set());
    subscribers.get(room.id).add(res);
    req.on('close', () => {
      const subs = subscribers.get(room.id);
      if (!subs) return;
      subs.delete(res);
      if (!subs.size) subscribers.delete(room.id);
    });
    return;
  }

  // POST /api/rooms/:id/members  (参加)
  if (parts.length === 3 && parts[2] === 'members' && req.method === 'POST') {
    const b = await readBody(req);
    const name = str(b.name, 20);
    if (!name) return send(res, 400, { error: '名前を入力してください' });
    if (Object.keys(room.members).length >= MAX_MEMBERS)
      return send(res, 400, { error: '参加人数の上限に達しています' });
    // 同じ名前の人がいたら、同じ人の入り直し（別の端末・ブラウザなど）として引き継ぐ
    const same = Object.values(room.members).find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (same) {
      if (!b.takeover) return send(res, 409, { error: `「${same.name}」はもう参加しています`, existing: true });
      same.token = newId(18);
      same.updatedAt = new Date().toISOString();
      changed(room);
      return send(res, 200, { id: same.id, token: same.token });
    }
    const id = newId(6);
    const token = newId(18);
    const now = new Date().toISOString();
    room.members[id] = {
      id, token, name, status: '未設定', eta: null, etaAt: null, arrivedAt: null,
      lat: null, lng: null, locationAt: null, updatedAt: now,
    };
    changed(room);
    return send(res, 201, { id, token });
  }

  // PATCH / DELETE /api/rooms/:id/members/:mid
  if (parts.length === 4 && parts[2] === 'members') {
    const me = authMember(req, room);

    if (req.method === 'DELETE') {
      const target = room.members[parts[3]];
      if (!target) return send(res, 200, { ok: true });
      // 自分自身か、しばらく動きのないメンバー（抜け殻）なら外せる
      const inactive = Date.now() - new Date(target.updatedAt).getTime() >= INACTIVE_MS && target.status !== '到着';
      if (!me || (me.id !== target.id && !inactive)) return send(res, 403, { error: '権限がありません' });
      delete room.members[target.id];
      changed(room);
      return send(res, 200, { ok: true });
    }

    if (!me || me.id !== parts[3]) return send(res, 403, { error: '権限がありません。もう一度参加してください' });

    if (req.method === 'PATCH') {
      const b = await readBody(req);
      if ('name' in b) {
        const name = str(b.name, 20);
        if (name) me.name = name;
      }
      if ('status' in b) {
        if (!STATUSES.includes(b.status)) return send(res, 400, { error: 'ステータスが不正です' });
        if (b.status !== me.status) me.arrivedAt = b.status === '到着' ? new Date().toISOString() : null;
        me.status = b.status;
        if (b.status === '到着' || b.status === '行けない') me.eta = me.etaAt = null;
      }
      if ('eta' in b) {
        const eta = b.eta === null ? null : Math.round(Number(b.eta));
        if (eta === null || (Number.isFinite(eta) && eta >= 0 && eta <= 600)) {
          me.eta = eta;
          // 「あと◯分」は押した時点からの到着予定時刻として保存する（位置更新でずれないように）
          me.etaAt = eta === null ? null : new Date(Date.now() + eta * 60000).toISOString();
        }
      }
      if ('lat' in b || 'lng' in b) {
        const lat = coord(b.lat, 90);
        const lng = coord(b.lng, 180);
        if (lat !== null && lng !== null) {
          me.lat = lat;
          me.lng = lng;
          me.locationAt = new Date().toISOString();
        } else {
          me.lat = me.lng = me.locationAt = null;
        }
      }
      me.updatedAt = new Date().toISOString();
      changed(room);
      return send(res, 200, { ok: true });
    }
  }

  // POST /api/rooms/:id/messages
  if (parts.length === 3 && parts[2] === 'messages' && req.method === 'POST') {
    const me = authMember(req, room);
    if (!me) return send(res, 403, { error: '先に参加してください' });
    const b = await readBody(req);
    const text = str(b.text, 300);
    if (!text) return send(res, 400, { error: 'メッセージが空です' });
    room.messages.push({ id: newId(6), memberId: me.id, name: me.name, text, at: new Date().toISOString() });
    if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
    changed(room);
    return send(res, 201, { ok: true });
  }

  return send(res, 404, { error: 'Not found' });
}

// ---------- 静的ファイル ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.stat(file, (err, st) => {
    // SPA: 見つからなければ index.html を返す (/r/:id など)
    if (err || st.isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
    fs.readFile(file, (err2, data) => {
      if (err2) {
        res.writeHead(500);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const parts = pathname.split('/').filter(Boolean);
  try {
    if (parts[0] === 'api' && parts[1] === 'rooms') return await handleApi(req, res, parts.slice(1));
    if (parts[0] === 'api') return send(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    serveStatic(req, res, decodeURIComponent(pathname));
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'サーバーエラー' });
    if (!e.status) console.error(e);
  }
});

// 無料の Render は 15 分アクセスがないとスリープしてデータが消えるので、
// 待ち合わせが残っている間は 10 分ごとに自分の公開 URL にアクセスして起こしておく
function keepAlive() {
  const base = process.env.RENDER_EXTERNAL_URL;
  if (!base) return;
  setInterval(() => {
    if (!Object.keys(rooms).length) return;
    fetch(`${base}/api/rooms/health`).catch(() => {});
  }, 10 * 60 * 1000).unref();
}

if (require.main === module) {
  server.listen(PORT, () => console.log(`まちあわせ: http://localhost:${PORT}`));
  keepAlive();
}

module.exports = { server, STATUSES, get rooms() { return rooms; } };
