'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'machiawase-'));
const { server } = require('../server');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));

async function call(method, url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Member-Token'] = token;
  const res = await fetch(base + url, { method, headers, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('まちあわせを作って参加・更新・チャットできる', async () => {
  const time = new Date(Date.now() + 3600e3).toISOString();
  const created = await call('POST', '/api/rooms', { title: '飲み会', place: '渋谷駅', time, lat: 35.658, lng: 139.701 });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const join = await call('POST', `/api/rooms/${id}/members`, { name: 'たろう' });
  assert.equal(join.status, 201);
  const { id: mid, token } = join.body;

  assert.equal((await call('PATCH', `/api/rooms/${id}/members/${mid}`, { status: '向かってる', eta: 10, lat: 35.66, lng: 139.7 }, token)).status, 200);
  assert.equal((await call('POST', `/api/rooms/${id}/messages`, { text: 'もうすぐ！' }, token)).status, 201);

  const room = (await call('GET', `/api/rooms/${id}`)).body;
  assert.equal(room.members[0].status, '向かってる');
  assert.equal(room.members[0].eta, 10);
  assert.equal(room.members[0].token, undefined, 'トークンは公開しない');
  assert.equal(room.messages[0].text, 'もうすぐ！');
});

test('他人のトークンでは更新できない', async () => {
  const time = new Date().toISOString();
  const { body: room } = await call('POST', '/api/rooms', { title: 't', place: 'p', time });
  const a = (await call('POST', `/api/rooms/${room.id}/members`, { name: 'A' })).body;
  const b = (await call('POST', `/api/rooms/${room.id}/members`, { name: 'B' })).body;
  assert.equal((await call('PATCH', `/api/rooms/${room.id}/members/${a.id}`, { status: '到着' }, b.token)).status, 403);
  assert.equal((await call('POST', `/api/rooms/${room.id}/messages`, { text: 'x' })).status, 403);
});

test('入力チェック', async () => {
  assert.equal((await call('POST', '/api/rooms', { title: '', place: 'p', time: new Date().toISOString() })).status, 400);
  assert.equal((await call('POST', '/api/rooms', { title: 't', place: 'p', time: 'nope' })).status, 400);
  assert.equal((await call('GET', '/api/rooms/missing')).status, 404);
});

test('座標が null なら位置なしとして扱う', async () => {
  const { body } = await call('POST', '/api/rooms', { title: 't', place: 'p', time: new Date().toISOString(), lat: null, lng: null });
  assert.equal(body.lat, null);
  assert.equal(body.lng, null);
});
