---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate messaging channels, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Welcome the user. Your opening message should cover, in your own words and in ~4–5 sentences total:

1. **What NanoClaw is** — a personal Claude assistant that lives across your messaging apps (WhatsApp, Slack, Telegram, Discord, iMessage, email, and more). A small Node host on your machine routes messages and spins up per-conversation agent containers on demand. Containers come and go, but the agent's memory, conversation history, and any files it creates are persisted to disk — next time a message arrives, the container comes back up right where it left off. Credentials live in a local OneCLI vault; the agent itself never sees them.
2. **What the setup will cover** — install deps, build the agent sandbox, wire up your first messaging app, test a message end-to-end.
3. **That you'll run slow work in the background** while talking to them (bootstrap, container build, post-merge rebuild) so they're not watching commands scroll by.

Keep it warm. Not a wall of text.

Then explain that setup involves running many shell commands (installing packages, building containers, starting services), and recommend pre-approving the standard setup commands so they don't have to confirm each one individually.

Use `AskUserQuestion` with these options:

1. **Pre-approve (recommended)** — description: "Pre-approve standard setup commands so you don't have to confirm each one. You can review the list first if you'd like."
2. **No thanks** — description: "I'll approve each command individually as it comes up."
3. **Show me the list first** — description: "Show me exactly which commands will be pre-approved before I decide."

