# npm Publish Design

**Date**: 2026-04-05
**Status**: Approved

## Goal

Publish the BC MCP server as `business-central-mcp` on npm so users can install and run it via `npx business-central-mcp` without cloning the repo.

## Changes

### package.json

- `name`: `business-central-mcp`
- `version`: `0.1.0` (first public release)
- `description`: descriptive one-liner
- `bin`: `{ "business-central-mcp": "dist/stdio-server.js" }`
- `files`: `["dist/"]` -- only ship compiled output
- `scripts.prepublishOnly`: `tsc --noEmit && tsc` -- type check + build before publish
- Add `keywords`, `repository`, `author`, `license` metadata
- Remove `dotenv` from dependencies

### stdio-server.ts

- Add `#!/usr/bin/env node` shebang at top
- Remove `import { config as dotenvConfig } from 'dotenv'` and `dotenvConfig()` call

### server.ts

- Remove `import { config as dotenvConfig } from 'dotenv'` and `dotenvConfig()` call

### .npmignore

Create file to exclude non-distribution files:
```
tests/
reference/
docs/
poc/
*.md
!README.md
.env*
.state/
logs/
coverage/
*.tsbuildinfo
vitest*.config.ts
tsconfig.json
CLAUDE.md
MICROSOFT*.md
PHASE*.md
DISCOVERIES.md
SECURITY-AUDIT-PROMPT.md
step*.png
test-output.txt
.mcp.json
.playwright-mcp/
Expanded Permissions.xlsx
```

### README.md

Update Quick Start to show `npx` usage and Claude Desktop config with env vars instead of `.env` file.

## User Experience

```json
{
  "mcpServers": {
    "business-central": {
      "command": "npx",
      "args": ["-y", "business-central-mcp"],
      "env": {
        "BC_BASE_URL": "http://your-bc-server/BC",
        "BC_USERNAME": "your-user",
        "BC_PASSWORD": "your-password",
        "BC_TENANT_ID": "default"
      }
    }
  }
}
```

## Out of Scope

- No CLI flags (env vars are sufficient)
- No programmatic API export (this is a standalone server, not a library)
- No Docker image (npm is enough for now)
