import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, dueAt, WAIT_MS } from '../store.js';
import { createAutoAnswer } from '../auto.js';

const technical = async ({ preguntas }) => preguntas.map((p) => ({ ids: [p.id], resumen: `R ${p.texto}`, sugerencia: 'S', tecnica: true }));

function setup(texts = ['¿Qué es una FK?'], analyze = technical) {
  const store = createStore(join(mkdtempSync(join(tmpdir(), 'preguntas-')), 'datos.json'));
  const { codigo } = store.createClass('BD');
  const ids = texts.map((texto) => store.addQuestion(codigo, { texto }).id);
  const calls = [];
  let clock = Date.now();
  store.setAuto(codigo, true, clock);
  const auto = createAutoAnswer({
    store,
    now: () => clock,
    analyze: (input) => { calls.push(input); return analyze(input, { store, codigo, ids, now: () => clock }); },
  });
  const advance = async (ms) => { clock += ms; await auto.tick(); };
  const states = () => store.getClass(codigo).preguntas.map((p) => p.estado);
  return { store, codigo, ids, calls, auto, advance, states, now: () => clock };
}

test('no responde antes de 2 minutos y después publica como respuesta rápida', async () => {
  const { store, codigo, calls, advance, states } = setup();
  assert.equal(WAIT_MS, 120_000);
  await advance(WAIT_MS - 1000);
  assert.equal(calls.length, 0);
  assert.deepEqual(states(), ['pendiente']);
  await advance(2000);
  assert.deepEqual(states(), ['publicada']);
  assert.deepEqual(store.publicView(codigo).respuestas, [{ enunciado: 'R ¿Qué es una FK?', respuesta: 'S', rapida: true }]);
});

test('con la función apagada no responde ni llama a la IA', async () => {
  const { store, codigo, calls, advance, states } = setup();
  store.setAuto(codigo, false);
  await advance(WAIT_MS * 3);
  assert.equal(calls.length, 0);
  assert.deepEqual(states(), ['pendiente']);
});

test('al activarla, las preguntas antiguas esperan 2 minutos desde la activación', async () => {
  const { store, codigo, advance, states, now } = setup();
  store.setAuto(codigo, false);
  await advance(600_000);
  store.setAuto(codigo, true, now());
  await advance(WAIT_MS - 1000);
  assert.deepEqual(states(), ['pendiente']);
  await advance(2000);
  assert.deepEqual(states(), ['publicada']);
});

test('no toca preguntas de hace más de 30 minutos', async () => {
  const { calls, advance, states } = setup();
  await advance(31 * 60_000);
  assert.equal(calls.length, 0);
  assert.deepEqual(states(), ['pendiente']);
});

test('una pregunta no técnica queda para el docente y no se vuelve a consultar', async () => {
  const analyze = async ({ preguntas }) => [{ ids: [preguntas[0].id], resumen: 'Examen', sugerencia: 'S', tecnica: false }];
  const { store, codigo, calls, advance, states } = setup(['¿Cuándo es el examen?'], analyze);
  await advance(WAIT_MS);
  await advance(60_000);
  assert.equal(calls.length, 1);
  assert.deepEqual(states(), ['pendiente']);
  assert.equal(store.getClass(codigo).preguntas[0].sinIA, 'no-tecnica');
});

test('si la IA omite una pregunta, queda para el docente', async () => {
  const { store, codigo, calls, advance } = setup(['a'], async () => []);
  await advance(WAIT_MS);
  await advance(60_000);
  assert.equal(calls.length, 1);
  assert.equal(store.getClass(codigo).preguntas[0].sinIA, 'sin-respuesta');
});

test('"Yo respondo" detiene la cuenta', async () => {
  const { store, codigo, ids, calls, advance, states } = setup();
  store.hold(codigo, ids, 'docente');
  await advance(WAIT_MS * 2);
  assert.equal(calls.length, 0);
  assert.deepEqual(states(), ['pendiente']);
});

