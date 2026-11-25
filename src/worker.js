/*
  LABBoard — сервер спільного уроку (Cloudflare Workers + Durable Objects).
  Проєкт LAB Богдана Завидовського.

  • Роздає саму дошку (папка public/).
  • /health — перевірка, що сервер працює (дошка шукає тут {"kreida":true}).
  • /ws?room=12345 — кімната уроку. Одна кімната = один Durable Object.

  Сервер нічого не зберігає з дошки: учитель — джерело правди, сервер лише
  пересилає повідомлення між учителем і учнями. На диску кімнати — тільки
  ключ учителя (щоб чужий не зайняв код) і стан «пише лише вчитель».
*/
import { DurableObject } from 'cloudflare:workers';

const VERSION = '2.4';
const MAX_PEERS = 60;             // учитель + до 59 учнів
const MAX_BUFFER = 4_000_000;     // скільки байтів змін учнів тримати, поки вчитель перепідключається
const STALE_MS = 3 * 3600_000;    // через 3 год без учителя код уроку можна зайняти знову

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': '*' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/health') return json({ kreida: true, app: 'LABBoard', v: VERSION });
    if (url.pathname === '/share' || url.pathname.startsWith('/share/')) {
      if (url.pathname === '/share' && request.method === 'POST') {
        const id = shareId();
        const r = await env.ROOMS.get(env.ROOMS.idFromName('share:' + id)).fetch(new Request('https://share/' + id, { method: 'PUT', body: request.body, headers: request.headers }));
        return withCors(r);
      }
      const id = url.pathname.slice(7).replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
      if (!id || !['GET', 'DELETE'].includes(request.method)) return json({ error: 'bad request' }, 400);
      return withCors(await env.ROOMS.get(env.ROOMS.idFromName('share:' + id)).fetch(new Request('https://share/' + id + url.search, { method: request.method })));
    }
    if (url.pathname === '/media' && request.method === 'POST') {
      const id = shareId();
      return withCors(await env.ROOMS.get(env.ROOMS.idFromName('media:' + id)).fetch(new Request('https://media/' + id, { method: 'PUT', body: request.body, headers: request.headers })));
    }
    if (url.pathname.startsWith('/m/')) {
      const id = url.pathname.slice(3).replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
      if (!id) return json({ error: 'bad request' }, 400);
      return withCors(await env.ROOMS.get(env.ROOMS.idFromName('media:' + id)).fetch(new Request('https://media/' + id, { method: 'GET', headers: request.headers })));
    }
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Очікую WebSocket', { status: 426 });
      const room = (url.searchParams.get('room') || '').replace(/\D/g, '').slice(0, 8);
      if (room.length < 4) return new Response('Невірний код уроку', { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
    }
    return env.ASSETS.fetch(request);
  }
};

const SHARE_MAX = 20_000_000;    // найбільший урок, яким можна поділитися (байтів)
const CHUNK = 100_000;
const MEDIA_MAX = 50_000_000;   // найбільше мікровідео за посиланням (байтів)
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const shareId = () => { const b = crypto.getRandomValues(new Uint8Array(10)); return [...b].map(x => ABC[x % ABC.length]).join(''); };
const withCors = r => { const h = new Headers(r.headers); for (const [k, v] of Object.entries(CORS)) h.set(k, v); return new Response(r.body, { status: r.status, headers: h }); };

