import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';
import { mcpServersToOpenCodeConfig } from './mcp-to-opencode.js';
import { memoryContextForSessionStart, type MemorySessionHookRegistration } from '../memory/session-hook.js';
import { TIMEZONE, formatLocalStamp } from '../timezone.js';

function log(msg: string): void {
  console.error(`[opencode-provider] ${msg}`);
}

const SESSION_STATUS_RETRY_ERROR_AFTER = 3;

/** Stale / dead OpenCode session heuristics (complement Claude-centric host patterns). */
const STALE_SESSION_RE =
  /no conversation found|ENOENT.*\.jsonl|session.*not found|NotFoundError|connection reset|ECONNRESET|404|event timeout/i;

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, 'SIGKILL');
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function spawnOpencodeServer(config: Record<string, unknown>, timeoutMs = 10_000): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const hostname = '127.0.0.1';
    const port = 4096;
    const proc = spawn('opencode', ['serve', `--hostname=${hostname}`, `--port=${port}`], {
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
      detached: true,
    });

    const id = setTimeout(() => {
      killProcessTree(proc);
      reject(new Error(`Timeout waiting for OpenCode server to start after ${timeoutMs}ms`));
    }, timeoutMs);

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (match) {
            clearTimeout(id);
            resolve({ url: match[1], proc });
          }
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    proc.on('exit', (code) => {
      clearTimeout(id);
      let msg = `OpenCode server exited with code ${code}`;
      if (output.trim()) msg += `\nServer output: ${output}`;
      reject(new Error(msg));
    });
    proc.on('error', (err) => {
      clearTimeout(id);
      reject(err);
    });
  });
}

function wrapPromptWithContext(text: string, systemInstructions?: string): string {
  let out = text;
  if (systemInstructions) {
    out = `<system>\n${systemInstructions}\n</system>\n\n${out}`;
  }
  return out;
}

function buildOpenCodeConfig(options: ProviderOptions): Record<string, unknown> {
  const provider = process.env.OPENCODE_PROVIDER || 'anthropic';
  const model = process.env.OPENCODE_MODEL;
  const smallModel = process.env.OPENCODE_SMALL_MODEL;
  const proxyUrl = process.env.ANTHROPIC_BASE_URL;

  const providerModelId = model ? model.replace(new RegExp(`^${provider}/`), '') : undefined;
  const providerSmallModelId = smallModel ? smallModel.replace(new RegExp(`^${provider}/`), '') : undefined;
  const modelsToRegister = [providerModelId, providerSmallModelId]
    .filter(Boolean)
    .filter((mid, i, a) => a.indexOf(mid as string) === i);

  const providerOptions: Record<string, unknown> =
    provider === 'anthropic'
      ? {}
      : {
          [provider]: {
            options: { apiKey: 'placeholder', baseURL: proxyUrl },
            ...(modelsToRegister.length > 0
              ? {
                  models: Object.fromEntries(
                    modelsToRegister.map((mid) => [mid, { id: mid, name: mid, tool_call: true }]),
                  ),
                }
              : {}),
          },
        };

  const mcp = mcpServersToOpenCodeConfig(options.mcpServers);

  // Load shared base + per-group fragments + per-group memory through OpenCode's
  // native instructions pipeline (session/instruction.ts). Absolute paths with
  // globs are supported. Files are read raw — `@./...` includes are NOT expanded
  // by OpenCode, so point at the concrete files, not at composed CLAUDE.md.
  const instructions = [
    '/app/CLAUDE.md',
    '/workspace/agent/.claude-fragments/*.md',
    '/workspace/agent/CLAUDE.local.md',
  ];

  return {
    ...(model ? { model } : {}),
    ...(smallModel ? { small_model: smallModel } : {}),
    enabled_providers: [provider],
    permission: 'allow',
    autoupdate: false,
    snapshot: false,
    provider: providerOptions,
    instructions,
    mcp,
  };
}

type SharedRuntime = {
  proc: ChildProcess;
  client: OpencodeClient;
  stream: AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
  streamRelease: () => void;
};

let sharedRuntime: SharedRuntime | null = null;
let sharedConfigKey: string | null = null;
let sharedInit: Promise<SharedRuntime> | null = null;

