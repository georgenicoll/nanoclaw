/**
 * Structural guard for the Gmail MCP package-install integration point (container image).
 *
 * `@gongrzhe/server-gmail-autoauth-mcp` is a CLI binary installed into the image — it is
 * not importable or typed from this tree, so the build leg can't catch its removal and
 * there's no runtime seam to behavior-test.
 *
 * This image installs global Node CLIs from `container/cli-tools.json` (via
 * install-cli-tools.sh's single pinned `pnpm install -g`), NOT via inline Dockerfile
 * RUN blocks. So the guard asserts the manifest still carries the gmail-mcp package and
 * the zod-to-json-schema pin workaround. Drop either and this goes red, signalling the
 * agent would boot without the `gmail-mcp` binary on PATH (or with the broken zod resolve).
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'bun:test';

function cliTools(): Array<{ name: string; version: string }> {
  // container/agent-runner/src/providers/ -> ../../../cli-tools.json == container/cli-tools.json
  const p = path.join(import.meta.dir, '..', '..', '..', 'cli-tools.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('container/cli-tools.json installs the Gmail MCP server', () => {
  const tools = cliTools();

  it('lists @gongrzhe/server-gmail-autoauth-mcp pinned to an exact version', () => {
    const gmail = tools.find((t) => t.name === '@gongrzhe/server-gmail-autoauth-mcp');
    expect(gmail).toBeDefined();
    expect(/^\d+\.\d+\.\d+$/.test(gmail!.version)).toBe(true);
  });

  it('pins the zod-to-json-schema workaround version (3.22.5)', () => {
    const zod = tools.find((t) => t.name === 'zod-to-json-schema');
    expect(zod).toBeDefined();
    expect(zod!.version).toBe('3.22.5');
  });
});
