---
name: testing-zbugs
description: How to run and end-to-end test the zbugs demo app (apps/zbugs in zero-foldkit) — stack layout, dev-JWT login, UI map, DB verification, and input quirks.
---

# Testing zbugs (zero-foldkit/apps/zbugs)

## Stack layout (expected running)

- vite dev server http://localhost:5173 — serves the SPA **and** the Effect API on one port (`/api/mutate`, `/api/query`, `/api/login/github`, `/api/unsubscribe`, `/p/*.md` machine routes). Start: `pnpm dev` inside `apps/zbugs`.
- zero-cache http://localhost:4848 (`pnpm zero-cache`, replica at `/tmp/zbugs-replica.db`).
- postgres 16 at `postgres://postgres@127.0.0.1:6434/zbugs` (needs `wal_level=logical`; seed via `pnpm db:migrate && pnpm db:seed`, compose file in `apps/zbugs/docker/`).

## Logging in (no OAuth needed)

GitHub OAuth requires `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` in `apps/zbugs/.env` (usually empty → `/api/login/github` returns 501). For tests, mint a dev JWT:

- `apps/zbugs/.env` has `PRIVATE_JWK` / `VITE_PUBLIC_JWK` — **single-quoted** JSON (ES256, kid `zbugs`).
- Sign `{sub, role:'crew', name, iat, exp}` with jose (installed in the app's node_modules; run `node -e "import('jose').then(...)"`). Seed user `darkgnotic` = sub `ieK09sy2C_AIWE8KRkrQR`, role `crew`.
- Auth is a plain `jwt` cookie (non-HttpOnly): set `document.cookie='jwt=<tok>; path=/; max-age=2592000'` via devtools console, or cleanly via CDP — Chrome runs with `--remote-debugging-port` (find it: `pgrep -a chrome | grep -o 'remote-debugging-port=[0-9]*'`), then `Network.setCookie` + `Page.reload` on the page target. Reload confirms `darkgnotic` + `Log out` appear in the nav.
- Logout = `Log out` button → clears cookie → full reload to anonymous (read-only; all mutation controls disappear).

## UI map

- List `/p/zero`: `Filter issues...` input; `Status: all|open|closed` cycle button; `Modified`/`Created` select; `Sort ↑/↓` toggle; `+ New Issue` (login-gated) → composer (`Issue title`, `Description (markdown)`, `Create Issue`/`Cancel`). Rows link to `/p/zero/issue/<shortID-or-nanoid>`; `●` open / `◐` closed.
- Detail: `← Back to issues`; `● Open`/`◐ Closed`; `Close issue`/`Reopen issue` (login-gated); `Comments (N)` + `Write a comment...` + `Comment` (login-gated).
- Nav: `🐛 zbugs` logo → list; status pill; username + `Log out` / `Log in with GitHub`.

## Verification beyond the UI

Mutations persist server-side — confirm with psql, e.g. `psql "postgres://postgres@127.0.0.1:6434/zbugs" -c "select \"shortID\",title,open,\"creatorID\" from issue order by created desc limit 1"`. New issues get `shortID` from a postgres identity column; all-digit URL segments query by `shortID`, non-digit by `id`.

## Quirks observed

- Controlled text inputs can drop fast keystrokes (each keystroke rebuilds the query subscription). Keep `type` strings short or verify the text landed before submitting.
- The `Log in with GitHub` nav link is a same-origin `<a>` — the SPA link interceptor treats it as an internal route → client-side 404, never reaches `/api/login/github`. Do not wait for a redirect.
- The connection-state pill may stay `…` even while data syncs (subscription forwards only state changes).
