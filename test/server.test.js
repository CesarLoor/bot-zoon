import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../store.js';
import { createServer } from 'node:http';
import { cloudflaredCommand, createApp, isThisApp, tunnelUrl } from '../server.js';

const KEY = 'clave-docente';

async function start(t, options = {}) {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'preguntas-')), 'datos.json'));
  const server = createApp({ store, teacherKey: KEY, ...options });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { body, key, ip, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(key && { authorization: `Bearer ${key}` }),
        ...(ip && { 'cf-connecting-ip': ip }),
      },
      body: raw ?? (body && JSON.stringify(body)),
    });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() };
  };
  const teacher = (method, path, body) => call(method, path, { body, key: KEY });
  const newClass = async () => (await teacher('POST', '/api/docente/clases', { titulo: 'BD' })).data.codigo;
  return { call, teacher, newClass, server };
}

test('las rutas del docente exigen la clave', async (t) => {
  const { call, newClass } = await start(t);
  const codigo = await newClass();
  for (const [method, path] of [
    ['GET', '/api/docente/clases'], ['POST', '/api/docente/clases'],
    ['GET', `/api/docente/clases/${codigo}`], ['POST', `/api/docente/clases/${codigo}/analizar`],
    ['POST', `/api/docente/clases/${codigo}/preguntas`], ['GET', `/api/docente/clases/${codigo}/csv`],
  ]) {
    assert.equal((await call(method, path)).status, 401, `${method} ${path}`);
    assert.equal((await call(method, path, { key: 'otra' })).status, 401, `${method} ${path}`);
  }
});

test('flujo completo: preguntar, analizar, publicar y exportar', async (t) => {
  const analyze = async ({ preguntas }) => [{ ids: preguntas.map((p) => p.id), resumen: 'R', sugerencia: 'SECRETA' }];
  const { call, teacher, newClass } = await start(t, { analyze, publicUrl: () => 'https://x.trycloudflare.com' });
  const codigo = await newClass();

  const sent = await call('POST', `/api/clase/${codigo}/preguntas`, { body: { texto: '¿Qué es?', nombre: 'Ana' } });
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.data, { ok: true });

  assert.equal((await teacher('POST', `/api/docente/clases/${codigo}/analizar`)).status, 200);
  const before = await call('GET', `/api/clase/${codigo}`);
  assert.deepEqual(before.data, { titulo: 'BD', respuestas: [] });

  const panel = (await teacher('GET', `/api/docente/clases/${codigo}`)).data;
  assert.equal(panel.preguntas[0].grupo.sugerencia, 'SECRETA');
  assert.equal(panel.enlace, `https://x.trycloudflare.com/?c=${codigo}`);

  const ids = [panel.preguntas[0].id];
  const published = await teacher('POST', `/api/docente/clases/${codigo}/preguntas`,
    { ids, estado: 'publicada', enunciado: 'E', respuesta: 'Respuesta' });
  assert.equal(published.status, 200);
  assert.deepEqual((await call('GET', `/api/clase/${codigo}`)).data.respuestas, [{ enunciado: 'E', respuesta: 'Respuesta' }]);

  const csv = await teacher('GET', `/api/docente/clases/${codigo}/csv`);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  assert.ok(csv.data.includes('Ana'));
  assert.equal((await teacher('GET', '/api/docente/clases')).data.clases.length, 1);
});

test('un error de Gemini llega como aviso y no cambia las preguntas', async (t) => {
  const analyze = async () => { throw Object.assign(new Error('Cuota agotada'), { status: 429 }); };
  const { teacher, newClass } = await start(t, { analyze });
  const codigo = await newClass();
  const res = await teacher('POST', `/api/docente/clases/${codigo}/analizar`);
  assert.equal(res.status, 429);
  assert.equal(res.data.error, 'Cuota agotada');
});

