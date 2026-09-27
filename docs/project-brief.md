# Feis Day Tracker — Project Brief for Claude Code

## Goal
A personal (not App Store) phone app that tracks Irish dance competitions ("feiseanna")
in real time, pulling data from ifeis.net, with better navigation than the site itself
and push notifications when starred competitions check in or post results.

MVP scope only: live feis-day tracking of hand-picked competitions. No registration,
no past-feis browsing, no multi-user support.

## What's confirmed about the iFeis API
Base URL: `https://api.ifeis.net`

All of the following were verified by inspecting real network traffic while logged
into ifeis.net (via Claude in Chrome). They require **no authentication**:

1. **List of feiseanna**
   `GET /api/feiseanna?include_past=true` (also accepts `is_finalized`, `since` params)
   Response: `{ data: [ {...} ] }`, each item has counters (`registered`, `judged`, etc.)
   and a nested `feis` object with `id`, `name`, `slug`, `description`, `loc_name`,
   `loc_addr`, `tz`, `dt_reg_start`/`dt_reg_end` (ms timestamps), `status`.

2. **Competitions at one feis**
   `GET /api/feiseanna/{feisId}/events`
   Response: `{ data: [ {...} ] }`, one item per competition:
   - Identity: `id`, `name` (e.g. `206LJ`), `description`, `level`, `event` (dance),
     `age`, `age_min`/`age_max`, `gender`
   - Counts: `participants`, `placedDancersCount`, `rounds`, `awardType`
   - Status: `status` field — **only `RES` (results posted) and `PND` (pending/not
     started) have been directly observed.** The real iFeis UI shows a longer status
     lifecycle (checking in → dancing → tabulating → quality assurance → results), so
     more status codes almost certainly exist. **Confirming the full status enum is an
     open task** — do this by watching the Network tab during a live feis (one is
     happening in ~3 weeks from when this brief was written).
   - Also present: `is_in_results`, `is_ci_closed`, `closed_at` (ms timestamp)
   - Note: some event IDs are long composite strings with `-tpl:` segments — use
     verbatim as returned, don't try to parse/construct them.

3. **Dancers and results for one competition**
   `GET /api/feiseanna/{feisId}/events/{eventId}/placements`
   Response: `{ data: [ {...} ] }`, one item per dancer:
   - Dancer: `id`, `fname`, `lname`, `gender`, `dob`, `competitor` (number),
     `school: { id, name }`
   - Result: `score: { placement, total, computedTotal, placed, is_checked_in }`
   - **Before results are posted**, the same endpoint is believed to return dancers
     sorted alphabetically by name with `score` empty/null. **After** results post,
     the same list re-sorts by placement with `score` populated. This is a hypothesis
     based on user's real-world knowledge of the site's behavior — worth confirming
     during the live feis that it really is the same endpoint rather than two
     different ones.
   - **Privacy requirement: drop `dob` immediately on fetch. Never store or display
     a child's date of birth anywhere in this app.**

4. **Personalized "my registrations" endpoint**
   `GET /api/feiseanna/mine` — requires auth (see below). Exact response shape not
   yet captured; assume it returns a list of feiseanna similar to the public list,
   scoped to the logged-in user's registrations. Worth a quick real capture before
   building against it blindly.

### Authentication (for `/mine` and other account-specific calls only)
- Header: `authorization: JWT <token>` — note the scheme is literally the word
  `JWT`, not the more common `Bearer`. Using `Bearer` will get rejected.
- Token format: a standard JWT (starts with `eyJ`).
- No refresh token exists. No expiry is encoded in the token itself — the server
  decides when it stops working. Practically: it may last a long time, but the app
  needs to handle a 401 gracefully (see below), since there's no way to proactively
  know when it'll expire.
- Token lives in the browser's `localStorage` on `www.ifeis.net` under the key `jwt`.
  **The user retrieves this manually** by logging into ifeis.net and copying it from
  DevTools → Application → Local Storage. It should never be typed into chat, hardcoded
  in source, or committed to git. Store it only as an encrypted secret (e.g. a GitHub
  Actions repository secret) that the running script reads at runtime.
