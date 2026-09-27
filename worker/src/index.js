// Feis Day alert checker (Cloudflare Worker)
//
// - Every 2 minutes (cron), during the tracked feis only, fetches the feis's competitions from
//   iFeis, works out each starred competition's status, and sends an ntfy push when one moves
//   into "checking in" or "results posted". Each status is alerted at most once per competition.
// - The phone app keeps the watch list in sync via PUT /watch, authenticated with SYNC_KEY.
//
// Secrets (set with `wrangler secret put`, never committed): NTFY_TOPIC, SYNC_KEY
// KV namespace binding: FEIS_KV

const IFEIS = 'https://api.ifeis.net/api';
const NTFY = 'https://ntfy.sh';
const APP_URL = 'https://emcalt.github.io/feis-tracker/';
const ALLOWED_ORIGINS = ['https://emcalt.github.io', 'http://localhost:8765'];
const HOUR = 60 * 60 * 1000;
const WINDOW_PAD = 3 * HOUR;        // start polling a little before the feis day and stop a little after
const BLOCKED_ALERT_EVERY = 6 * HOUR;

// Same derivation as the app (index.html). To be confirmed against a live feis.
function deriveStatus(ev) {
  if (ev.status === 'RES' || ev.is_in_results) return 'RES';
  if (ev.is_in_qa) return 'QA';
  if (ev.is_in_tabs) return 'TAB';
  if (ev.is_ci_opened) return 'CI';
  if (ev.is_ci_closed) return 'DANCING';
  return ev.status || 'PND';
}

const ALERTS = {
  CI:  { setting: 'ci',  text: 'is checking in',   tags: 'white_check_mark', priority: '4' },
  RES: { setting: 'res', text: 'results are posted', tags: 'trophy',          priority: '4' },
};

function titleFor(ev) {
  const gender = { F: 'Girls', M: 'Boys' }[ev.gender];
  const parts = [ev.age, gender, ev.event].filter(Boolean);
  return parts.length ? parts.join(' ') : String(ev.description || '').replace(/^\S+\s+-\s+/, '');
}

// ---------- storage ----------
async function getJSON(env, key, fallback) {
  const v = await env.FEIS_KV.get(key, 'json');
  return v == null ? fallback : v;
}
const putJSON = (env, key, value) => env.FEIS_KV.put(key, JSON.stringify(value));

