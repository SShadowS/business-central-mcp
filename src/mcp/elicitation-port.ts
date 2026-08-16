/**
 * Mutable flag bag filled by MCPHandler.handleInitialize from the client's
 * advertised elicitation capabilities. LoginWindow reads `url` on first
 * authenticate() (after initialize).
 *
 * MCP 2025-11-25: `{ url: {} }` opts the client into URL-mode elicitation
 * (`-32042`). Form mode is never used for passwords.
 */
export class ClientElicitationPort {
  url = false;
  form = false;
}

export function applyElicitationCapabilities(port: ClientElicitationPort, elic: unknown): void {
  port.url = false;
  port.form = false;
  if (elic && typeof elic === 'object') {
    port.form = true;
    port.url = Object.prototype.hasOwnProperty.call(elic, 'url');
  } else if (elic === true) {
    port.form = true;
  }
}
