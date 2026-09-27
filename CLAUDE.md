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

## Decisions made (2026-09-27)
- **Public repo + GitHub Pages** for the front end. Secrets (iFeis JWT, ntfy topic name) must never be committed — they go in the backend's encrypted secrets.
- **Alerts backend: Cloudflare Workers cron**, not GitHub Actions — timing matters and Actions schedules can run 10–30+ min late. Fallback if iFeis blocks Cloudflare: a Raspberry Pi at home. Polling from the user's laptop was rejected (too much running around at a feis).
- **Notifications: ntfy** app on the user's phone.
- **Privacy:** drop `dob` on fetch; never store or display it. Dancer lists are kept in memory only, not localStorage.

## What we've learned about the API (beyond the brief)
- CORS is `Access-Control-Allow-Origin: *`, so the phone app calls public endpoints directly. The allowed headers do **not** include `Authorization`, so `/api/feiseanna/mine` can only be called from the backend, never the browser.
- Feis objects include `dt_start` / `dt_end` (ms) and a feis `status`: seen `REG`, `PND_FNL`, `FINAL`.
- Events carry lifecycle flags: `is_ci_opened`, `is_ci_closed`, `is_in_tabs`, `is_in_qa`, `is_in_results`, `is_announced`. The app derives CI / DANCING / TAB / QA / RES from these (`deriveStatus` in `index.html`). Seen in finished comps: `is_ci_opened=0, is_ci_closed=1, is_in_tabs=0, is_in_qa=1, is_in_results=1`. **The mapping for in-progress comps is a guess — confirm at the live feis.** The detail screen shows the raw iFeis status code at the bottom to help with this.
- Competitions with 0 participants are common (an upcoming feis had 265 events, 168 empty); `gender` is often missing. Empty events in a finished feis have `status: PND` and null flags.
- `placements` for an upcoming feis returns an **empty list** (not an alphabetical list with null scores). Whether it fills in on feis day before results is still open.

## Status / next steps
1. ✅ Front end reads live iFeis data (feis picker, starred comps per feis, search, dancer/results view, refresh every 60s while open).
2. ⏭ At the next live feis (~Oct 17–18, 2026): confirm status flags during check-in/dancing/tabulation, and when the dancer list appears.
3. ⏭ Cloudflare Worker: poll starred comps, diff status, send ntfy alerts, never re-alert the same status. User needs to create a free Cloudflare account and install the ntfy app.
4. Open decision: manual feis/competition watch list vs. `/mine` + stored JWT.
