# Feis Day — notes for Claude

Personal phone web app for following Irish dance competitions (feiseanna) live on feis day, using iFeis data.
Full background, API notes and design decisions: `docs/project-brief.md`. This file records what's changed since.

## Working with the user
- GitHub username `Emcalt`. Works in software but is new to git/GitHub/dev tooling — explain setup steps plainly (what to click, what a command does).
- Commits are authored as "Emcalt" with the GitHub noreply email (already in global git config).
- `gh` (GitHub CLI) is installed at `~/.local/bin/gh` (not on the default PATH in every shell; use the full path).

## Where things live
- Repo: https://github.com/Emcalt/feis-tracker (public)
- App: https://emcalt.github.io/feis-tracker/ — GitHub Pages serves `index.html` from `main`; a push goes live in ~1 minute.
- Local preview: `python3 -m http.server 8765` in this folder, then open http://localhost:8765/
- Alert checker: Cloudflare Worker `feis-day` at https://feis-day.feis-day-worker.workers.dev (code in `worker/`).
  Node.js is installed at `~/.local/node/bin` (add to PATH). Deploy: `cd worker && npx wrangler deploy`.
  Cloudflare account is logged in via `wrangler login`.
- Secrets live only in Cloudflare: `SYNC_KEY` (also in the git-ignored `worker/.secrets/feis-day.env`, with
  `setup-qr.png`, a QR of the phone setup link), and `PUSHOVER_USER` / `PUSHOVER_TOKEN` (entered by the user in the
  Cloudflare dashboard). Never print or commit them.

## Decisions made (2026-09-27)
- **Public repo + GitHub Pages** for the front end. Secrets (iFeis JWT, ntfy topic name) must never be committed — they go in the backend's encrypted secrets.
- **Alerts backend: Cloudflare Workers cron**, not GitHub Actions — timing matters and Actions schedules can run 10–30+ min late. Fallback if iFeis blocks Cloudflare: a Raspberry Pi at home. Polling from the user's laptop was rejected (too much running around at a feis).
- **Notifications: Pushover** app on the user's phone. (ntfy.sh was tried first and dropped: its free tier rate-limits per IP, and Cloudflare Worker IPs are shared, so publishes got `429 daily message quota reached` even with a free ntfy account token — per-user limits need a paid ntfy plan.)
- **Privacy:** drop `dob` on fetch; never store or display it. Dancer lists are kept in memory only, not localStorage.

## What we've learned about the API (beyond the brief)
- CORS is `Access-Control-Allow-Origin: *`, so the phone app calls public endpoints directly. The allowed headers do **not** include `Authorization`, so `/api/feiseanna/mine` can only be called from the backend, never the browser.
- Feis objects include `dt_start` / `dt_end` (ms) and a feis `status`: seen `REG`, `PND_FNL`, `FINAL`.
- Events carry lifecycle flags: `is_ci_opened`, `is_ci_closed`, `is_in_tabs`, `is_in_qa`, `is_in_results`, `is_announced`. The app derives CI / DANCING / TAB / QA / RES from these (`deriveStatus` in `index.html`). Seen in finished comps: `is_ci_opened=0, is_ci_closed=1, is_in_tabs=0, is_in_qa=1, is_in_results=1`. **The mapping for in-progress comps is a guess — confirm at the live feis.** The detail screen shows the raw iFeis status code at the bottom to help with this.
- Competitions with 0 participants are common (an upcoming feis had 265 events, 168 empty); `gender` is often missing. Empty events in a finished feis have `status: PND` and null flags.
- `placements` for an upcoming feis returns an **empty list** (not an alphabetical list with null scores). Whether it fills in on feis day before results is still open.

## How alerts work
- Cron every 2 min; does nothing unless something is starred and it's within 3 h of the tracked feis's dates.
  One iFeis request (`/events` for that feis) per run.
- Alerts on status change into CI or RES, once per status per competition (stored in KV `seen`). First sighting
  of a competition is recorded as a baseline, not alerted. Switching feis resets `seen`.
- Alerts are Pushover priority 1 (Time Sensitive on iPhone). If iFeis errors / returns non-JSON, sends an "alerts paused" push at most every 6 h.
- The app PUTs `/watch` (feis, starred ids, alert toggles) whenever stars/toggles/feis change, with header
  `X-Feis-Key`. iOS Home Screen apps have storage separate from Safari, so setup is: scan QR → Safari page
  offers "Copy setup code" → Home Screen app → Settings → Paste.
- Verified 2026-09-27: iFeis answers requests from Cloudflare (not blocked, for now).
- KV free tier = 1000 writes/day; the Worker only writes on change, so keep it that way.

## Status / next steps
1. ✅ Front end reads live iFeis data (feis picker, starred comps per feis, search, dancer/results view, refresh every 60s while open).
2. ⏭ At the next live feis (~Oct 17–18, 2026): confirm status flags during check-in/dancing/tabulation, and when the dancer list appears.
3. ✅ Cloudflare Worker deployed and wired to the app (2026-09-27). Setup code pasted on the phone. Pending: user adds Pushover keys in Cloudflare, then Send test.
4. Open decision: manual feis/competition watch list vs. `/mine` + stored JWT.
