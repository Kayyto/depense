/**
 * Carnet de dépenses de voyage — Worker Cloudflare (D1) + connexion par le compte central Kayto.
 * Remplace Firebase (Firestore, collection "trips") : un voyage = un document identifié par son code.
 *
 *   GET  /api/me                 -> { account:{name,email}, lastCode }
 *   PUT  /api/me/code            { code } -> { ok:true }
 *   GET  /api/trips/:code        ?rev=N  -> { rev, state, unchanged? }
 *   PUT  /api/trips/:code        { state } -> { ok:true, rev }
 *
 * Tout le reste est servi tel quel depuis /public.
 */

const COMPTE_URL = 'https://compte.kayto.org';
const APP_SLUG = 'depense';
const SESSION_COOKIE = 'kc_depense';
const SESSION_CACHE_MS = 30000;
const sessionCache = new Map();
const MAX_STATE_BYTES = 900000;
const CODE_RE = /^[^\s/\\?#][^/\\?#]{0,63}$/;

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

function lireCookie(request, nom) {
  const brut = request.headers.get('Cookie') || '';
  for (const part of brut.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === nom) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

async function sha256Hex(texte) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texte));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getCentralAccount(request, env) {
  const token = lireCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const key = await sha256Hex(token);
  const hit = sessionCache.get(key);
  if (hit && Date.now() - hit.at < SESSION_CACHE_MS) return hit.account;
  let account = null;
  try {
    const sessionUrl = `${(env && env.COMPTE_URL) || COMPTE_URL}/api/session?app=${APP_SLUG}`;
    const init = { headers: { Cookie: `${SESSION_COOKIE}=${token}` } };
    const res =
      env && env.COMPTE && typeof env.COMPTE.fetch === 'function'
        ? await env.COMPTE.fetch(new Request(sessionUrl, init))
        : await fetch(sessionUrl, init);
    if (res.ok) {
      const data = await res.json();
      if (data.authenticated && data.account && data.account.app === APP_SLUG && typeof data.account.id === 'string' && data.account.id) {
        account = {
          id: data.account.id,
          name: String(data.account.name || '').trim() || 'Profil',
          email: String(data.account.email || '').trim().toLowerCase(),
        };
      }
    } else {
      return null; // erreur technique : on ne la garde pas en cache
    }
  } catch (e) {
    console.error('Service de comptes injoignable :', e.message);
    return null; // par sécurité : pas de session valide si on ne peut pas vérifier
  }
  if (sessionCache.size > 500) sessionCache.clear();
  sessionCache.set(key, { at: Date.now(), account });
  return account;
}

// Protection CSRF : une requête qui modifie des données avec un Origin étranger est refusée.
function origineAutorisee(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch (e) {
    return false;
  }
}

function nettoyerCode(brut) {
  let code;
  try { code = decodeURIComponent(String(brut || '')); } catch (e) { return null; }
  code = code.trim();
  return CODE_RE.test(code) ? code : null;
}

function etatVide() {
  return { tripName: '', people: [], expenses: [] };
}

async function handleRate(request) {
  const url = new URL(request.url);
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request('https://rate.internal/eur-jpy');
  if (cache && url.searchParams.get('fresh') !== '1') {
    const hit = await cache.match(key);
    if (hit) return json(await hit.json());
  }
  const sources = [
    async () => { const j = await (await fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=JPY')).json(); return { rate: j.rates.JPY, date: j.date }; },
    async () => { const j = await (await fetch('https://open.er-api.com/v6/latest/EUR')).json(); return { rate: j.rates.JPY, date: String(j.time_last_update_utc || '').slice(5, 16) }; },
  ];
  for (const src of sources) {
    try {
      const o = await src();
      if (o && o.rate > 0) {
        const out = { rate: o.rate, date: o.date, from: 'EUR', to: 'JPY' };
        if (cache) await cache.put(key, new Response(JSON.stringify(out), { headers: { 'Cache-Control': 'max-age=3600', 'Content-Type': 'application/json' } }));
        return json(out);
      }
    } catch (e) { /* source suivante */ }
  }
  return json({ error: 'Taux indisponible' }, 502);
}

async function handleMe(request, env, account) {
  const row = await env.DB.prepare('SELECT last_code FROM prefs WHERE account_id = ?').bind(account.id).first();
  return json({ account: { name: account.name, email: account.email }, lastCode: row ? row.last_code : null });
}

async function handleMeCode(request, env, account) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'JSON invalide' }, 400); }
  const code = nettoyerCode(body && body.code);
  if (!code) return json({ error: 'Code invalide' }, 400);
  await env.DB.prepare(
    "INSERT INTO prefs (account_id, last_code, updated_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET last_code = excluded.last_code, updated_at = excluded.updated_at"
  ).bind(account.id, code, new Date().toISOString()).run();
  return json({ ok: true });
}

async function handleTrip(request, env, account, rawCode) {
  const code = nettoyerCode(rawCode);
  if (!code) return json({ error: 'Code de voyage invalide' }, 400);

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const known = parseInt(url.searchParams.get('rev') || '', 10);
    const row = await env.DB.prepare('SELECT data, rev FROM trips WHERE code = ?').bind(code).first();
    if (!row) return json({ rev: 0, state: etatVide() });
    if (Number.isFinite(known) && known === row.rev) return json({ rev: row.rev, unchanged: true });
    let state;
    try { state = JSON.parse(row.data); } catch (e) { state = etatVide(); }
    return json({ rev: row.rev, state });
  }

  if (request.method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX_STATE_BYTES) return json({ error: 'Voyage trop volumineux' }, 413);
    let body;
    try { body = JSON.parse(text); } catch (e) { return json({ error: 'JSON invalide' }, 400); }
    const s = body && body.state;
    if (!s || typeof s !== 'object' || !Array.isArray(s.people) || !Array.isArray(s.expenses)) {
      return json({ error: 'Données invalides' }, 400);
    }
    const state = { tripName: String(s.tripName || '').slice(0, 200), people: s.people, expenses: s.expenses };
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO trips (code, data, rev, owner_id, updated_by, updated_at) VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET data = excluded.data, rev = trips.rev + 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
    ).bind(code, JSON.stringify(state), account.id, account.id, now).run();
    const row = await env.DB.prepare('SELECT rev FROM trips WHERE code = ?').bind(code).first();
    return json({ ok: true, rev: row ? row.rev : 1 });
  }

  return json({ error: 'Méthode non autorisée' }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      if (!origineAutorisee(request)) return json({ error: 'Origine refusée' }, 403);
      const account = await getCentralAccount(request, env);
      if (!account) return json({ error: 'Non connecté' }, 401);

      if (path === '/api/rate' && request.method === 'GET') return handleRate(request);
      if (path === '/api/me' && request.method === 'GET') return handleMe(request, env, account);
      if (path === '/api/me/code' && request.method === 'PUT') return handleMeCode(request, env, account);
      const m = path.match(/^\/api\/trips\/(.+)$/);
      if (m) return handleTrip(request, env, account, m[1]);
      return json({ error: 'Introuvable' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: 'Erreur serveur' }, 500);
    }
  },
};
