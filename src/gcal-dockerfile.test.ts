/**
 * Dependency guard for the Google Calendar MCP server (host/vitest tree).
 *
 * `@cocal/google-calendar-mcp` is a stdio CLI installed globally in the image,
 * not an imported module, so no behavior test can drive it and `tsc` never sees
 * it. This image installs global Node CLIs from `container/cli-tools.json` (via
 * install-cli-tools.sh's single pinned `pnpm install -g`), NOT via inline
 * Dockerfile RUN blocks. So the guard asserts the manifest still carries the
 * calendar package pinned to an exact version. Drop the entry and this goes red.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

function cliTools(): Array<{ name: string; version: string }> {
  const p = path.resolve(process.cwd(), 'container/cli-tools.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('container/cli-tools.json installs @cocal/google-calendar-mcp', () => {
  const tools = cliTools();

  it('lists @cocal/google-calendar-mcp pinned to an exact version', () => {
    const cal = tools.find((t) => t.name === '@cocal/google-calendar-mcp');
    expect(cal).toBeDefined();
    expect(cal!.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
