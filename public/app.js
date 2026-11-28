'use strict';

const STATUSES = ['未出発', '向かってる', 'もうすぐ着く', '到着', '遅れる', '行けない'];
const ETAS = [5, 10, 15, 30];
const INACTIVE_MS = 30 * 60 * 1000; // これ以上動きのないメンバーは薄く表示して外せるようにする
const statusLabel = (s) => (s === '未設定' ? '―' : s);
const QUICK = ['今どこ？', '着いたよ！', '少し遅れます🙏', '改札出たところにいるよ', '了解！'];
const LOC_INTERVAL = 15000; // 位置情報の送信間隔 (ms)

const $ = (sel) => document.querySelector(sel);
const hasMap = () => typeof window.L !== 'undefined';

// ---------- 保存 ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

// ---------- 共通 ----------
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2500);
}

async function api(method, url, body, token) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Member-Token'] = token;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || '通信に失敗しました'), { status: res.status });
  return data;
}

function show(view) {
  for (const el of document.querySelectorAll('.view')) el.hidden = el.id !== `view-${view}`;
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
function fmtDate(iso) {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]}) ${hm}`;
}
function fmtClock(iso) {
  return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}
function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'たった今';
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  return `${Math.floor(s / 3600)}時間前`;
}

function hue(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
const colorOf = (id) => `hsl(${hue(id)} 60% 50%)`;

function distance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function fmtDistance(m) {
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) if (c != null) e.append(c);
  return e;
}

function pinIcon(cls, text, color) {
  const div = document.createElement('div');
  div.className = `pin ${cls}`;
  if (color) div.style.background = color;
  div.textContent = text;
  return L.divIcon({ html: div.outerHTML, className: '', iconSize: [30, 30], iconAnchor: [15, 15] });
}

function baseMap(elId, center, zoom) {
  const map = L.map(elId, { zoomControl: true }).setView(center, zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);
  return map;
}

// ---------- ホーム ----------
let pickMap = null;
let pickMarker = null;
let picked = null;

function setPick(latlng, zoom) {
  picked = { lat: latlng.lat, lng: latlng.lng };
  if (!pickMap) return;
  if (pickMarker) pickMarker.setLatLng(latlng);
  else pickMarker = L.marker(latlng, { icon: pinIcon('pin-goal', '★') }).addTo(pickMap);
  if (zoom) pickMap.setView(latlng, zoom);
  $('#pick-hint').textContent = 'ピンを置きました（地図をタップで移動できます）';
}

$('#pick-here').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('位置情報が使えません');
  navigator.geolocation.getCurrentPosition(
    (p) => setPick({ lat: p.coords.latitude, lng: p.coords.longitude }, 16),
    () => toast('現在地を取得できませんでした'),
    { enableHighAccuracy: true, timeout: 10000 },
  );
});

// ---------- 場所検索 ----------
// OpenStreetMap (Nominatim) で駅・お店・ランドマークを探し、見つからなければ国土地理院の住所検索を使う
async function searchOSM(q) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.search = new URLSearchParams({ q, format: 'jsonv2', limit: '8', 'accept-language': 'ja', countrycodes: 'jp' });
  const res = await fetch(url);
  if (!res.ok) throw new Error('search failed');
  return (await res.json()).map((r) => {
    const parts = r.display_name.split(',').map((x) => x.trim());
    const name = r.name || parts[0];
    const area = parts.filter((x) => x !== name && x !== '日本' && !/^\d{3}-?\d{4}$/.test(x)).reverse().join(' ');
    return { name, area, lat: Number(r.lat), lng: Number(r.lon) };
  });
}

async function searchGSI(q) {
  const res = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error('search failed');
  return (await res.json()).slice(0, 8).map((r) => ({
    name: r.properties.title,
    area: '',
    lat: r.geometry.coordinates[1],
    lng: r.geometry.coordinates[0],
  }));
}

let searching = false;
async function placeSearch() {
  const q = $('#place-input').value.trim();
  if (!q) return toast('場所の名前を入力してください');
  if (searching) return;
  searching = true;
  const btn = $('#place-search');
  const list = $('#place-results');
  btn.disabled = true;
  btn.textContent = '検索中…';
  let results = [];
  try {
    results = await searchOSM(q);
  } catch {}
  if (!results.length) {
    try {
      results = await searchGSI(q);
    } catch {}
  }
  searching = false;
  btn.disabled = false;
  btn.textContent = '🔍 検索';
  list.hidden = false;
  if (!results.length) {
    list.replaceChildren(el('li', { class: 'empty' }, '見つかりませんでした。別の言い方で試すか、地図をタップしてください'));
    return;
  }
  list.replaceChildren(
    ...results.map((r) =>
      el(
        'li',
        {},
        el(
          'button',
          {
            type: 'button',
            onclick: () => {
              setPick({ lat: r.lat, lng: r.lng }, 17);
              list.hidden = true;
              $('#pick-map').scrollIntoView({ behavior: 'smooth', block: 'center' });
            },
          },
          el('strong', {}, r.name),
          r.area ? el('small', {}, r.area) : null,
        ),
      ),
    ),
  );
}

$('#place-search').addEventListener('click', placeSearch);
$('#place-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault();
    placeSearch();
  }
});

function initHome() {
  show('home');
  document.title = 'まちあわせ';

  const form = $('#create-form');
  // ほかのアプリ（GOD Life など）から ?title=&place=&time=YYYY-MM-DDTHH:MM&note= 付きで開かれたら、作成画面に入れておく
  const q = new URLSearchParams(location.search);
  if (q.has('title') || q.has('place') || q.has('time')) {
    if (q.get('title')) form.title.value = q.get('title').slice(0, 60);
    if (q.get('place')) form.place.value = q.get('place').slice(0, 100);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(q.get('time') || '')) form.time.value = q.get('time');
    if (q.get('note')) form.note.value = q.get('note').slice(0, 300);
    history.replaceState(null, '', location.pathname); // 再読み込みでまた入らないように
  }
  if (!form.time.value) {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    form.time.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  if (hasMap() && !pickMap) {
    pickMap = baseMap('pick-map', [35.681, 139.767], 12); // 東京駅
    pickMap.on('click', (e) => setPick(e.latlng));
  } else if (!hasMap()) {
    $('#pick-map').closest('.field').hidden = true;
  }

  const recent = store.get('machiawase:recent', []).filter((r) => new Date(r.time).getTime() > Date.now() - 2 * 864e5);
  $('#recent').hidden = recent.length === 0;
  $('#recent-list').replaceChildren(
    ...recent.map((r) => el('li', {}, el('a', { href: `/r/${r.id}` }, r.title, el('small', {}, `${fmtDate(r.time)} ・ ${r.place}`)))),
  );
}

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const room = await api('POST', '/api/rooms', {
      title: f.title.value,
      place: f.place.value,
      note: f.note.value,
      time: new Date(f.time.value).toISOString(),
      lat: picked ? picked.lat : null,
      lng: picked ? picked.lng : null,
    });
    history.pushState(null, '', `/r/${room.id}`);
    route();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------- まちあわせ画面 ----------
const state = {
  roomId: null,
  room: null,
  me: null, // {id, token}
  source: null,
  map: null,
  goalMarker: null,
  memberMarkers: new Map(),
  fittedCount: 0,
  userMoved: false,
  watchId: null,
  lastSent: 0,
  pendingPos: null,
  sendTimer: null,
  countdownTimer: null,
};

const memberKey = (id) => `machiawase:member:${id}`;
const locKey = (id) => `machiawase:loc:${id}`;

function myMember() {
  return state.room && state.me ? state.room.members.find((m) => m.id === state.me.id) : null;
}

function rememberRecent(room) {
  const list = store.get('machiawase:recent', []).filter((r) => r.id !== room.id);
  list.unshift({ id: room.id, title: room.title, place: room.place, time: room.time, d: encodeRoom(room) });
  store.set('machiawase:recent', list.slice(0, 10));
}

// ---------- リンクに待ち合わせ情報を埋め込む（サーバーのデータが消えても作り直せるように） ----------
function encodeRoom(room) {
  const json = JSON.stringify({ t: room.title, p: room.place, n: room.note || '', at: room.time, la: room.lat, ln: room.lng });
  const bin = String.fromCharCode(...new TextEncoder().encode(json));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeRoom(str) {
  try {
    const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    return { title: d.t, place: d.p, note: d.n, time: d.at, lat: d.la, lng: d.ln };
  } catch {
    return null;
  }
}

const roomLink = (room) => `${location.origin}/r/${room.id}#d=${encodeRoom(room)}`;