test('escribir en la tarjeta reinicia los 2 minutos', async () => {
  const { store, codigo, ids, advance, states, now } = setup();
  await advance(WAIT_MS - 5000);
  store.postpone(codigo, ids, now());
  await advance(WAIT_MS - 1000);
  assert.deepEqual(states(), ['pendiente']);
  await advance(2000);
  assert.deepEqual(states(), ['publicada']);
});

test('si el docente actúa mientras la IA piensa, no se publica', async () => {
  for (const act of [
    ({ store, codigo, ids }) => store.hold(codigo, ids, 'docente'),
    ({ store, codigo, ids, now }) => store.postpone(codigo, ids, now()),
    ({ store, codigo, ids }) => store.update(codigo, { ids, estado: 'oral' }),
    ({ store, codigo }) => store.setAuto(codigo, false),
  ]) {
    const { store, codigo, advance } = setup(['a'], async (input, context) => {
      act(context);
      return technical(input);
    });
    await advance(WAIT_MS);
    assert.deepEqual(store.publicView(codigo).respuestas, [], act.toString());
  }
});

test('un grupo ya analizado se publica con su borrador sin volver a consultar', async () => {
  const { store, codigo, ids, calls, advance, states } = setup(['a', 'b']);
  store.applyAnalysis(codigo, [{ ids, resumen: 'AB', sugerencia: 'borrador', tecnica: true }]);
  await advance(WAIT_MS);
  assert.equal(calls.length, 0);
  assert.deepEqual(states(), ['publicada', 'publicada']);
  assert.equal(store.publicView(codigo).respuestas.length, 1);
});

test('un grupo analizado sin clasificar (versión anterior) se vuelve a consultar', async () => {
  const { store, codigo, ids, calls, advance, states } = setup(['a']);
  store.applyAnalysis(codigo, [{ ids, resumen: 'A', sugerencia: 'borrador antiguo' }]);
  await advance(WAIT_MS);
  assert.equal(calls.length, 1);
  assert.deepEqual(states(), ['publicada']);
});

test('una respuesta rápida reabierta no se vuelve a publicar sola', async () => {
  const { store, codigo, ids, advance, states } = setup();
  await advance(WAIT_MS);
  store.update(codigo, { ids, estado: 'pendiente' });
  await advance(WAIT_MS);
  assert.deepEqual(states(), ['pendiente']);
});

test('junta las vencidas en una consulta y espera 20 segundos entre consultas', async () => {
  const { store, codigo, calls, advance, now } = setup(['a', 'b']);
  await advance(WAIT_MS);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].preguntas.length, 2);
  const late = store.addQuestion(codigo, { texto: 'c' });
  store.postpone(codigo, [late.id], now() - WAIT_MS);
  await advance(10_000);
  assert.equal(calls.length, 1);
  await advance(11_000);
  assert.equal(calls.length, 2);
});

test('si la IA falla avisa, espera un minuto y reintenta', async (t) => {
  t.mock.method(console, 'error', () => {});
  let broken = true;
  const analyze = async (input) => {
    if (broken) throw Object.assign(new Error('Cuota agotada'), { status: 429 });
    return technical(input);
  };
  const { auto, calls, advance, states } = setup(['a'], analyze);
  await advance(WAIT_MS);
  assert.equal(auto.warning(), 'Cuota agotada');
  await advance(30_000);
  assert.equal(calls.length, 1);
  broken = false;
  await advance(31_000);
  assert.equal(auto.warning(), null);
  assert.deepEqual(states(), ['publicada']);
});

test('no lanza dos consultas a la vez', async () => {
  let release;
  const { auto, calls, advance } = setup(['a'], (input) => new Promise((done) => { release = () => done(technical(input)); }));
  const first = advance(WAIT_MS);
  await auto.tick();
  assert.equal(calls.length, 1);
  release();
  await first;
});

test('dueAt no da hora a lo que no puede responderse solo', () => {
  const { store, codigo } = setup();
  const clase = store.getClass(codigo);
  assert.ok(dueAt(clase, clase.preguntas[0]) > Date.now());
  assert.equal(dueAt({ ...clase, autoDesde: null }, clase.preguntas[0]), null);
  assert.equal(dueAt(clase, { ...clase.preguntas[0], estado: 'oral' }), null);
});
