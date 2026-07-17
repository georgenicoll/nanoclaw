# NanoClaw v1 → v2 Migration — 2026-06-30

Migrated from v1 `1.2.53` at `/home/george/code/nanoclaw` (read-only, untouched).
Deterministic side run by `migrate-v2.sh`; interactive finish via `/migrate-from-v1`.

## Deterministic steps (migrate-v2.sh)

All succeeded: `1a-env`, `1b-db`, `1c-groups`, `1d-sessions`, `1e-tasks`,
`2b-channel-auth`, `2c-install-telegram`, `3c-auth`, `3e-build`.
OneCLI healthy; service switched to v2 (`nanoclaw-v2-176e5dde.service`).

## Decisions made during the interactive finish

### Phase 0 — routing
- Smoke test passed: `@PurpleClawGronsterBot` replied to a real Telegram message.

### Phase 1 — owner & access
- Owner role granted to `telegram:8562870876` (George), global.
- Access policy: **Telegram group set to `strict`** (known users only).
  - Finding: v1 history shows only George as a sender — no third-party users to import.

### Phase 2 — CLAUDE.local.md cleanup
- Both active groups' `CLAUDE.local.md` were 100% stock v1 boilerplate.
  Reduced to minimal identity (`# Claw` + one-line intro); v2 fragments cover the rest.
- Deleted orphan `groups/main/CLAUDE.local.md` (no agent group uses the `main` folder).

### Phase 3 — container config
- Clean: no custom mounts/packages/MCP servers (v1 had none). All groups `skills="all"`,
  `cli_scope=group`. (Optional future tweak: set the Telegram owner agent to `cli_scope=global`.)

### Phase 4 — fork customizations
Copied container skills from the v1 fork:
- **`google`** (Gmail/Calendar read-only) — kept; v2-compatible via OneCLI gateway.
  Non-functional until Google OAuth is added to the vault (`/add-gmail-tool` / `/add-gcal-tool`).
- **`homeassistant`** — rewritten for v2: dropped `$HA_TOKEN`/`$HA_URL` env vars and manual
  `Authorization` header; hardcoded `http://homeassistant.lan:8123`; OneCLI auto-injects auth
  (HomeAssistant secret already in vault; Telegram agent is `secretMode=all`).
- **`capabilities`**, **`status`** — removed (v1-only `/workspace/{project,group,extra,ipc}`
  paths and v1 MCP tools; would report wrong info in v2).
- Source-level v1 changes (telegram allowlist, HA MCP server, WhatsApp fixes) not ported —
  all superseded by v2 (`unknown_sender_policy`/`user_roles`, the HA container skill, `/add-whatsapp`).

### WhatsApp — removed entirely
v1 had WhatsApp; migration installed Telegram only. Per decision, removed the carried-over
WhatsApp group end-to-end: wiring, messaging group, agent group ("73 Wellfield Road"),
container config, session row, `groups/whatsapp_73wellfield/`, session data dir, and the
orphan OneCLI agent `whatsapp-73wellfield`.

## Final state
- One channel: **Telegram** (`strict`), one agent group **George (Telegram)** (folder `whatsapp_main`).
- `setup --step verify`: STATUS success.
