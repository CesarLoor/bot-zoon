import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../store.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'preguntas-')), 'data', 'datos.json');

function setup() {
  const file = tmpFile();
  const store = createStore(file);
  const { codigo } = store.createClass('Bases de datos');
  return { file, store, codigo };
}
const status = (n) => (e) => e.status === n;

test('una clase nueva tiene codigo aleatorio y empieza sin preguntas', () => {
  const { store, codigo } = setup();
  assert.match(codigo, /^[\w-]{8}$/);
  assert.equal(store.getClass(codigo).titulo, 'Bases de datos');
  assert.deepEqual(store.getClass(codigo).preguntas, []);
  assert.notEqual(store.createClass('Otra').codigo, codigo);
  assert.equal(store.listClasses().length, 2);
});

test('rechaza clase sin titulo o inexistente', () => {
  const { store } = setup();
  assert.throws(() => store.createClass('   '), status(400));
  assert.throws(() => store.createClass('x'.repeat(121)), status(400));
  assert.throws(() => store.getClass('noexiste'), status(404));
});

test('guarda la pregunta recortada, pendiente y con nombre opcional', () => {
  const { store, codigo } = setup();
  const q = store.addQuestion(codigo, { texto: '  ¿Qué es una FK?  ' });
  assert.equal(q.texto, '¿Qué es una FK?');
  assert.equal(q.nombre, '');
  assert.equal(q.estado, 'pendiente');
});

test('valida el texto y el nombre de la pregunta', () => {
  const { store, codigo } = setup();
  for (const body of [{}, { texto: '  ' }, { texto: 5 }, { texto: 'x'.repeat(501) },
    { texto: 'ok', nombre: 'n'.repeat(61) }, { texto: 'ok', nombre: {} }]) {
    assert.throws(() => store.addQuestion(codigo, body), status(400), JSON.stringify(body));
  }
});

test('limita a 500 preguntas por clase', () => {
  const { store, codigo } = setup();
  for (let i = 0; i < 500; i++) store.addQuestion(codigo, { texto: `p${i}` });
  assert.throws(() => store.addQuestion(codigo, { texto: 'una más' }), status(429));
});

test('lo guardado sobrevive a un reinicio', () => {
  const { file, store, codigo } = setup();
  store.addQuestion(codigo, { texto: 'persistente' });
  assert.equal(createStore(file).getClass(codigo).preguntas[0].texto, 'persistente');
});

test('un archivo dañado detiene el arranque y no se sobrescribe', () => {
  const { file } = setup();
  writeFileSync(file, '{roto');
  assert.throws(() => createStore(file));
  assert.equal(readFileSync(file, 'utf8'), '{roto');
});

test('publicar exige enunciado y respuesta, y se aplica a todo el grupo', () => {
  const { store, codigo } = setup();
  const a = store.addQuestion(codigo, { texto: 'a', nombre: 'Ana' });
  const b = store.addQuestion(codigo, { texto: 'b' });
  const ids = [a.id, b.id];
  assert.throws(() => store.update(codigo, { ids, estado: 'publicada', enunciado: 'e' }), status(400));
  store.update(codigo, { ids, estado: 'publicada', enunciado: 'E', respuesta: 'R' });
  assert.deepEqual(store.publicView(codigo), {
    titulo: 'Bases de datos',
    respuestas: [{ enunciado: 'E', respuesta: 'R' }],
  });
});

test('la vista del estudiante no muestra pendientes ni sugerencias', () => {
  const { store, codigo } = setup();
  const a = store.addQuestion(codigo, { texto: 'secreta', nombre: 'Ana' });
  store.applyAnalysis(codigo, [{ ids: [a.id], resumen: 'res', sugerencia: 'sug' }]);
  assert.deepEqual(store.publicView(codigo).respuestas, []);
});

test('reabrir una pregunta retira la respuesta publicada', () => {
  const { store, codigo } = setup();
  const a = store.addQuestion(codigo, { texto: 'a' });
  store.update(codigo, { ids: [a.id], estado: 'publicada', enunciado: 'E', respuesta: 'R' });
  store.update(codigo, { ids: [a.id], estado: 'pendiente' });
  assert.deepEqual(store.publicView(codigo).respuestas, []);
});

test('reabrir una sola pregunta de un grupo publicado reabre todo el grupo', () => {
  const { store, codigo } = setup();
  const ids = ['a', 'b'].map((texto) => store.addQuestion(codigo, { texto }).id);
  store.update(codigo, { ids, estado: 'publicada', enunciado: 'E', respuesta: 'R' });
  store.update(codigo, { ids: [ids[0]], estado: 'pendiente' });
  assert.deepEqual(store.publicView(codigo).respuestas, []);
  assert.deepEqual(store.getClass(codigo).preguntas.map((p) => p.estado), ['pendiente', 'pendiente']);
});

test('rechaza estados e ids inválidos sin cambiar nada', () => {
  const { store, codigo } = setup();
  const a = store.addQuestion(codigo, { texto: 'a' });
  assert.throws(() => store.update(codigo, { ids: [a.id], estado: 'borrada' }), status(400));
  assert.throws(() => store.update(codigo, { ids: [], estado: 'oral' }), status(400));
  assert.throws(() => store.update(codigo, { ids: [a.id, 'x'], estado: 'oral' }), status(400));
  assert.equal(store.getClass(codigo).preguntas[0].estado, 'pendiente');
});

test('el análisis agrupa solo las pendientes y reemplaza la agrupación anterior', () => {
  const { store, codigo } = setup();
  const [a, b, c] = ['a', 'b', 'c'].map((texto) => store.addQuestion(codigo, { texto }));
  store.applyAnalysis(codigo, [{ ids: [a.id, b.id], resumen: 'v1', sugerencia: 's1' }]);
  store.update(codigo, { ids: [a.id], estado: 'oral' });
  store.applyAnalysis(codigo, [{ ids: [a.id, c.id], resumen: 'v2', sugerencia: 's2' }]);
  const [qa, qb, qc] = store.getClass(codigo).preguntas;
  assert.equal(qa.grupo.resumen, 'v1');
  assert.equal(qb.grupo, null);
  assert.equal(qc.grupo.resumen, 'v2');
});

test('exporta CSV con comillas escapadas y sin fórmulas ejecutables', () => {
  const { store, codigo } = setup();
  store.addQuestion(codigo, { texto: '=HYPERLINK("x")', nombre: '@ana' });
  const csv = store.toCSV(codigo);
  assert.ok(csv.startsWith('﻿"fecha","nombre","pregunta","estado"'));
  assert.ok(csv.includes('"\'@ana","\'=HYPERLINK(""x"")","pendiente"'));
});