test('respuesta rápida: activar, cuenta regresiva, retener y publicar', async (t) => {
  let clock = Date.now();
  const analyze = async ({ preguntas }) => preguntas.map((p) => ({ ids: [p.id], resumen: 'R', sugerencia: 'S', tecnica: true }));
  const { call, teacher, newClass, server } = await start(t, { analyze, now: () => clock });
  const codigo = await newClass();
  const path = `/api/docente/clases/${codigo}`;
  for (const texto of ['uno', 'dos']) await call('POST', `/api/clase/${codigo}/preguntas`, { body: { texto } });
  for (const action of ['auto', 'posponer', 'retener']) {
    assert.equal((await call('POST', `${path}/${action}`)).status, 401, action);
  }
  let panel = (await teacher('GET', path)).data;
  assert.equal(panel.preguntas[0].restante, null);
  clock = Date.now() + 1000;
  assert.equal((await teacher('POST', `${path}/auto`, { activo: 'si' })).status, 400);

  assert.equal((await teacher('POST', `${path}/auto`, { activo: true })).status, 200);
  panel = (await teacher('GET', path)).data;
  assert.ok(panel.autoDesde);
  assert.equal(panel.preguntas[0].restante, 120_000);

  const [one, two] = panel.preguntas.map((p) => p.id);
  assert.equal((await teacher('POST', `${path}/retener`, { ids: [one] })).status, 200);
  clock += 60_000;
  assert.equal((await teacher('POST', `${path}/posponer`, { ids: [two] })).status, 200);
  panel = (await teacher('GET', path)).data;
  assert.deepEqual(panel.preguntas.map((p) => p.restante), [null, 120_000]);

  clock += 120_000;
  await server.auto.tick();
  assert.deepEqual((await call('GET', `/api/clase/${codigo}`)).data.respuestas, [{ enunciado: 'R', respuesta: 'S', rapida: true }]);
});

test('limita a 10 envíos por minuto por IP', async (t) => {
  let clock = 0;
  const { call, newClass } = await start(t, { now: () => clock });
  const path = `/api/clase/${await newClass()}/preguntas`;
  const send = (ip) => call('POST', path, { ip, body: { texto: 'p' } }).then((r) => r.status);
  for (let i = 0; i < 10; i++) assert.equal(await send('1.1.1.1'), 201);
  assert.equal(await send('1.1.1.1'), 429);
  assert.equal(await send('2.2.2.2'), 201);
  clock = 60_001;
  assert.equal(await send('1.1.1.1'), 201);
});

test('rechaza cuerpos grandes, JSON roto y rutas desconocidas', async (t) => {
  const { call, newClass } = await start(t);
  const path = `/api/clase/${await newClass()}/preguntas`;
  assert.equal((await call('POST', path, { raw: 'x'.repeat(5000) })).status, 413);
  assert.equal((await call('POST', path, { raw: '{roto' })).status, 400);
  assert.equal((await call('POST', path, { raw: 'null' })).status, 400);
  for (const p of ['/api/nada', '/data/datos.json', '/..%2fstore.js', '/store.js']) {
    assert.equal((await call('GET', p)).status, 404, p);
  }
});

test('un fallo interno no revela detalles', async (t) => {
  const analyze = async () => { throw new Error('ruta secreta C:/x'); };
  const { teacher, newClass } = await start(t, { analyze });
  t.mock.method(console, 'error', () => {});
  const res = await teacher('POST', `/api/docente/clases/${await newClass()}/analizar`);
  assert.equal(res.status, 500);
  assert.ok(!res.data.error.includes('secreta'));
});

test('sirve las dos páginas con cabeceras de seguridad', async (t) => {
  const { call } = await start(t);
  for (const path of ['/', '/?c=abc', '/docente']) {
    const res = await call('GET', path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  }
});

test('usa cloudflared instalado aunque la terminal no lo tenga en el PATH', () => {
  const folder = mkdtempSync(join(tmpdir(), 'programas-'));
  const env = { 'ProgramFiles(x86)': folder };
  assert.equal(cloudflaredCommand(env), 'cloudflared');
  assert.equal(cloudflaredCommand({}), 'cloudflared');
  mkdirSync(join(folder, 'cloudflared'));
  writeFileSync(join(folder, 'cloudflared', 'cloudflared.exe'), '');
  assert.equal(cloudflaredCommand(env), join(folder, 'cloudflared', 'cloudflared.exe'));
});

test('distingue si el puerto ocupado es esta misma app', async (t) => {
  const ours = createApp({ store: null, teacherKey: KEY });
  const foreign = createServer((req, res) => res.end('<title>Otra cosa</title>'));
  for (const server of [ours, foreign]) {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    t.after(() => server.close());
  }
  assert.equal(await isThisApp(ours.address().port), true);
  assert.equal(await isThisApp(foreign.address().port), false);
  assert.equal(await isThisApp(1), false);
});

test('reconoce la URL pública en la salida de cloudflared', () => {
  assert.equal(tunnelUrl('INF |  https://uno-dos-tres.trycloudflare.com  |'), 'https://uno-dos-tres.trycloudflare.com');
  assert.equal(tunnelUrl('error contacting https://api.trycloudflare.com/tunnel'), null);
  assert.equal(tunnelUrl('INF Starting tunnel'), null);
});