If they pick option 1: read `.claude/skills/setup/setup-permissions.json`, then read the project settings file at `.claude/settings.json` (create it if it doesn't exist with `{}`), and directly edit it to add/merge the permissions into the `permissions.allow` array. Do NOT use the `update-config` skill.

If they pick option 3: read and display `.claude/skills/setup/setup-permissions.json`, then re-ask with just options 1 and 2.

If they decline, continue — they'll approve commands individually.

---

**Internal guidance (do not show to user):**

- Run setup steps automatically. Only pause when user action is required (channel authentication, configuration choices).
- Setup uses `bash setup.sh` for bootstrap, then `pnpm exec tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.
- **Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. authenticating a channel, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair.
- **UX Note:** Use `AskUserQuestion` for multiple-choice questions only (e.g. "which credential method?"). Do NOT use it when free-text input is needed (e.g. phone numbers, tokens, paths) — just ask the question in plain text and wait for the user's reply.
- **Timeouts:** Use 5m timeouts for install and build steps.
- **Waiting on user:** When the user needs to do something (change a setting, get a token, open a browser, etc.), stop and wait. Give clear instructions, then say "Let me know when done or if you need help." Do NOT continue to the next step. If they ask for help, give more detail, ask where they got stuck, and try to assist.

**Subagents for installation work (do not show to user):**

Slow installation work runs in background subagents so the main agent stays in conversation with the user. Three agent types live in `.claude/agents/`:

| Agent | Spawn at | Join before | Overlaps with user doing |
|---|---|---|---|
| `nanoclaw-bootstrap` | step 1 | step 2 (env check) | pre-approval + git upstream |
| `nanoclaw-container-builder` | step 3c (after Docker is up) | step 5 (channel selection) | step 4 OneCLI install + secret setup |
| `nanoclaw-rebuilder` | immediately after channel skill completes | step 7 (service start) | step 6 mounts config |

**Spawn pattern:** call the `Agent` tool with `run_in_background: true` and `subagent_type: "<agent-name>"`. Continue the flow; the harness notifies you when the subagent returns.

**Return contract:** every subagent ends with a status block.
- `STATUS: done` → proceed.
- `STATUS: needs_user` → read `QUESTION` + `CONTEXT` + `LOG_TAIL`. Ask the user (via `AskUserQuestion` for multi-choice, plain text for free-text). Re-spawn the same subagent with the user's answer folded into the new prompt — subagents are one-shot, they don't resume. State lives on disk (logs, lockfiles, installed deps), not in the subagent's memory.

**If pre-approval was declined:** run subagents in the foreground (`run_in_background: false`) so per-command prompts surface in the main chat with context, instead of a silent "background agent waiting on permission" state.

**No judgment calls inside a subagent.** Each agent definition enumerates exactly which failures it may auto-fix and which must escalate. If a subagent returns with an invented repair ("ran `docker system prune`" or "edited the channel adapter to pass tsc"), stop, revert if needed, and escalate to the user.

## 0. Git Upstream

Ensure `upstream` remote points to `qwibitai/nanoclaw`:

```bash
./setup/scripts/ensure-upstream.sh
```

Parse the status block — `STATUS: added | already_set | mismatch`. A mismatch means someone has pointed `upstream` elsewhere; surface it to the user before touching it.

## 1. Bootstrap (Node.js + Dependencies) — background

> **Tell the user:** "Installing Node and the host dependencies. The orchestrator that routes messages between your messaging apps and the agent containers is a small Node process that runs directly on your machine — this step gets it ready."

Spawn the bootstrap subagent in the background. It runs `bash setup.sh`, auto-repairs transient dep failures on its own, and escalates Node-install and build-tools decisions back to you via `STATUS: needs_user`.

```
Agent({
  description: "NanoClaw bootstrap",
  subagent_type: "nanoclaw-bootstrap",
  run_in_background: true,
  prompt: "Run the NanoClaw bootstrap from the project root. Follow your auto-fix and escalation rules. End with your status block."
})
```

Continue to step 2. **Barrier: before running the environment check in step 2, wait for the bootstrap result.**

When bootstrap returns:
- `STATUS: done` → record `PLATFORM` and proceed.
- `STATUS: needs_user` → surface the embedded `QUESTION` to the user (use `AskUserQuestion` for the Node-install choice — `brew` / `nvm` / `apt` / cancel — and plain text for anything else). Then re-spawn `nanoclaw-bootstrap` with the user's answer in the prompt, e.g. `"User picked: install Node 22 via nvm. Install it, then re-run bash setup.sh."`.

Common escalations you'll translate for the user:
- **Node missing** → `AskUserQuestion` with Node 22 install options (macOS: brew/nvm; Linux: apt via nodesource/nvm).
- **Build tools missing** → confirm `xcode-select --install` (macOS) or `sudo apt install build-essential` (Linux).

## 2. Check Environment

Run `pnpm exec tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true → WhatsApp is already configured, note for step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record DOCKER value for step 3

### OpenClaw Migration Detection

If OPENCLAW_PATH is not `none` from the environment check above, AskUserQuestion:

1. **Migrate now** — "Import identity, credentials, and settings from OpenClaw before continuing setup."
2. **Fresh start** — "Skip migration and set up NanoClaw from scratch."
3. **Migrate later** — "Continue setup now, run `/migrate-from-openclaw` anytime later."

If "Migrate now": invoke `/migrate-from-openclaw`, then return here and continue at step 2a (Timezone).

## 2a. Timezone

Run `pnpm exec tsx setup/index.ts --step timezone` and parse the status block.

- If NEEDS_USER_INPUT=true → The system timezone could not be autodetected (e.g. POSIX-style TZ like `IST-2`). AskUserQuestion: "What is your timezone?" with common options (America/New_York, Europe/London, Asia/Jerusalem, Asia/Tokyo) and an "Other" escape. Then re-run: `pnpm exec tsx setup/index.ts --step timezone -- --tz <their-answer>`.
- If STATUS=success and RESOLVED_TZ is `UTC` or `Etc/UTC` → confirm with the user: "Your system timezone is UTC — is that correct, or are you on a remote server?" If wrong, ask for their actual timezone and re-run with `--tz`.
- If STATUS=success → Timezone is configured. Note RESOLVED_TZ for reference.

## 3. Container Runtime (Docker)

> **Tell the user:** "Next up: the sandbox your agent runs in. NanoClaw spawns a container per active conversation — each one gets its own isolated filesystem, working directory, and tools. Containers spin up when a message arrives and spin back down when the conversation goes idle, but the agent's memory, the message history, and any files it created all stay on your disk — the container comes back up right where it left off."

### 3a. Install Docker

- DOCKER=running → continue to step 4
- DOCKER=installed_not_running → run `./setup/scripts/ensure-docker-running.sh` and parse the status block. If `STATUS: timeout`, read `logs/setup.log` and surface.
- DOCKER=not_found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. CJK fonts

Agent containers skip CJK fonts by default (~200MB saved). Without them, Chromium-rendered screenshots and PDFs show tofu for Chinese/Japanese/Korean.

- **User writing to you in Chinese, Japanese, or Korean** → enable without asking. Mention it briefly.
- **Resolved timezone from step 2a is a CJK region** (`Asia/Tokyo`, `Asia/Shanghai`, `Asia/Hong_Kong`, `Asia/Taipei`, `Asia/Seoul`) or other signal short of active CJK use → ask: "Enable CJK fonts? Adds ~200MB, lets the agent render CJK in screenshots and PDFs."
- **Otherwise** → skip.

To enable:

```bash
./setup/scripts/upsert-env.sh INSTALL_CJK_FONTS true
```

The next step's build picks it up automatically.

### 3c. Build and test — background

Docker is now running and dependencies are installed (bootstrap joined before step 2). Spawn the container-builder subagent in the background and continue to step 4 (OneCLI) while it works. This is the biggest parallelization win — the build typically takes 1–5 minutes and OneCLI setup is heavily user-interactive.

```
Agent({
  description: "Build agent container",
  subagent_type: "nanoclaw-container-builder",
  run_in_background: true,
  prompt: "Build the NanoClaw agent container image and smoke-test it. Follow your auto-fix and escalation rules. End with your status block."
})
```

**Barrier: before step 5 (channel selection), wait for the container-builder result.**

When it returns:
- `STATUS: done` → proceed.
- `STATUS: needs_user` → surface the question (usually either "start Docker?" or a persistent build error). If the fix is straightforward, apply it and re-spawn the subagent with the user's decision in the prompt.

## 4. Credential System

> **Tell the user:** "Setting up credential isolation. Your Anthropic token (and any other API keys you add later) live in a local vault called OneCLI. When the agent in a container needs to call the Anthropic API, OneCLI injects the credential at request time — the agent process itself never sees the key."

### 4a. OneCLI

Install the OneCLI gateway and CLI, fix PATH, point the CLI at the local instance, and persist `ONECLI_URL` to `.env` — all in one script:

```bash
./setup/scripts/install-onecli.sh
```

Parse the status block. Record `ONECLI_URL` for later user-facing messages (the dashboard path in step 4b uses it).

- `STATUS: success` + `URL_CONFIGURED: true` → continue
- `STATUS: success` + `URL_CONFIGURED: false` → the installer didn't print a URL we could parse. Read the tail of `logs/setup.log`, find the URL (usually `http://localhost:<port>`), then run `onecli config set api-host <URL>` and `./setup/scripts/upsert-env.sh ONECLI_URL <URL>`.
- `STATUS: failed` → surface `STAGE` + log tail to user.

Check if a secret already exists:
```bash
onecli secrets list
```

If an Anthropic secret is listed, confirm with user: keep or reconfigure? If keeping, skip to step 5.

AskUserQuestion: Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

1. **Claude subscription (Pro/Max)** — description: "Uses your existing Claude Pro or Max subscription. You'll run `claude setup-token` in another terminal to get your token."
2. **Anthropic API key** — description: "Pay-per-use API key from console.anthropic.com."

#### Subscription path

Tell the user:

> Run `claude setup-token` in another terminal. It will output a token — copy it but don't paste it here.

Then stop and wait for the user to confirm they have the token. Do NOT proceed until they respond.

Once they confirm, they register it with OneCLI. AskUserQuestion with two options:

1. **Dashboard** — description: "Best if you have a browser on this machine. Open ${ONECLI_URL} and add the secret in the UI. Use type 'anthropic' and paste your token as the value."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_TOKEN --host-pattern api.anthropic.com`"

#### API key path

Tell the user to get an API key from https://console.anthropic.com/settings/keys if they don't have one.

Then AskUserQuestion with two options:

1. **Dashboard** — description: "Best if you have a browser on this machine. Open ${ONECLI_URL} and add the secret in the UI."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_KEY --host-pattern api.anthropic.com`"

#### After either path

Ask them to let you know when done.

**If the user's response happens to contain a token or key** (starts with `sk-ant-`): handle it gracefully — run the `onecli secrets create` command with that value on their behalf.

**After user confirms:** verify with `onecli secrets list` that an Anthropic secret exists. If not, ask again.

## 5. Set Up Channels

> **Tell the user:** "Time to hook up your first messaging app. NanoClaw supports Discord, Slack, Telegram, WhatsApp, email, GitHub, Linear, iMessage, and more — all wired the same way. Pick one to start; you can add more later with `/customize`, including multiple messaging apps side by side, or multiple groups/chats from the same app."

Show the full list of available messaging apps in plain text (do NOT use AskUserQuestion — it limits to 4 options). Ask which one they want to start with. They can add more later with `/customize`.

Channels where the agent gets its own identity (name and avatar) are marked as recommended.

1. Discord *(recommended — agent gets own identity)*
2. Slack *(recommended — agent gets own identity)*
3. Telegram *(recommended — agent gets own identity)*
4. Microsoft Teams *(recommended — agent gets own identity)*
5. Webex *(recommended — agent gets own identity)*
6. WhatsApp
7. WhatsApp Cloud API
8. iMessage
9. GitHub
10. Linear
11. Google Chat
12. Resend (email)
13. Matrix

**Delegate to the selected channel's skill.** Each channel skill handles its own package installation, authentication, registration, and configuration.

Invoke the matching skill:

- **Discord:** Invoke `/add-discord`
- **Slack:** Invoke `/add-slack`
- **Telegram:** Invoke `/add-telegram`
- **GitHub:** Invoke `/add-github`
- **Linear:** Invoke `/add-linear`
- **Microsoft Teams:** Invoke `/add-teams`
- **Google Chat:** Invoke `/add-gchat`
- **WhatsApp Cloud API:** Invoke `/add-whatsapp-cloud`
- **WhatsApp Baileys:** Invoke `/add-whatsapp`
- **Resend:** Invoke `/add-resend`
- **Matrix:** Invoke `/add-matrix`
- **Webex:** Invoke `/add-webex`
- **iMessage:** Invoke `/add-imessage`

The skill will:
1. Install the Chat SDK adapter package
2. Uncomment the channel import in `src/channels/index.ts`
3. Collect credentials/tokens and write to `.env`
4. Build and verify

**After the channel skill completes**, spawn the rebuilder subagent in the background. It will run `pnpm install && pnpm run build` to pick up any packages the channel merge added.

```
Agent({
  description: "Rebuild host after channel merge",
  subagent_type: "nanoclaw-rebuilder",
  run_in_background: true,
  prompt: "Rebuild the host to pick up packages from the channel skill merge. Follow your auto-fix and escalation rules. End with your status block."
})
```

**Barrier: before step 7 (service start), wait for the rebuilder result.** Service start needs `dist/` to exist. Continue to step 6 (mounts) while it runs.

If rebuilder returns `STATUS: needs_user` with a build error, surface the `FIRST_ERROR` line to the user and ask how they want to resolve it.

## 6. Mount Allowlist

Set empty mount allowlist (agents only access their own workspace). Users can configure mounts later with `/manage-mounts`.

```bash
pnpm exec tsx setup/index.ts --step mounts -- --empty
```

## 7. Start Service

**Barrier:** wait for the `nanoclaw-rebuilder` subagent (spawned after the channel skill in step 5) to return `STATUS: done`. The service needs `dist/` to exist. If rebuilder returned `STATUS: needs_user`, resolve with the user first.

If service already running, unload first:

```bash
./setup/scripts/restart-service.sh stop
```

Run `pnpm exec tsx setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-nanoclaw.sh` wrapper.

**If DOCKER_GROUP_STALE=true:** The user was added to the docker group after their session started — the systemd service can't reach the Docker socket. Ask user to run these two commands:

1. Immediate fix: `sudo setfacl -m u:$(whoami):rw /var/run/docker.sock`
2. Persistent fix (re-applies after every Docker restart):
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << 'EOF'
[Service]
ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
```
Replace `USERNAME` with the actual username (from `whoami`). Run the two `sudo` commands separately — the `tee` heredoc first, then `daemon-reload`. After user confirms setfacl ran, re-run the service step.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep nanoclaw`. If PID=`-` and status non-zero, read `logs/nanoclaw.error.log`.
- Linux: check `systemctl --user status nanoclaw`.
- Re-run the service step after fixing.

## 7a. Wire Channels to Agent Groups

> **Tell the user — mental model + flexibility:**
>
> "Wiring decides which *agent* answers which conversation. Quick mental model:
>
> - Each group/chat/DM you talk to on a messaging app becomes a **conversation** in NanoClaw.
> - Conversations get routed to an **agent** — the Claude persona (its name, memory, files, tools, permissions).
> - Each active conversation spawns its own **session** (the container running right now).
>
> You have real flexibility in how you wire this:
>
> - **Multiple WhatsApp groups → one agent**: each group is its own conversation thread (its own session), but they share the agent's memory, files, and tools.
> - **Multiple WhatsApp groups → different agents**: e.g. a 'Work' agent on one group and a 'Personal' agent on another — separate memories, separate files, separate permissions.
> - **Different messaging apps → one agent**: a WhatsApp group + a Telegram chat both wired to the same agent (still one shared memory).
> - **Different apps → different agents**: mix and match.
>
> **One rule worth remembering:** sessions share the agent's memory and files; **the agent is the privacy boundary**. If you don't want information flowing between two conversations — e.g. a work group seeing stuff from a personal one — give them separate agents, not just separate sessions on one agent."

The service is now running, so polling-based adapters (Telegram) can observe inbound messages — required for pairing.

Invoke `/manage-channels` to wire the installed channels to agent groups. This step:
1. Creates the agent group(s) and assigns a name to the assistant
2. Resolves each channel's platform-specific ID (Telegram via pairing code; other channels via the platform's own ID lookup)
3. Decides the isolation level — whether channels share an agent, session, or are fully separate

