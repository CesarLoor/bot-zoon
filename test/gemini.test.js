import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../gemini.js';

const preguntas = [
  { id: 'uuid-a', texto: '¿Qué es una FK?', nombre: 'Ana Secreta' },
  { id: 'uuid-b', texto: '¿Para qué sirve la clave foránea?', nombre: '' },
];
const reply = (grupos) => new Response(JSON.stringify({
  status: 'completed',
  steps: [
    { type: 'thought' },
    { type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ grupos }) }] },
  ],
}));
const run = (fetch, extra = {}) => analyze({ titulo: 'BD', preguntas, apiKey: 'k', model: 'm', fetch, ...extra });
const status = (n) => (e) => e.status === n;

test('envía las preguntas sin nombres, sin almacenamiento, y devuelve los ids originales', async () => {
  let sent;
  const grupos = await run(async (url, options) => {
    sent = { url, ...options, body: JSON.parse(options.body) };
    return reply([{ ids: [1, 2], resumen: 'FK', sugerencia: 'Una FK referencia otra tabla.' }]);
  });
  assert.deepEqual(grupos, [{ ids: ['uuid-a', 'uuid-b'], resumen: 'FK', sugerencia: 'Una FK referencia otra tabla.' }]);
  assert.equal(sent.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(sent.headers['x-goog-api-key'], 'k');
  assert.equal(sent.body.model, 'm');
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.response_format.mime_type, 'application/json');
  assert.ok(sent.body.input.includes('¿Qué es una FK?'));
  assert.ok(!JSON.stringify(sent.body).includes('Ana Secreta'));
});

test('descarta ids inventados o repetidos y grupos mal formados', async () => {
  const grupos = await run(async () => reply([
    { ids: [1, 99], resumen: 'uno', sugerencia: 's' },
    { ids: [1, 2], resumen: 'dos', sugerencia: 's' },
    { ids: [77], resumen: 'fantasma', sugerencia: 's' },
    { ids: 'x', resumen: 'mal', sugerencia: 's' },
    null,
  ]));
  assert.deepEqual(grupos.map((g) => g.ids), [['uuid-a'], ['uuid-b']]);
});

test('sin preguntas no llama a la API', async () => {
  assert.deepEqual(await run(() => assert.fail('no debía llamar'), { preguntas: [] }), []);
});

test('sin clave avisa sin llamar a la API', async () => {
  await assert.rejects(run(() => assert.fail('no debía llamar'), { apiKey: '' }), status(503));
});

test('explica que el modelo está saturado y cómo cambiarlo', async (t) => {
  t.mock.method(console, 'error', () => {});
  await assert.rejects(run(async () => new Response('{}', { status: 503 })),
    (e) => e.status === 503 && /saturado.*GEMINI_MODEL/.test(e.message));
});

test('traduce cuota agotada, error del servicio, fallo de red y respuesta ilegible', async () => {
  await assert.rejects(run(async () => new Response('{}', { status: 429 })), status(429));
  await assert.rejects(run(async () => new Response('{}', { status: 400 })), status(502));
  await assert.rejects(run(async () => { throw new TypeError('fetch failed'); }), status(502));
  await assert.rejects(run(async () => new Response('{"steps":[]}')), status(502));
  await assert.rejects(run(async () => new Response('<html>')), status(502));
});