function linkData(id) {
  const m = location.hash.match(/[#&]d=([A-Za-z0-9_-]+)/);
  if (m) return decodeRoom(m[1]);
  const saved = store.get('machiawase:recent', []).find((r) => r.id === id);
  return saved && saved.d ? decodeRoom(saved.d) : null;
}

let recovering = false;
async function handleMissing(id) {
  const data = linkData(id);
  if (data && !recovering) {
    recovering = true;
    try {
      await api('POST', '/api/rooms', { ...data, id });
      toast('サーバーが再起動していたので、まちあわせを復元しました');
      recovering = false;
      return connect(id);
    } catch {}
    recovering = false;
  }
  teardownRoom();
  show('missing');
}

function connect(id) {
  if (state.source) state.source.close();
  const source = new EventSource(`/api/rooms/${encodeURIComponent(id)}/events`);
  state.source = source;
  source.onmessage = (e) => {
    state.room = JSON.parse(e.data);
    // 自分が削除されていたら（サーバー再起動など）参加情報をリセット
    if (state.me && !myMember()) {
      store.set(memberKey(id), null);
      state.me = null;
      stopLocation();
      const name = store.get('machiawase:name', '');
      if (name && !$('#join-form').name.value) $('#join-form').name.value = name;
    }
    show('room');
    renderRoom();
  };
  source.onerror = async () => {
    // 一時的な切断は EventSource が自動で再接続する。完全に切れた時だけ状況を確認する
    if (source.readyState !== EventSource.CLOSED && state.room) return;
    try {
      await api('GET', `/api/rooms/${encodeURIComponent(id)}`);
      if (state.source === source) setTimeout(() => state.source === source && connect(id), 3000);
    } catch (err) {
      if (state.source !== source) return;
      if (err.status === 404) handleMissing(id);
      else setTimeout(() => state.source === source && connect(id), 5000);
    }
  };
}

function initRoom(id) {
  teardownRoom();
  state.roomId = id;
  state.me = store.get(memberKey(id), null);
  state.fittedCount = 0;
  state.userMoved = false;

  connect(id);
  state.countdownTimer = setInterval(renderCountdown, 1000);
}

function teardownRoom() {
  if (state.source) state.source.close();
  state.source = null;
  clearInterval(state.countdownTimer);
  stopLocation();
  state.room = null;
  if (state.goalMarker) state.goalMarker.remove();
  state.goalMarker = null;
  for (const marker of state.memberMarkers.values()) marker.remove();
  state.memberMarkers.clear();
}

function renderCountdown() {
  const room = state.room;
  if (!room) return;
  const diff = new Date(room.time).getTime() - Date.now();
  const c = $('#countdown');
  c.classList.toggle('past', diff < 0);
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const s = Math.floor((abs % 60000) / 1000);
  const parts = h >= 24 ? `${Math.floor(h / 24)}日${h % 24}時間` : h ? `${h}時間${m}分` : `${m}分${String(s).padStart(2, '0')}秒`;
  c.textContent = diff >= 0 ? `あと ${parts}` : `集合時刻から ${parts} 経過`;
}

function renderRoom() {
  const room = state.room;
  const me = myMember();
  document.title = `${room.title} - まちあわせ`;
  rememberRecent(room);
  // アドレスバーの URL にも情報を入れておく（そのままコピーして送っても復元できる）
  const hash = `#d=${encodeRoom(room)}`;
  if (location.hash !== hash) history.replaceState(null, '', location.pathname + hash);

  $('#room-title').textContent = room.title;
  $('#room-time').textContent = fmtDate(room.time);
  $('#room-place').textContent = room.place;
  $('#room-note').hidden = !room.note;
  $('#room-note').textContent = room.note || '';
  const dest = room.lat != null ? `${room.lat},${room.lng}` : room.place;
  $('#route-btn').href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
  renderCountdown();

  $('#join-form').hidden = !!me;
  $('#me-panel').hidden = !me;
  $('#msg-form').hidden = !me;
  $('#quick-msgs').hidden = !me;

  if (me) {
    $('#me-name').textContent = me.name;
    $('#status-buttons').replaceChildren(
      ...STATUSES.map((s) =>
        el('button', { type: 'button', class: `chip${me.status === s ? ' active' : ''}`, onclick: () => updateMe({ status: s }) }, s),
      ),
    );
    // 着いた・行けない人には「到着まで」は不要
    $('#eta-row').hidden = me.status === '到着' || me.status === '行けない';
    const setEta = (n) => {
      const patch = { eta: n };
      // 時間を選んだら「向かってる」扱いにする
      if (n != null && (me.status === '未設定' || me.status === '未出発')) patch.status = '向かってる';
      updateMe(patch);
    };
    $('#eta-buttons').replaceChildren(
      ...ETAS.map((n) => el('button', { type: 'button', class: `chip${me.eta === n ? ' active' : ''}`, onclick: () => setEta(n) }, `${n}分`)),
      el('button', { type: 'button', class: `chip${me.eta == null ? ' active' : ''}`, onclick: () => setEta(null) }, '未定'),
    );
    if (!$('#quick-msgs').childElementCount) {
      $('#quick-msgs').append(...QUICK.map((t) => el('button', { type: 'button', class: 'chip', onclick: () => sendMessage(t) }, t)));
    }
    const wantLoc = store.get(locKey(room.id), false);
    $('#share-loc').checked = wantLoc;
    if (wantLoc && state.watchId == null) startLocation();
  }

  renderMembers();
  renderMap();
  renderMessages();
}

const isGhost = (m) => m.status !== '到着' && Date.now() - new Date(m.updatedAt).getTime() >= INACTIVE_MS;
const etaLeft = (m) => (m.etaAt ? Math.max(0, Math.ceil((new Date(m.etaAt).getTime() - Date.now()) / 60000)) : null);
const distToGoal = (m) =>
  m.lat != null && state.room.lat != null ? distance(m.lat, m.lng, state.room.lat, state.room.lng) : null;

function isLate(m) {
  return Date.now() > new Date(state.room.time).getTime() && m.status !== '到着' && m.status !== '行けない';
}

function memberSub(m) {
  const bits = [];
  if (m.status === '到着') {
    if (m.arrivedAt) bits.push(`${fmtClock(m.arrivedAt)} 着`);
  } else if (m.status !== '行けない') {
    const left = etaLeft(m);
    if (left != null) bits.push(left === 0 ? `${fmtClock(m.etaAt)}頃 着予定` : `あと${left}分（${fmtClock(m.etaAt)}頃）`);
    const d = distToGoal(m);
    if (d != null) bits.push(`集合場所まで ${fmtDistance(d)}`);
    else if (m.lat != null) bits.push('位置共有中');
    if (isLate(m)) bits.unshift('遅刻中');
  }
  bits.push(`更新 ${ago(m.updatedAt)}`);
  return bits.join(' ・ ');
}

// 着いてない人（到着予定が早い順→近い順）→ 到着した人（着いた順）→ 行けない人
function sortMembers(members) {
  const group = (m) => (m.status === '到着' ? 1 : m.status === '行けない' ? 2 : isGhost(m) ? 0.5 : 0);
  const key = (m) => {
    if (m.status === '到着') return new Date(m.arrivedAt || m.updatedAt).getTime();
    const left = etaLeft(m);
    const d = distToGoal(m);
    return (left ?? 1e6) * 1e6 + (d ?? 1e9) / 1000;
  };
  return [...members].sort((a, b) => group(a) - group(b) || key(a) - key(b));
}

function renderMembers() {
  const members = state.room.members;
  $('#member-count').textContent = `${members.filter((m) => m.status === '到着').length}/${members.length} 到着`;
  if (!members.length) {
    $('#member-list').replaceChildren(el('li', { class: 'hint' }, 'まだ誰も参加していません。リンクを共有しましょう！'));
    return;
  }
  const items = [];
  const groupOf = (m) => (m.status === '到着' ? '到着した人' : m.status === '行けない' ? '行けない人' : 'まだの人');
  const multi = new Set(members.map(groupOf)).size > 1;
  let lastGroup = null;
  for (const m of sortMembers(members)) {
    const g = groupOf(m);
    if (multi && g !== lastGroup) items.push(el('li', { class: 'section-label' }, g));
    lastGroup = g;
    const mine = state.me && m.id === state.me.id;
    const ghost = !mine && isGhost(m);
    const late = isLate(m);
    const located = m.lat != null && hasMap();
    const cls = [located ? 'clickable' : '', late ? 'late' : '', ghost ? 'ghost' : ''].filter(Boolean).join(' ');
    items.push(
      el(
        'li',
        { class: cls, onclick: located ? () => focusMember(m.id) : null },
        el('div', { class: 'avatar', style: `background:${colorOf(m.id)}` }, [...m.name][0]),
        el(
          'div',
          { class: 'member-info' },
          el('div', { class: 'member-name' }, m.name + (mine ? '（自分）' : '') + (located ? ' 📍' : '')),
          el('div', { class: 'member-sub' }, memberSub(m)),
        ),
        el(
          'div',
          { class: 'member-side' },
          el('span', { class: `status-pill s-${late && m.status === '未設定' ? '遅刻' : m.status}` }, late && m.status === '未設定' ? '遅刻中' : statusLabel(m.status)),
          ghost && state.me
            ? el('button', { type: 'button', class: 'remove-btn', onclick: (e) => { e.stopPropagation(); removeMember(m); } }, '外す')
            : null,
        ),
      ),
    );
  }
  $('#member-list').replaceChildren(...items);
}

async function removeMember(m) {
  if (!confirm(`「${m.name}」はしばらく更新がありません。メンバーから外しますか？`)) return;
  try {
    await api('DELETE', `/api/rooms/${state.roomId}/members/${m.id}`, null, state.me.token);
  } catch (err) {
    toast(err.message);
  }
}

function mapPoints() {
  const room = state.room;
  const pts = room.members.filter((m) => m.lat != null).map((m) => [m.lat, m.lng]);
  if (room.lat != null) pts.push([room.lat, room.lng]);
  return pts;
}

function fitAll() {
  const pts = mapPoints();
  if (!state.map || !pts.length) return;
  state.map.invalidateSize();
  if (pts.length > 1) state.map.fitBounds(pts, { padding: [56, 56], maxZoom: 16 });
  else state.map.setView(pts[0], 16);
}

function focusMember(id) {
  const marker = state.memberMarkers.get(id);
  if (!marker || !state.map) return;
  state.userMoved = true;
  $('#map-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
  state.map.setView(marker.getLatLng(), 17);
  marker.openTooltip();
}

function renderMap() {
  const card = $('#map-card');
  if (!hasMap()) {
    card.hidden = true;
    return;
  }
  const room = state.room;
  const hasGoal = room.lat != null;
  const located = room.members.filter((m) => m.lat != null);
  card.hidden = !hasGoal && !located.length;
  if (card.hidden) return;

  if (!state.map) {
    state.map = baseMap('room-map', hasGoal ? [room.lat, room.lng] : [located[0].lat, located[0].lng], 16);
    // 自分で地図を動かしたら、自動で表示範囲を変えない
    state.map.on('dragstart', () => (state.userMoved = true));
    state.map.getContainer().addEventListener('wheel', () => (state.userMoved = true), { passive: true });
    state.map.getContainer().addEventListener('touchstart', (e) => e.touches.length > 1 && (state.userMoved = true), { passive: true });
  }
  state.map.invalidateSize();

  if (hasGoal && !state.goalMarker) {
    state.goalMarker = L.marker([room.lat, room.lng], { icon: pinIcon('pin-goal', '★'), zIndexOffset: -1000 })
      .bindTooltip(`集合: ${room.place}`.replace(/[<>&"]/g, ''))
      .addTo(state.map);
  }

  const seen = new Set();
  for (const m of located) {
    seen.add(m.id);
    const icon = pinIcon('', [...m.name][0], colorOf(m.id));
    let marker = state.memberMarkers.get(m.id);
    if (!marker) {
      marker = L.marker([m.lat, m.lng], { icon }).addTo(state.map);
      state.memberMarkers.set(m.id, marker);
    } else {
      marker.setLatLng([m.lat, m.lng]).setIcon(icon);
    }
    marker.bindTooltip(`${m.name}（${statusLabel(m.status)}）`.replace(/[<>&"]/g, ''));
  }
  for (const [id, marker] of state.memberMarkers) {
    if (!seen.has(id)) {
      marker.remove();
      state.memberMarkers.delete(id);
    }
  }

  // 地図に出る人が増えた時は、全員が見えるように合わせ直す（自分で動かしていない時だけ）
  const count = located.length + (hasGoal ? 1 : 0);
  if (count > state.fittedCount && !state.userMoved) requestAnimationFrame(fitAll);
  state.fittedCount = count;
}

$('#fit-btn').addEventListener('click', () => {
  state.userMoved = false;
  fitAll();
});

// 画面に戻ってきた時（アプリ切り替えなど）は地図サイズを直して全員を表示し直す
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.map || !state.room) return;
  state.map.invalidateSize();
  if (!state.userMoved) fitAll();
});

function renderMessages() {
  const list = $('#messages');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const msgs = state.room.messages;
  if (!msgs.length) {
    list.replaceChildren(el('li', { class: 'empty' }, 'まだメッセージはありません'));
    return;
  }
  list.replaceChildren(
    ...msgs.map((m) =>
      el(
        'li',
        { class: `msg${state.me && m.memberId === state.me.id ? ' mine' : ''}` },
        el('span', { class: 'meta' }, `${m.name} ・ ${fmtClock(m.at)}`),
        el('span', { class: 'bubble' }, m.text),
      ),
    ),
  );
  if (atBottom || list.dataset.init !== state.roomId) {
    list.scrollTop = list.scrollHeight;
    list.dataset.init = state.roomId;
  }
}

async function updateMe(patch) {
  if (!state.me) return;
  try {
    await api('PATCH', `/api/rooms/${state.roomId}/members/${state.me.id}`, patch, state.me.token);
  } catch (err) {
    if (err.status === 403) return lostMembership('別の端末で参加し直されたため、この端末の参加は解除されました');
    toast(err.message);
  }
}

function lostMembership(msg) {
  store.set(memberKey(state.roomId), null);
  state.me = null;
  stopLocation();
  const name = store.get('machiawase:name', '');
  if (name && !$('#join-form').name.value) $('#join-form').name.value = name;
  toast(msg);
  if (state.room) renderRoom();
}

async function sendMessage(text) {
  if (!state.me) return;
  try {
    await api('POST', `/api/rooms/${state.roomId}/messages`, { text }, state.me.token);
    const list = $('#messages');
    requestAnimationFrame(() => (list.scrollTop = list.scrollHeight));
  } catch (err) {
    toast(err.message);
  }
}

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = e.target.name.value;
  try {
    let me;
    try {
      me = await api('POST', `/api/rooms/${state.roomId}/members`, { name });
    } catch (err) {
      if (err.status !== 409) throw err;
      if (!confirm(`${err.message}。\nあなた本人なら「OK」で引き継ぎます（ステータスや位置はそのまま）。\n別の人なら「キャンセル」して名前を変えてください。`)) return;
      me = await api('POST', `/api/rooms/${state.roomId}/members`, { name, takeover: true });
    }
    state.me = me;
    store.set(memberKey(state.roomId), me);
    store.set('machiawase:name', name.trim());
    if (state.room) renderRoom();
  } catch (err) {
    toast(err.message);
  }
});

$('#leave-btn').addEventListener('click', async () => {
  if (!state.me || !confirm('このまちあわせから抜けますか？')) return;
  try {
    await api('DELETE', `/api/rooms/${state.roomId}/members/${state.me.id}`, null, state.me.token);
  } catch {}
  stopLocation();
  store.set(memberKey(state.roomId), null);
  store.set(locKey(state.roomId), null);
  state.me = null;
  if (state.room) renderRoom();
});

$('#msg-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = e.target.text;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendMessage(text);
});

$('#share-btn').addEventListener('click', async () => {
  const room = state.room;
  const url = roomLink(room);
  const text = `【${room.title}】${fmtDate(room.time)} @ ${room.place}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: room.title, text, url });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    toast('リンクをコピーしました');
  } catch {
    prompt('このリンクを共有してください', url);
  }
});

// ---------- 位置情報共有 ----------
$('#share-loc').addEventListener('change', (e) => {
  store.set(locKey(state.roomId), e.target.checked);
  if (e.target.checked) startLocation();
  else {
    stopLocation();
    updateMe({ lat: null, lng: null });
  }
});

function startLocation() {
  if (!navigator.geolocation) {
    $('#loc-hint').textContent = '使えません';
    $('#share-loc').checked = false;
    return;
  }
  $('#loc-hint').textContent = '取得中…';
  $('#loc-hint').classList.remove('on');
  state.watchId = navigator.geolocation.watchPosition(
    (p) => {
      state.pendingPos = { lat: p.coords.latitude, lng: p.coords.longitude };
      $('#loc-hint').textContent = '🟢 共有中';
      $('#loc-hint').classList.add('on');
      flushLocation();
    },
    (err) => {
      $('#loc-hint').classList.remove('on');
      $('#loc-hint').textContent = err.code === 1 ? '許可されていません' : '取得できません';
      if (err.code === 1) {
        $('#share-loc').checked = false;
        store.set(locKey(state.roomId), false);
        stopLocation();
      }
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 },
  );
}

function flushLocation() {
  if (!state.pendingPos || state.sendTimer) return;
  const wait = Math.max(0, state.lastSent + LOC_INTERVAL - Date.now());
  state.sendTimer = setTimeout(() => {
    state.sendTimer = null;
    if (!state.pendingPos || state.watchId == null) return;
    state.lastSent = Date.now();
    updateMe(state.pendingPos);
    state.pendingPos = null;
  }, wait);
}

function stopLocation() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  clearTimeout(state.sendTimer);
  state.sendTimer = null;
  state.pendingPos = null;
  $('#loc-hint').textContent = '';
  $('#loc-hint').classList.remove('on');
}

// ---------- ルーティング ----------
function route() {
  const m = location.pathname.match(/^\/r\/([A-Za-z0-9_-]+)\/?$/);
  if (m) {
    const name = store.get('machiawase:name', '');
    if (name && !$('#join-form').name.value) $('#join-form').name.value = name;
    initRoom(m[1]);
  } else {
    teardownRoom();
    initHome();
  }
}

window.addEventListener('popstate', route);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/"]');
  if (!a || e.metaKey || e.ctrlKey || a.target) return;
  e.preventDefault();
  history.pushState(null, '', a.getAttribute('href'));
  route();
});

// メンバーの「◯分前」表示を定期的に更新
setInterval(() => state.room && renderMembers(), 30000);

route();
