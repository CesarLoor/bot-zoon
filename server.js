import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createStore, dueAt, httpError } from './store.js';
import { analyze as geminiAnalyze } from './gemini.js';
import { createAutoAnswer } from './auto.js';

const root = import.meta.dirname;
// Only these files are public; request paths never reach the file system.
const PAGES = { '/': 'index.html', '/docente': 'docente.html' };
const SECURITY = {
  'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

export const tunnelUrl = (output) => output.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null;

// A terminal opened before the install keeps the old PATH, so look in the installer's folder too.
export function cloudflaredCommand(env = process.env) {
  const installed = join(env['ProgramFiles(x86)'] ?? '', 'cloudflared', 'cloudflared.exe');
  return env['ProgramFiles(x86)'] && existsSync(installed) ? installed : 'cloudflared';
}

export async function isThisApp(port) {
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return (await page.text()).includes('<title>Preguntas de la clase</title>');
  } catch {
    return false;
  }
}

function openBrowser(url) {
  spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore' })
    .on('error', () => console.log('Abre a mano el enlace del panel.'));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // Oversized data is drained, not kept, so the client still receives the 413.
      if (size <= limit) chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (size > limit) return reject(httpError(413, 'El envío es demasiado grande.'));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        if (!body || typeof body !== 'object') throw new Error();
        resolve(body);
      } catch {
        reject(httpError(400, 'Datos no válidos.'));
      }
    });
  });
}

export function createApp({ store, teacherKey, analyze = geminiAnalyze, publicUrl = () => null, now = Date.now }) {
  const expected = Buffer.from(`Bearer ${teacherKey}`);
  const sends = new Map();
  const ask = ({ titulo, preguntas }) => analyze({
    titulo,
    preguntas,
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
  });
  const auto = createAutoAnswer({ store, analyze: ask, now });

  function checkRate(ip) {
    const time = now();
    const recent = (sends.get(ip) ?? []).filter((t) => time - t < 60_000);
    if (recent.length >= 10) throw httpError(429, 'Demasiadas preguntas seguidas. Espera un minuto.');
    sends.set(ip, [...recent, time]);
  }

  async function route(req, res) {
    const { pathname } = new URL(req.url, 'http://local');
    const send = (status, body, type = 'application/json', headers = {}) => {
      res.writeHead(status, { ...SECURITY, 'content-type': `${type}; charset=utf-8`, ...headers });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };

    if (req.method === 'GET' && Object.hasOwn(PAGES, pathname)) {
      return send(200, readFileSync(join(root, 'public', PAGES[pathname])), 'text/html');
    }

    const student = pathname.match(/^\/api\/clase\/([\w-]+)(\/preguntas)?$/);
    if (student) {
      const [, codigo, questions] = student;
      if (req.method === 'GET' && !questions) return send(200, store.publicView(codigo));
      if (req.method === 'POST' && questions) {
        checkRate(req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress);
        store.addQuestion(codigo, await readBody(req, 4096));
        return send(201, { ok: true });
      }
    }

    if (pathname.startsWith('/api/docente/')) {
      const given = Buffer.from(req.headers.authorization ?? '');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        throw httpError(401, 'Clave de docente incorrecta. Abre el enlace que muestra la consola.');
      }
      if (pathname === '/api/docente/clases') {
        if (req.method === 'GET') return send(200, { clases: store.listClasses() });
        if (req.method === 'POST') return send(201, store.createClass((await readBody(req, 4096)).titulo));
      }
      const [, codigo, action] = pathname.match(/^\/api\/docente\/clases\/([\w-]+)(?:\/(analizar|preguntas|csv|auto|posponer|retener))?$/) ?? [];
      if (codigo) {
        if (req.method === 'GET' && !action) {
          const base = publicUrl();
          const clase = store.getClass(codigo);
          const time = now();
          const preguntas = clase.preguntas.map((p) => {
            const due = dueAt(clase, p, time);
            return { ...p, restante: due === null ? null : Math.max(0, due - time) };
          });
          return send(200, {
            ...clase, preguntas, enlace: base && `${base}/?c=${codigo}`,
            avisoAuto: clase.autoDesde ? auto.warning() : null,
          });
        }
        if (req.method === 'POST' && action === 'auto') {
          const { activo } = await readBody(req, 4096);
          if (typeof activo !== 'boolean') throw httpError(400, 'Datos no válidos.');
          store.setAuto(codigo, activo, now());
          return send(200, { ok: true });
        }
        if (req.method === 'POST' && (action === 'posponer' || action === 'retener')) {
          const { ids } = await readBody(req, 64 * 1024);
          if (action === 'posponer') store.postpone(codigo, ids, now());
          else store.hold(codigo, ids, 'docente');
          return send(200, { ok: true });
        }
        if (req.method === 'GET' && action === 'csv') {
          return send(200, store.toCSV(codigo), 'text/csv', { 'content-disposition': `attachment; filename="clase-${codigo}.csv"` });
        }
        if (req.method === 'POST' && action === 'preguntas') {
          store.update(codigo, await readBody(req, 64 * 1024));
          return send(200, { ok: true });
        }
        if (req.method === 'POST' && action === 'analizar') {
          const { titulo, preguntas } = store.getClass(codigo);
          const grupos = await ask({ titulo, preguntas: preguntas.filter((p) => p.estado === 'pendiente') });
          store.applyAnalysis(codigo, grupos);
          return send(200, { grupos: grupos.length });
        }
      }
    }
    throw httpError(404, 'No encontrado.');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((error) => {
      if (!error.status) console.error(error);
      res.writeHead(error.status ?? 500, { ...SECURITY, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.status ? error.message : 'Error interno. Revisa la consola.' }));
    });
  });
  server.auto = auto;
  return server;
}