function runtimeConfigKey(options: ProviderOptions): string {
  return JSON.stringify({
    mcp: mcpServersToOpenCodeConfig(options.mcpServers),
    model: process.env.OPENCODE_MODEL,
    small: process.env.OPENCODE_SMALL_MODEL,
    op: process.env.OPENCODE_PROVIDER,
  });
}

async function ensureSharedRuntime(options: ProviderOptions): Promise<SharedRuntime> {
  const key = runtimeConfigKey(options);
  if (sharedRuntime && sharedConfigKey === key) return sharedRuntime;

  if (sharedInit) return sharedInit;

  sharedInit = (async () => {
    if (sharedRuntime) {
      destroySharedRuntime();
    }
    const config = buildOpenCodeConfig(options);
    const { url, proc } = await spawnOpencodeServer(config);
    const client = createOpencodeClient({ baseUrl: url });
    const sub = await client.event.subscribe();
    const stream = sub.stream as AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void>;
    sharedRuntime = {
      proc,
      client,
      stream,
      streamRelease: () => {
        void stream.return?.(undefined);
      },
    };
    sharedConfigKey = key;
    sharedInit = null;
    return sharedRuntime;
  })();

  return sharedInit;
}

export function destroySharedRuntime(): void {
  if (sharedRuntime) {
    try {
      sharedRuntime.streamRelease();
    } catch {
      /* ignore */
    }
    killProcessTree(sharedRuntime.proc);
    sharedRuntime = null;
    sharedConfigKey = null;
  }
  sharedInit = null;
}

function sessionErrorMessage(props: { error?: unknown }): string {
  const err = props.error as { data?: { message?: string } } | undefined;
  if (err && typeof err === 'object' && err.data && typeof err.data.message === 'string') {
    return err.data.message;
  }
  return JSON.stringify(props.error) || 'OpenCode session error';
}

// ── Context-size bounding ──
//
// A chat-completions call is stateless per request, so OpenCode's own
// server resends the full accumulated session on every turn to keep
// context. Left unchecked, a long-lived session (resumed across polls and
// container restarts via `continuation`) grows forever. Two guards, mirroring
// Claude's transcript-size/age rotation in this file's sibling `claude.ts`:
//
//  1. Mid-session compaction: once the latest turn's context tokens cross
//     OPENCODE_SESSION_COMPACT_TOKENS, ask OpenCode's own `/session/{id}/summarize`
//     to compact its history in place (keeps the same session id).
//  2. Cold-resume rotation (`maybeRotateContinuation`): a backstop at
//     container start — if compaction never happened or the session is
//     simply too old, archive a markdown summary and start fresh.

interface OpenCodeTokenUsage {
  input?: number;
  cache?: { read?: number; write?: number };
}