const TEACHER_ONLY = new Set(['page', 'pagex', 'lock', 'follow', 'timer', 'pick', 'end', 'need']);
const TO_TEACHER = new Set(['focus', 'ans', 'react']);

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.buffer = []; this.bufSize = 0;
    // «ping» → «pong» відповідає сама платформа, не будячи кімнату
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return this.share(request);
    if (this.ctx.getWebSockets().length >= MAX_PEERS) return new Response('Кімната заповнена', { status: 429 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({ id: null, joined: Date.now() });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /* Урок, яким поділилися: зберігається шматками по 100 КБ у сховищі цього об'єкта */
  async share(request) {
    const st = this.ctx.storage, url = new URL(request.url), id = url.pathname.slice(1);
    if (url.hostname === 'media') return this.media(request, st);
    if (request.method === 'PUT') {
      if (await st.get('meta')) return json({ error: 'exists' }, 409);
      const text = await request.text();
      if (text.length > SHARE_MAX) return json({ error: 'too big', max: SHARE_MAX }, 413);
      let body; try { body = JSON.parse(text); } catch (_) { return json({ error: 'bad json' }, 400); }
      const data = String(body.data || ''); if (!data.includes('KreidaLAB')) return json({ error: 'not a lesson' }, 400);
      const key = shareId() + shareId(), n = Math.ceil(data.length / CHUNK);
      for (let i = 0; i < n; i += 100) { const batch = {}; for (let j = i; j < Math.min(n, i + 100); j++) batch['c' + j] = data.slice(j * CHUNK, (j + 1) * CHUNK); await st.put(batch); }
      await st.put('meta', { name: String(body.name || 'Урок').slice(0, 120), author: String(body.author || '').slice(0, 60), pages: +body.pages || 0, n, key, ts: Date.now() });
      return json({ id, key });
    }
    const meta = await st.get('meta');
    if (!meta) return json({ error: 'not found' }, 404);
    if (request.method === 'DELETE') { if (url.searchParams.get('key') !== meta.key) return json({ error: 'forbidden' }, 403); await st.deleteAll(); return json({ ok: true }); }
    let data = '';
    for (let i = 0; i < meta.n; i += 100) { const keys = Array.from({ length: Math.min(100, meta.n - i) }, (_, j) => 'c' + (i + j)); const parts = await st.get(keys); for (const k of keys) data += parts.get(k) || ''; }
    return new Response(JSON.stringify({ name: meta.name, author: meta.author, pages: meta.pages, ts: meta.ts, data }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' } });
  }

  /* Мікровідео вчителя: байти шматками по 100 КБ, віддача з підтримкою перемотування (Range) */
  async media(request, st) {
    if (request.method === 'PUT') {
      if (await st.get('meta')) return json({ error: 'exists' }, 409);
      const type = (request.headers.get('content-type') || '').split(';')[0];
      if (!/^video\/(mp4|webm)$/.test(type)) return json({ error: 'not a video' }, 415);
      const buf = new Uint8Array(await request.arrayBuffer());
      if (buf.length > MEDIA_MAX) return json({ error: 'too big', max: MEDIA_MAX }, 413);
      const n = Math.ceil(buf.length / CHUNK);
      for (let i = 0; i < n; i += 100) { const batch = {}; for (let j = i; j < Math.min(n, i + 100); j++) batch['c' + j] = buf.slice(j * CHUNK, (j + 1) * CHUNK); await st.put(batch); }
      await st.put('meta', { type, size: buf.length, n, ts: Date.now() });
      return json({ id: new URL(request.url).pathname.slice(1) });
    }
    const meta = await st.get('meta'); if (!meta) return json({ error: 'not found' }, 404);
    const all = new Uint8Array(meta.size); let off = 0;
    for (let i = 0; i < meta.n; i += 100) { const keys = Array.from({ length: Math.min(100, meta.n - i) }, (_, j) => 'c' + (i + j)); const parts = await st.get(keys); for (const k of keys) { const p = parts.get(k); all.set(p, off); off += p.length; } }
    const ext = meta.type.includes('mp4') ? 'mp4' : 'webm', base = { 'content-type': meta.type, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=86400', 'content-disposition': `inline; filename="LABBoard-video.${ext}"` };
    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
    if (range) { const a = range[1] ? +range[1] : meta.size - +range[2], b = range[1] && range[2] ? Math.min(+range[2], meta.size - 1) : meta.size - 1;
      return new Response(all.slice(a, b + 1), { status: 206, headers: { ...base, 'content-range': `bytes ${a}-${b}/${meta.size}`, 'content-length': String(b - a + 1) } }); }
    return new Response(all, { headers: { ...base, 'content-length': String(meta.size) } });
  }

  peers() { return this.ctx.getWebSockets().map(ws => ({ ws, a: ws.deserializeAttachment() || {} })).filter(p => p.a.id); }
  teacher() { return this.peers().find(p => p.a.role === 'teacher'); }
  send(ws, m) { try { ws.send(typeof m === 'string' ? m : JSON.stringify(m)); } catch (_) {} }
  broadcast(m, exceptWs) { const s = JSON.stringify(m); for (const p of this.peers()) if (p.ws !== exceptWs) this.send(p.ws, s); }
  roster() { this.broadcast({ t: 'roster', list: this.peers().sort((x, y) => x.a.joined - y.a.joined).map(p => ({ id: p.a.id, name: p.a.name, role: p.a.role })) }); }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string') return;
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    const a = ws.deserializeAttachment() || {};

    if (m.t === 'hello') return this.hello(ws, a, m);
    if (!a.id) return;                                   // спершу має бути hello

    const isT = a.role === 'teacher';
    if (TEACHER_ONLY.has(m.t) && !isT) return;
    m.from = a.id; m.fromName = a.name;

    if (m.t === 'lock') { const locked = !!m.v; await this.ctx.storage.put('locked', locked); return this.broadcast({ t: 'lock', v: locked }, ws); }
    if (m.t === 'want') { const t = this.teacher(); if (t) this.send(t.ws, { t: 'need', from: a.id }); return; }
    if (m.t === 'end') { this.broadcast(m, ws); await this.ctx.storage.deleteAll(); this.buffer = []; this.bufSize = 0; return; }

    if ((m.t === 'ops' || m.t === 'lv') && !isT) {
      if (await this.ctx.storage.get('locked')) { if (m.t === 'ops') this.send(ws, { t: 'denied' }); return; }
    }
    if (TO_TEACHER.has(m.t)) { const t = this.teacher(); if (t) this.send(t.ws, m); return; }

    // адресна сторінка для одного учня
    if ((m.t === 'page' || m.t === 'pagex') && m.to) { const p = this.peers().find(q => q.a.id === m.to); if (p) this.send(p.ws, m); return; }

    // зміни учнів, поки вчителя немає, — бережемо до його повернення
    if (m.t === 'ops' && !isT && !this.teacher()) { const s = JSON.stringify(m); if (this.bufSize + s.length <= MAX_BUFFER) { this.buffer.push(s); this.bufSize += s.length; } }

    this.broadcast(m, ws);
  }

  async hello(ws, a, m) {
    const role = m.role === 'teacher' ? 'teacher' : 'student';
    const id = String(m.id || '').slice(0, 40), name = String(m.name || (role === 'teacher' ? 'Учитель' : 'Учень')).slice(0, 40);
    if (!id) return;

    if (role === 'teacher') {
      const key = String(m.key || '');
      const saved = await this.ctx.storage.get('tkey'), seen = (await this.ctx.storage.get('tseen')) || 0;
      const online = this.teacher();
      if (saved && saved !== key && ((online && online.a.id !== id) || Date.now() - seen < STALE_MS)) { this.send(ws, { t: 'busy' }); try { ws.close(4001, 'busy'); } catch (_) {} return; }
      if (saved !== key) await this.ctx.storage.put({ tkey: key, locked: false });
      await this.ctx.storage.put('tseen', Date.now());
    }
    // те саме вікно перепідключилося — старе з'єднання закриваємо
    for (const p of this.peers()) if (p.a.id === id && p.ws !== ws) { try { p.ws.close(4000, 'replaced'); } catch (_) {} }

    ws.serializeAttachment({ id, name, role, joined: a.joined || Date.now() });
    if (role === 'teacher' && this.buffer.length) { for (const s of this.buffer) this.send(ws, s); this.buffer = []; this.bufSize = 0; }
    this.send(ws, { t: 'welcome', locked: !!(await this.ctx.storage.get('locked')), hasTeacher: !!this.teacher(), v: VERSION });
    this.roster();
  }

  async webSocketClose(ws) { await this.left(ws); }
  async webSocketError(ws) { await this.left(ws); }
  async left(ws) {
    const a = ws.deserializeAttachment() || {};
    ws.serializeAttachment({ id: null });
    try { ws.close(1000, 'bye'); } catch (_) {}
    if (a.role === 'teacher') await this.ctx.storage.put('tseen', Date.now());
    if (a.id) this.roster();
  }
}