The `/manage-channels` skill reads each channel's `## Channel Info` section from its SKILL.md for platform-specific guidance (terminology, how to find IDs, recommended isolation).

**This step is required.** Without it, channels are installed but not wired — messages will be silently dropped because the router has no agent group to route to.

## 7b. Dashboard & Web Applications

> **Tell the user — capabilities tour:** "Before we wrap up, here's what your agent can do out of the box:
>
> - Talk on the messaging app you just wired (and any others you add later with `/customize`).
> - Use its **agent-browser** for web research and automation — headless Chromium is built in.
> - **Self-customize** per-conversation — tell it 'remember X for this chat' or 'always respond in bullet points here' and it writes that to the session's CLAUDE.md.
> - Ask it to **install packages** or **wire new MCP servers** on the fly (with your approval) — it can extend its own toolbox.
>
> Extras you can add later with `/customize`:
>
> - **More messaging apps** — Discord, Slack, Telegram, WhatsApp, GitHub, Linear, iMessage, Matrix, Webex, Google Chat, Microsoft Teams, WhatsApp Cloud.
> - **`/add-resend`** — email as a messaging app (send + receive via Resend).
> - **`/add-karpathy-llm-wiki`** — a persistent wiki knowledge base the agent maintains over time.
>
> Want a dashboard + deploy-to-Vercel too? That's the last question in setup — the dashboard gives you a monitoring UI, and Vercel lets the agent build and publish websites for you."