// ---------- outbound ----------
async function ifeis(path) {
  const res = await fetch(IFEIS + path, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Referer': 'https://www.ifeis.net/',
      'Origin': 'https://www.ifeis.net',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error('iFeis HTTP ' + res.status);
  try { return JSON.parse(text).data || []; }
  catch (e) { throw new Error('iFeis returned non-JSON (possibly a bot check)'); }
}

async function notify(env, { title, message, tags, priority }) {
  const res = await fetch(NTFY + '/' + env.NTFY_TOPIC, {
    method: 'POST',
    body: message,
    headers: {
      'Title': title,
      'Tags': tags || '',
      'Priority': priority || '3',
      'Click': APP_URL,
    },
  });
  if (!res.ok) throw new Error('ntfy HTTP ' + res.status);
}

// ---------- the check ----------
async function runCheck(env, { force = false } = {}) {
  const watch = await getJSON(env, 'watch', null);
  const health = await getJSON(env, 'health', {});
  const now = Date.now();

  if (!watch || !watch.feisId || !watch.eventIds || !watch.eventIds.length) return { skipped: 'nothing starred' };
  const inWindow = watch.dt_start && now >= watch.dt_start - WINDOW_PAD && now <= (watch.dt_end || watch.dt_start) + WINDOW_PAD;
  if (!inWindow && !force) return { skipped: 'not feis day' };

  let events;
  try {
    events = await ifeis('/feiseanna/' + encodeURIComponent(watch.feisId) + '/events');
  } catch (e) {
    health.lastError = e.message;
    health.lastErrorAt = now;
    // Tell the user (occasionally) if iFeis stops answering, instead of failing silently.
    if (!health.blockedAlertAt || now - health.blockedAlertAt > BLOCKED_ALERT_EVERY) {
      health.blockedAlertAt = now;
      try {
        await notify(env, { title: 'Feis Day alerts paused', message: "The alert checker can't reach iFeis (" + e.message + "). Check the app directly for now.", tags: 'warning' });
      } catch (_) {}
    }
    await putJSON(env, 'health', health);
    return { error: e.message };
  }

  const seen = await getJSON(env, 'seen', {});       // eventId -> { status, alerted: [codes] }
  const settings = watch.alerts || { ci: true, res: true };
  const sent = [];
  let changed = false;

  for (const ev of events) {
    if (!watch.eventIds.includes(ev.id)) continue;
    const status = deriveStatus(ev);
    const prev = seen[ev.id];
    if (!prev) {
      // First time we've looked at this competition: record a baseline, don't alert for the current state.
      seen[ev.id] = { status, alerted: [status] };
      changed = true;
      continue;
    }
    if (prev.status === status) continue;
    prev.status = status;
    changed = true;
    const alert = ALERTS[status];
    if (alert && settings[alert.setting] !== false && !prev.alerted.includes(status)) {
      prev.alerted.push(status);
      const title = ev.name + ' ' + alert.text;
      await notify(env, { title, message: titleFor(ev) + (ev.level ? ' · ' + ev.level : ''), tags: alert.tags, priority: alert.priority });
      sent.push(title);
    }
  }

  if (changed) await putJSON(env, 'seen', seen);
  // Only write health when something is worth recording, to stay well inside KV's free write limit.
  if (health.lastError || !health.lastOkAt || now - health.lastOkAt > 30 * 60 * 1000 || sent.length) {
    delete health.lastError;
    health.lastOkAt = now;
    await putJSON(env, 'health', health);
  }
  return { checked: watch.eventIds.length, sent };
}

// ---------- HTTP API for the phone app ----------
function cors(req) {
  const origin = req.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Feis-Key',
    'Vary': 'Origin',
  };
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } });
}

function authorized(req, env) {
  const key = req.headers.get('X-Feis-Key') || '';
  return env.SYNC_KEY && key.length === env.SYNC_KEY.length && key === env.SYNC_KEY;
}

async function handle(req, env) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  const url = new URL(req.url);
  if (!authorized(req, env)) return json(req, { error: 'unauthorized' }, 401);

  if (url.pathname === '/watch' && req.method === 'GET') {
    return json(req, {
      watch: await getJSON(env, 'watch', null),
      health: await getJSON(env, 'health', {}),
      topic: env.NTFY_TOPIC,
    });
  }

  if (url.pathname === '/watch' && req.method === 'PUT') {
    const body = await req.json().catch(() => null);
    if (!body || typeof body.feisId !== 'string' || !Array.isArray(body.eventIds)) return json(req, { error: 'bad request' }, 400);
    const prev = await getJSON(env, 'watch', null);
    const watch = {
      feisId: body.feisId,
      feisName: String(body.feisName || ''),
      dt_start: Number(body.dt_start) || null,
      dt_end: Number(body.dt_end) || null,
      eventIds: body.eventIds.filter(x => typeof x === 'string').slice(0, 200),
      alerts: { ci: body.alerts?.ci !== false, res: body.alerts?.res !== false },
      updatedAt: Date.now(),
    };
    await putJSON(env, 'watch', watch);
    // Switching feis: forget the old feis's alert history.
    if (!prev || prev.feisId !== watch.feisId) await putJSON(env, 'seen', {});
    return json(req, { ok: true, watch });
  }

  if (url.pathname === '/test' && req.method === 'POST') {
    await notify(env, { title: 'Feis Day test alert', message: "If you can see this, alerts are working.", tags: 'bell' });
    return json(req, { ok: true });
  }

  if (url.pathname === '/check' && req.method === 'POST') {
    return json(req, await runCheck(env, { force: true }));
  }

  return json(req, { error: 'not found' }, 404);
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { return json(req, { error: e.message }, 500); }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCheck(env));
  },
};