- On a 401 from any authenticated call: send the user a notification telling them the
  token needs refreshing, rather than failing silently or retrying forever.
- Public endpoints (feis list, events, placements) need **no** auth header at all.

### Other notes
- Hitting `api.ifeis.net` directly with a bare/scripted HTTP client got blocked once
  by bot detection during testing (from an unrelated server, not the user's own
  browser). Whatever polling script we build should send reasonable browser-like
  headers (a normal `User-Agent`, etc.) and go easy on request frequency — this is an
  undocumented API being used politely, not a public developer API with a stated rate
  limit.

## Product design decisions already made
- **Only starred competitions show on the main dashboard** — no "everything at the
  feis" clutter on the home screen. A separate "Add competitions" screen (opened via
  a `+` button) shows the full list for that feis, where the user stars/unstars.
- **Which feiseanna appear in the picker**: currently planned as manual
  browse-and-select from the public feis list (same interaction pattern as starring
  competitions), specifically **to avoid needing to handle login/token risk just for
  this one screen**. The user later decided they DO want to explore automating this
  via `/api/feiseanna/mine` now that the auth picture turned out simpler than
  expected (no refresh token to protect, simple header format). Either approach is
  viable — this is a live decision point, not fully settled.
- **Venue address** should be shown prominently on the dashboard (a tappable card
  linking to Google Maps), using the `loc_name`/`loc_addr` fields from the feis
  object. This is a fixed requirement, not just a nice-to-have.
- **Status colors**: distinct hue per status so a glance conveys state without
  reading text — this mattered enough to the user to be called out explicitly.
- Design language already chosen and liked by the user: dark theme (deep navy
  background, brass/gold accent), Fraunces (serif) for headings/feis names, Archivo
  (sans, tabular figures) for data-heavy text and competition numbers. See the
  attached prototype file for the full implementation — reuse this rather than
  redesigning from scratch.

## Planned architecture (not yet built)
The working prototype (attached HTML file) currently uses mock data and runs as a
published page on claude.ai, which is sandboxed and can't call external APIs. The
real version needs:

1. **A backend / polling script** — checks starred competitions' statuses on a
   schedule (proposed: every few minutes via a scheduled GitHub Actions workflow,
   since it's free and needs no server to maintain), diffs against last-known status,
   and sends a push notification on a meaningful change (e.g. → checking-in, →
   results posted). Must not re-notify for a status it already alerted on.
2. **Notification delivery** — proposed: [ntfy.sh](https://ntfy.sh), a free,
   no-account push service. The phone runs the ntfy app subscribed to a private
   topic name; the backend sends a plain HTTP POST to notify. Chosen specifically to
   avoid the complexity of proper Apple Push certificates for a single-user tool.
3. **A real, independently-hosted front-end** — the same HTML/CSS/JS app as the
   prototype, adapted to fetch live data (through the backend, or directly from
   iFeis's public endpoints where no auth is needed), hosted somewhere ordinary like
   GitHub Pages or Vercel — NOT as a claude.ai published artifact, since that
   environment cannot make outbound network calls to any external API.
4. **Watch list config**: rather than building full sync infrastructure between the
   front-end's starred list and the backend for what is a single personal user, the
   plan was to keep a simple config (e.g. a small JSON file) listing which feis ID
   and competition IDs to actively poll during a given event, updated by the user a
   few times a year before each feis. This may be revisited if the `/mine` +
   auto-selected-competitions route is pursued further.

## Open questions to resolve
1. Full status code enum beyond `PND`/`RES` (confirm live, in ~3 weeks from when this
   brief was written).
2. Whether pre-results dancer list comes from the same `placements` endpoint or a
   separate one (confirm live).
3. Exact response shape of `/api/feiseanna/mine`.
4. Final decision: manual feis selection vs. automated via `/mine` + stored JWT.

## Attached
- `feis-tracker.html` — working clickable prototype (mock data), reflects the
  design language and interaction patterns the user has approved so far.