/** Total tokens the last turn sent as context: fresh input + everything served from cache. */
function totalContextTokens(tokens?: OpenCodeTokenUsage): number {
  if (!tokens) return 0;
  return (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
}

function opencodeCompactTokens(): number {
  return Number(process.env.OPENCODE_SESSION_COMPACT_TOKENS) || 100_000;
}

function opencodeCompactCooldownMs(): number {
  return Number(process.env.OPENCODE_SESSION_COMPACT_COOLDOWN_MS) || 10 * 60_000;
}

function opencodeRotateTokens(): number {
  return Number(process.env.OPENCODE_SESSION_ROTATE_TOKENS) || 300_000;
}

function opencodeRotateAgeMs(): number {
  const raw = process.env.OPENCODE_SESSION_ROTATE_AGE_DAYS;
  if (raw === undefined || raw.trim() === '') return 14 * 86_400_000;
  const days = Number(raw);
  if (!Number.isFinite(days)) return 14 * 86_400_000;
  // Explicit non-positive override disables the age check; the token cap alone governs.
  if (days <= 0) return 0;
  return days * 86_400_000;
}

/** Cheapest configured model wins — summarization doesn't need the main model. */
function resolveSummarizeModel(): { providerID: string; modelID: string } | null {
  const providerID = process.env.OPENCODE_PROVIDER || 'anthropic';
  const raw = process.env.OPENCODE_SMALL_MODEL || process.env.OPENCODE_MODEL;
  if (!raw) return null;
  const modelID = raw.replace(new RegExp(`^${providerID}/`), '');
  return { providerID, modelID };
}

async function withTemporaryOpenCodeServer<T>(fn: (client: OpencodeClient) => Promise<T>): Promise<T> {
  const { url, proc } = await spawnOpencodeServer({});
  try {
    return await fn(createOpencodeClient({ baseUrl: url }));
  } finally {
    killProcessTree(proc);
  }
}

interface OpenCodeArchivableMessage {
  info: { role: string; summary?: boolean };
  parts: Array<{ type: string; text?: string }>;
}

/**
 * Render a rotated OpenCode session as markdown into the agent's
 * `conversations/` folder, mirroring Claude's `archiveTranscriptFile` — best
 * effort, so context survives rotation instead of vanishing outright.
 */
function archiveOpenCodeMessages(messages: OpenCodeArchivableMessage[], assistantName?: string): void {
  try {
    const parsed = messages
      // Compaction runs produce their own synthetic assistant message — not part of the real exchange.
      .filter((m) => !(m.info.role === 'assistant' && m.info.summary))
      .map((m) => ({
        role: m.info.role,
        content: m.parts
          .filter((p) => p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join(''),
      }))
      .filter((m) => m.content);
    if (parsed.length === 0) return;

    const conversationsDir = process.env.NANOCLAW_CONVERSATIONS_DIR || '/workspace/agent/conversations';
    fs.mkdirSync(conversationsDir, { recursive: true });
    const filename = `${formatLocalStamp(new Date(), TIMEZONE).slice(0, 10)}-opencode-rotated-${Date.now()}.md`;
    const lines = ['# Conversation (rotated)', '', `Archived: ${formatLocalStamp(new Date(), TIMEZONE)}`, '', '---', ''];
    for (const m of parsed) {
      const sender = m.role === 'user' ? 'User' : assistantName || 'Assistant';
      const content = m.content.length > 2000 ? `${m.content.slice(0, 2000)}...` : m.content;
      lines.push(`**${sender}**: ${content}`, '');
    }
    fs.writeFileSync(path.join(conversationsDir, filename), lines.join('\n'));
    log(`Archived rotated OpenCode session to ${filename}`);
  } catch (err) {
    log(`Failed to archive OpenCode session: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export class OpenCodeProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly options: ProviderOptions;
  private activeSessionId: string | undefined;
  private memorySessionHook: MemorySessionHookRegistration | undefined;
  // Cooldown gate for mid-session compaction — see the `session.summarize`
  // call in query()'s gen(). Time-based rather than event-based (e.g.
  // "wait for the summary message to land") so it self-heals even if a
  // summarize call is dropped or its completion is never observed.
  private compactionCooldownSessionId: string | undefined;
  private compactionCooldownUntil = 0;

  constructor(options: ProviderOptions = {}) {
    this.options = options;
  }

  // OpenCode has no Claude-style session-start command hook. We record the
  // registration for parity and inject the rendered memory section into the
  // system context of each new (non-resumed) session in query() instead —
  // OpenCode's native session-start mechanism is instruction/prompt injection.
  registerMemorySessionHook(hook: MemorySessionHookRegistration): void {
    this.memorySessionHook = hook;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  /**
   * Cold-resume guard: on container start, check the stored session's size
   * (context tokens on its last turn) and age via a throwaway OpenCode
   * server, and drop it if either is past cap. Best effort — any failure
   * here (including no `opencode` binary reachable) just skips the check and
   * keeps resuming, same as Claude's transcript-read failure path.
   */
  async maybeRotateContinuation(continuation: string): Promise<string | null> {
    try {
      return await withTemporaryOpenCodeServer(async (client) => {
        const sessionRes = await client.session.get({ path: { id: continuation } });
        if (sessionRes.error || !sessionRes.data) return null;

        const messagesRes = await client.session.messages({ path: { id: continuation } });
        const messages = (messagesRes.data ?? []) as unknown as Array<
          OpenCodeArchivableMessage & { info: { tokens?: OpenCodeTokenUsage } }
        >;

        const lastAssistant = messages.filter((m) => m.info.role === 'assistant' && !m.info.summary).pop();
        const contextTokens = totalContextTokens(lastAssistant?.info.tokens);

        const maxAgeMs = opencodeRotateAgeMs();
        const ageMs = Date.now() - sessionRes.data.time.created;

        let reason: string | null = null;
        if (contextTokens > opencodeRotateTokens()) {
          reason = `session context ~${contextTokens} tokens > ${opencodeRotateTokens()} cap`;
        } else if (maxAgeMs > 0 && ageMs > maxAgeMs) {
          reason = `session ${(ageMs / 86_400_000).toFixed(1)}d old > ${(maxAgeMs / 86_400_000).toFixed(0)}d cap`;
        }
        if (!reason) return null;

        archiveOpenCodeMessages(messages, this.options.assistantName);
        return reason;
      });
    } catch (err) {
      log(`maybeRotateContinuation check failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  query(input: QueryInput): AgentQuery {
    if (input.continuation) {
      this.activeSessionId = input.continuation;
    } else {
      this.activeSessionId = undefined;
    }

    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    // On a fresh context window (no continuation), fold the shared memory
    // section into the system context. On resume, OpenCode keeps the prior
    // context, so we skip it — mirroring memoryContextForSessionStart's
    // 'resume' → undefined contract.
    const memorySection = this.memorySessionHook && !input.continuation
      ? memoryContextForSessionStart('startup')
      : undefined;
    const systemInstructions = [memorySection, input.systemContext?.instructions]
      .filter(Boolean)
      .join('\n\n') || undefined;
    pending.push(wrapPromptWithContext(input.prompt, systemInstructions));

    const kick = (): void => {
      waiting?.();
    };

    const self = this;
    const IDLE_TIMEOUT_MS = Number(process.env.OPENCODE_IDLE_TIMEOUT_MS) || 300_000;

    async function* gen(): AsyncGenerator<ProviderEvent> {
      let initYielded = false;
      const rt = await ensureSharedRuntime(self.options);
      const { client, stream } = rt;

      while (!aborted) {
        while (pending.length === 0 && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (aborted) return;
        if (pending.length === 0 && ended) return;

        const text = pending.shift()!;
        let sessionId = self.activeSessionId;

        if (!sessionId) {
          const created = await client.session.create();
          if (created.error) {
            throw new Error(`OpenCode: failed to create session: ${JSON.stringify(created.error)}`);
          }
          sessionId = created.data?.id;
          if (!sessionId) throw new Error('OpenCode: failed to create session (no id)');
          self.activeSessionId = sessionId;
        }

        if (!initYielded) {
          yield { type: 'init', continuation: sessionId };
          initYielded = true;
        }

        const promptRes = await client.session.promptAsync({
          path: { id: sessionId },
          body: { parts: [{ type: 'text', text }] },
        });
        if (promptRes.error) {
          self.activeSessionId = undefined;
          throw new Error(`OpenCode promptAsync: ${JSON.stringify(promptRes.error)}`);
        }

        const partTextByMessageId = new Map<string, string>();
        const roleByMessageId = new Map<string, string>();
        // A summarize() call's own synthetic assistant message shares this
        // session id and the same event stream — never treat it as the reply.
        const summaryMessageIds = new Set<string>();
        let lastAssistantTokens: OpenCodeTokenUsage | undefined;
        let lastEventAt = Date.now();
        let eventTimedOut = false;
        const timeoutCheck = setInterval(() => {
          if (Date.now() - lastEventAt > IDLE_TIMEOUT_MS) {
            log(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms) — clearing session ${sessionId}`);
            eventTimedOut = true;
            self.activeSessionId = undefined;
            destroySharedRuntime();
            kick();
          }
        }, 5000);

        try {
          turn: while (true) {
            if (aborted) return;
            if (eventTimedOut) {
              throw new Error(`OpenCode event timeout (${IDLE_TIMEOUT_MS}ms)`);
            }

            const { value: ev, done } = await stream.next();
            if (done) {
              throw new Error('OpenCode SSE stream ended unexpectedly');
            }

            if (!ev?.type || ev.type === 'server.connected' || ev.type === 'server.heartbeat') continue;

            lastEventAt = Date.now();
            yield { type: 'activity' };

            switch (ev.type) {
              case 'message.updated': {
                const info = ev.properties.info as
                  | { id?: string; role?: string; summary?: boolean; tokens?: OpenCodeTokenUsage }
                  | undefined;
                if (info?.id && info?.role) {
                  roleByMessageId.set(info.id, info.role);
                }
                if (info?.role === 'assistant') {
                  if (info.summary && info.id) {
                    summaryMessageIds.add(info.id);
                  } else if (info.tokens) {
                    lastAssistantTokens = info.tokens;
                  }
                }
                break;
              }
              case 'message.part.updated': {
                const part = ev.properties.part as { type?: string; messageID?: string; text?: string } | undefined;
                if (part?.type === 'text' && part.messageID && part.text) {
                  partTextByMessageId.set(part.messageID, part.text);
                }
                break;
              }
              case 'permission.updated': {
                const perm = ev.properties as { id?: string; sessionID?: string };
                if (perm.sessionID === sessionId && perm.id) {
                  try {
                    await client.postSessionIdPermissionsPermissionId({
                      path: { id: sessionId, permissionID: perm.id },
                      body: { response: 'always' },
                    });
                  } catch (err) {
                    log(`Failed to auto-reply permission: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
                break;
              }
              case 'session.status': {
                const props = ev.properties as {
                  sessionID?: string;
                  status?: { type?: string; attempt?: number; message?: string };
                };
                if (props.sessionID !== sessionId) break;
                const st = props.status;
                if (
                  st?.type === 'retry' &&
                  typeof st.attempt === 'number' &&
                  st.attempt >= SESSION_STATUS_RETRY_ERROR_AFTER &&
                  st.message
                ) {
                  self.activeSessionId = undefined;
                  throw new Error(`OpenCode retry limit (${st.attempt}): ${st.message}`);
                }
                break;
              }
              case 'session.error': {
                const props = ev.properties as { sessionID?: string; error?: unknown };
                if (props.sessionID === sessionId || props.sessionID === undefined) {
                  self.activeSessionId = undefined;
                  throw new Error(sessionErrorMessage(props));
                }
                break;
              }
              case 'session.idle': {
                const sid = (ev.properties as { sessionID?: string }).sessionID;
                if (sid === sessionId) {
                  break turn;
                }
                break;
              }
              default:
                break;
            }
          }
        } finally {
          clearInterval(timeoutCheck);
        }

        let resultText = '';
        for (const [msgId, role] of roleByMessageId) {
          if (role === 'assistant' && !summaryMessageIds.has(msgId)) {
            resultText = partTextByMessageId.get(msgId) ?? resultText;
          }
        }
        yield { type: 'result', text: resultText || null };

        // Mid-session compaction: once this turn's context tokens cross the
        // cap, ask OpenCode to summarize its own history in place. Fire and
        // forget — its completion (and any events it emits) is handled by
        // whichever turn's event loop is reading the shared stream when it
        // lands; summaryMessageIds above keeps that from being mistaken for
        // a reply. The cooldown re-arms this on a timer, not on observing
        // completion, so it self-heals even if that message never arrives.
        const contextTokens = totalContextTokens(lastAssistantTokens);
        const compactCap = opencodeCompactTokens();
        const onCooldown =
          self.compactionCooldownSessionId === sessionId && Date.now() < self.compactionCooldownUntil;
        if (contextTokens > compactCap && !onCooldown) {
          const target = resolveSummarizeModel();
          if (target) {
            self.compactionCooldownSessionId = sessionId;
            self.compactionCooldownUntil = Date.now() + opencodeCompactCooldownMs();
            log(`Requesting compaction for session ${sessionId} (~${contextTokens} context tokens > ${compactCap} cap)`);
            client.session.summarize({ path: { id: sessionId }, body: target }).catch((err) => {
              log(`Compaction request failed: ${err instanceof Error ? err.message : String(err)}`);
            });
          }
        }
      }
    }

    return {
      push: (message: string) => {
        pending.push(wrapPromptWithContext(message, systemInstructions));
        kick();
      },
      end: () => {
        ended = true;
        kick();
      },
      events: gen(),
      abort: () => {
        aborted = true;
        this.activeSessionId = undefined;
        kick();
        destroySharedRuntime();
      },
    };
  }
}

registerProvider('opencode', (opts) => new OpenCodeProvider(opts));