function loadTeacherKey(file) {
  if (!existsSync(file)) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, randomBytes(18).toString('base64url'));
  }
  const key = readFileSync(file, 'utf8').trim();
  if (key.length < 16) throw new Error(`Clave dañada: borra ${file} y vuelve a iniciar.`);
  return key;
}

function startTunnel(port, onUrl) {
  const child = spawn(cloudflaredCommand(), ['tunnel', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let output = '';
  let found = false;
  child.stderr.on('data', (chunk) => {
    if (found) return;
    output = (output + chunk).slice(-4000);
    const url = tunnelUrl(output);
    if (url) {
      found = true;
      onUrl(url);
    }
  });
  child.on('error', (error) => console.log(error.code === 'ENOENT'
    ? 'cloudflared no está instalado: los estudiantes no podrán entrar. Instálalo con: winget install --id Cloudflare.cloudflared'
    : `No se pudo iniciar cloudflared: ${error.message}`));
  child.on('exit', (code) => {
    onUrl(null);
    console.log(`El túnel público se cerró (código ${code}). Reinicia con npm start.`);
  });
  process.on('exit', () => child.kill());
}

if (import.meta.main) {
  const port = Number(process.env.PORT) || 3000;
  const data = join(root, 'data');
  const teacherKey = loadTeacherKey(join(data, 'clave-docente.txt'));
  let publicUrl = null;
  const app = createApp({ store: createStore(join(data, 'datos.json')), teacherKey, publicUrl: () => publicUrl });

  // The key travels after "#", which browsers never send to a server.
  const panel = `http://localhost:${port}/docente#${teacherKey}`;
  const autoOpen = Boolean(process.env.ABRIR_PANEL);

  app.on('error', async (error) => {
    // A second double click just shows the panel of the copy that is already running.
    if (error.code === 'EADDRINUSE' && autoOpen && await isThisApp(port)) {
      openBrowser(panel);
      process.exitCode = 0;
      return;
    }
    console.error(error.code === 'EADDRINUSE'
      ? `El puerto ${port} está ocupado: quizá la app ya está abierta en otra ventana. Ciérrala o cambia PORT en .env.`
      : error.message);
    process.exit(1);
  });
  app.listen(port, '127.0.0.1', () => {
    console.log(`\nPanel del docente (no lo compartas):\n  ${panel}\n`);
    // Runs in the server so quick answers work even if the panel is hidden or closed.
    setInterval(app.auto.tick, 5000);
    if (autoOpen) openBrowser(panel);
    if (process.env.SIN_TUNEL) return;
    startTunnel(port, (url) => {
      publicUrl = url;
      if (url) console.log(`Enlace público listo: ${url}\nCopia el enlace de la clase desde el panel.`);
    });
  });
}
