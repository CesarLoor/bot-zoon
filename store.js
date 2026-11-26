import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const ESTADOS = ['pendiente', 'publicada', 'oral', 'descartada'];
const MAX_PREGUNTAS = 500;

export const httpError = (status, message) => Object.assign(new Error(message), { status });

function text(value, field, max, optional = false) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string') throw httpError(400, `Falta ${field}.`);
  const clean = value.trim();
  if (!clean && !optional) throw httpError(400, `Falta ${field}.`);
  if (clean.length > max) throw httpError(400, `${field}: máximo ${max} caracteres.`);
  return clean;
}

// Spreadsheet apps run cells that start with these characters as formulas.
const csvCell = (value) => {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
};

export function createStore(file) {
  // A damaged file throws here, so it is never overwritten with an empty one.
  let data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { clases: [] };

  const find = (source, codigo) => {
    const clase = source.clases.find((c) => c.codigo === codigo);
    if (!clase) throw httpError(404, 'Clase no encontrada.');
    return clase;
  };

  // Memory changes only after the disk write succeeds.
  function mutate(change) {
    const next = structuredClone(data);
    const result = change(next);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2));
    renameSync(`${file}.tmp`, file);
    data = next;
    return structuredClone(result);
  }

  return {
    createClass(titulo) {
      const clean = text(titulo, 'el título', 120);
      return mutate((d) => {
        const clase = {
          codigo: randomBytes(6).toString('base64url'),
          titulo: clean,
          creada: new Date().toISOString(),
          preguntas: [],
        };
        d.clases.push(clase);
        return clase;
      });
    },

    listClasses: () => data.clases.map(({ codigo, titulo, creada }) => ({ codigo, titulo, creada })),

    getClass: (codigo) => structuredClone(find(data, codigo)),

    addQuestion(codigo, body = {}) {
      const texto = text(body?.texto, 'la pregunta', 500);
      const nombre = text(body?.nombre, 'el nombre', 60, true);
      return mutate((d) => {
        const { preguntas } = find(d, codigo);
        if (preguntas.length >= MAX_PREGUNTAS) throw httpError(429, 'La clase llegó al máximo de preguntas.');
        const pregunta = {
          id: randomUUID(), texto, nombre, creada: new Date().toISOString(),
          estado: 'pendiente', grupo: null, publicacion: null,
        };
        preguntas.push(pregunta);
        return pregunta;
      });
    },

    update(codigo, body = {}) {
      const { ids, estado } = body ?? {};
      if (!ESTADOS.includes(estado)) throw httpError(400, 'Estado no válido.');
      if (!Array.isArray(ids) || !ids.length) throw httpError(400, 'Faltan las preguntas.');
      const publicacion = estado !== 'publicada' ? null : {
        id: randomUUID(),
        enunciado: text(body.enunciado, 'el enunciado', 500),
        respuesta: text(body.respuesta, 'la respuesta', 3000),
      };
      return mutate((d) => {
        const { preguntas } = find(d, codigo);
        const chosen = ids.map((id) => {
          const pregunta = preguntas.find((p) => p.id === id);
          if (!pregunta) throw httpError(400, 'Pregunta no encontrada.');
          return pregunta;
        });
        // Questions that share a published answer change together, or the answer would stay visible.
        const shared = new Set(chosen.map((p) => p.publicacion?.id).filter(Boolean));
        for (const p of preguntas) {
          if (chosen.includes(p) || shared.has(p.publicacion?.id)) Object.assign(p, { estado, publicacion });
        }
        return null;
      });
    },

    applyAnalysis(codigo, grupos) {
      return mutate((d) => {
        const pending = find(d, codigo).preguntas.filter((p) => p.estado === 'pendiente');
        for (const p of pending) p.grupo = null;
        for (const { ids, resumen, sugerencia } of grupos) {
          const grupo = { id: randomUUID(), resumen, sugerencia };
          for (const p of pending) if (ids.includes(p.id)) p.grupo = grupo;
        }
        return null;
      });
    },

    publicView(codigo) {
      const { titulo, preguntas } = find(data, codigo);
      const unique = new Map(preguntas.filter((p) => p.publicacion).map((p) => [p.publicacion.id, p.publicacion]));
      return { titulo, respuestas: [...unique.values()].map(({ enunciado, respuesta }) => ({ enunciado, respuesta })) };
    },

    toCSV(codigo) {
      const header = ['fecha', 'nombre', 'pregunta', 'estado', 'grupo', 'enunciado publicado', 'respuesta'];
      const rows = find(data, codigo).preguntas.map((p) => [
        p.creada, p.nombre, p.texto, p.estado, p.grupo?.resumen ?? '',
        p.publicacion?.enunciado ?? '', p.publicacion?.respuesta ?? '',
      ]);
      // The BOM makes Excel read accents correctly.
      return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
    },
  };
}
