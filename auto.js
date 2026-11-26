import { dueAt } from './store.js';

// shortcut: one AI call per 20 s however many questions fall due; shorten only with a larger Gemini quota.
const GAP_MS = 20_000;
const RETRY_MS = 60_000;

/** Publishes a quick answer to technical questions the teacher has not handled in time. */
export function createAutoAnswer({ store, analyze, now = Date.now }) {
  let busy = false;
  let notBefore = 0;
  let warning = null;

  const ready = (clase, pregunta) => {
    const due = dueAt(clase, pregunta, now());
    return due !== null && due <= now();
  };

  // Reads the class again: the teacher may have acted while the AI was answering.
  function stillWaiting(codigo, ids, accept = ready) {
    const clase = store.getClass(codigo);
    return clase.preguntas.filter((p) => ids.includes(p.id) && accept(clase, p)).map((p) => p.id);
  }

  function resolve(codigo, ids, { resumen, sugerencia, tecnica }) {
    if (!ids.length) return;
    if (tecnica !== true) return store.hold(codigo, ids, 'no-tecnica');
    if (!resumen.trim() || !sugerencia.trim()) return store.hold(codigo, ids, 'sin-respuesta');
    store.update(codigo, { ids, estado: 'publicada', enunciado: resumen, respuesta: sugerencia }, { rapida: true });
  }

  async function answer(codigo) {
    const clase = store.getClass(codigo);
    const due = clase.preguntas.filter((p) => ready(clase, p));

    // Groups the teacher already analysed carry a draft, so they need no new AI call.
    // Those saved by an earlier version were never classified, so they are asked again.
    const classified = (p) => typeof p.grupo?.tecnica === 'boolean';
    const drafted = new Map(due.filter(classified).map((p) => [p.grupo.id, p.grupo]));
    for (const group of drafted.values()) {
      const members = clase.preguntas.filter((p) => p.grupo?.id === group.id).map((p) => p.id);
      const waiting = (c, p) => dueAt(c, p, now()) !== null;
      resolve(codigo, stillWaiting(codigo, members, waiting), group);
    }

    const loose = due.filter((p) => !classified(p));
    if (!loose.length || now() < notBefore) return;
    notBefore = now() + GAP_MS;
    let groups;
    try {
      groups = await analyze({ titulo: clase.titulo, preguntas: loose });
      warning = null;
    } catch (error) {
      console.error('Respuesta rápida:', error.message);
      warning = error.status ? error.message : 'Error interno. Revisa la ventana negra.';
      notBefore = now() + RETRY_MS;
      return;
    }
    for (const group of groups) resolve(codigo, stillWaiting(codigo, group.ids), group);
    const answered = new Set(groups.flatMap((g) => g.ids));
    const omitted = stillWaiting(codigo, loose.filter((p) => !answered.has(p.id)).map((p) => p.id));
    if (omitted.length) store.hold(codigo, omitted, 'sin-respuesta');
  }

  return {
    warning: () => warning,
    async tick() {
      if (busy) return;
      busy = true;
      try {
        for (const codigo of store.autoClasses()) await answer(codigo);
      } catch (error) {
        console.error('Respuesta rápida:', error);
      } finally {
        busy = false;
      }
    },
  };
}