AskUserQuestion: Do you want to create a dashboard and build web applications?

1. **Yes (recommended)** — description: "Get a NanoClaw dashboard to monitor your agents and build custom websites however you want. Deploys to Vercel."
2. **Not now** — description: "You can add this later with `/add-vercel`."

If yes: invoke `/add-vercel`.

## 8. Verify

Run `pnpm exec tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `pnpm run build && ./setup/scripts/restart-service.sh restart`
- SERVICE=not_found → re-run step 7
- CREDENTIALS=missing → re-run step 4 (check `onecli secrets list`)
- CHANNEL_AUTH shows `not_found` for any channel → re-invoke that channel's skill (e.g. `/add-telegram`)
- REGISTERED_GROUPS=0 → re-invoke `/manage-channels` from step 7a
Tell user to test: send a message in their registered chat. Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 7), credential system not running (check `curl ${ONECLI_URL}/api/health`), missing channel credentials (re-invoke channel skill).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure Docker is running with `./setup/scripts/ensure-docker-running.sh`. Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Check trigger pattern. Main channel doesn't need prefix. Check DB: `pnpm exec tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**Channel not connecting:** Verify the channel's credentials are set in `.env`. Channels auto-enable when their credentials are present. For WhatsApp: check `store/auth/creds.json` exists. For token-based channels: check token values in `.env`. Restart the service after any `.env` change.

**Unload service:** `./setup/scripts/restart-service.sh stop`


## 9. Diagnostics

1. Use the Read tool to read `.claude/skills/setup/diagnostics.md`.
2. Follow every step in that file before completing setup.

## 10. Fork Setup

Only run this after the user has confirmed 2-way messaging works.

Check `git remote -v`. If `origin` points to `qwibitai/nanoclaw` (not a fork), ask in plain text:

> We recommend forking NanoClaw so you can push your customizations and pull updates easily. Would you like to set up a fork now?

If yes: instruct the user to fork `qwibitai/nanoclaw` on GitHub (they need to do this in their browser), then ask for their GitHub username. Run:
```bash
git remote rename origin upstream
git remote add origin https://github.com/<their-username>/nanoclaw.git
git push --force origin main
```

If no: skip — upstream is already configured from step 0.
