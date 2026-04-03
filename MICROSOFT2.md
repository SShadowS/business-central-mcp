# BC Server Security Audit -- Extended Findings

Additional vulnerabilities discovered through systematic file-by-file audit of decompiled BC28 source at `U:/git/bc-mcp/reference/bc28/decompiled/`. All findings require authentication unless noted otherwise.

See [MICROSOFT.md](MICROSOFT.md) for the initial 7 bugs (modal frame leak, sequence overflow, memory leaks, etc.) and their PoCs.

---

## Authentication & Attack Surface

All findings below require valid credentials (NTLM + CSRF token) to exploit, with one exception: Finding J (65KB password) has a pre-auth surface at the HTTP Basic Auth handler.

---

## A. Compression Bomb -- Unbounded Decompression in NavDataSet

**Severity:** CRITICAL -- authenticated DoS, server memory exhaustion.

**File:** `Microsoft.Dynamics.Nav.Types/Microsoft.Dynamics.Nav.Types.Data/NavDataSet.cs:226-296`

**Root cause:** `NavDataSet.ReadFrom()` reads table count, column count, and row count as `int` from a binary stream with no bounds checking. Combined with `HybridMemoryDecompressStream`, a small compressed payload can decompress into gigabytes:

```csharp
// NavDataSet.cs lines 232-237
int num = binaryReader.ReadInt32();  // Table count -- up to 2.1 billion
for (int i = 0; i < num; i++)
{
    string name = binaryReader.ReadString();
    int num2 = binaryReader.ReadInt32();  // Column count -- unbounded
    int num3 = binaryReader.ReadInt32();  // Row count -- unbounded
    Tables.Add(name, num3);
```

Similarly, `NavSerializer.cs:378-387` reads media/byte arrays with size from the stream:

```csharp
case NavTypeCode.Media:
{
    int count = binReader.ReadInt32();       // Client-controlled size
    byte[] array = binReader.ReadBytes(count); // Allocates count bytes -- up to 2GB
}
```

**Impact:** An authenticated client sends a small compressed JSON-RPC message (~1KB) that decompresses to multi-GB allocation, crashing the BC service tier with OutOfMemoryException. Affects all users on the same server.

**Proposed fix:** Enforce maximum decompressed size. Validate table/column/row counts against reasonable limits before allocating.

---

## B. Client Can Disable Response Sequencing (Replay Protection Bypass)

**Severity:** CRITICAL -- authenticated replay attack, bypasses idempotency.

**File:** `Microsoft.Dynamics.Framework.UI.Web/CallbackHandler.cs:310-326`

**Root cause:** The `CallbackRequestData` object includes a `DisableResponseSequencing` boolean that the CLIENT controls:

```csharp
// CallbackHandler.cs lines 310-326
bool flag = true;
if (requestData.DisableResponseSequencing ||
    requestData.InteractionsToInvoke.All(
        request => request.InteractionName == "KeepAlive"))
{
    flag = false;  // Sequencing disabled by client request
}
```

When sequencing is disabled, the server skips replay detection entirely. The interaction sequencing object is replaced with `NullInteractionSequencing.Instance`.

**Impact:** An authenticated client can replay any previously captured JSON-RPC message (e.g., a posting action, a payment, a data modification) by setting `DisableResponseSequencing: true`. The server processes the duplicate request without detecting the replay.

**Proposed fix:** Never allow the client to disable sequencing. The `DisableResponseSequencing` flag should be removed or restricted to server-internal use only.

---

## C. Session Fixation -- Client-Supplied Session ID

**Severity:** HIGH -- session fixation, potential session hijacking.

**File:** `Microsoft.Dynamics.Framework.UI/UISessionManager.cs:196-226`

**Root cause:** `UISessionManager.GetSession()` accepts a client-supplied `sessionId` string and creates a new session if one doesn't exist:

```csharp
// UISessionManager.cs lines 196-226
public UISession GetSession(string sessionId, bool createIfNotFound = true)
{
    lock (localSyncRoot)
    {
        if (!UISessions.TryGetValue(sessionId, out var value) && createIfNotFound)
        {
            value = new UISession(sessionId);  // Client-supplied ID accepted
            value.SessionTimeout = sessionTimeout;
            BaseUISessionCreated(value, new RequestContext());
            UISessions.TryAdd(sessionId, value);
        }
        return value;
    }
}
```

No cryptographic session ID generation. Sessions stored in a simple dictionary keyed by the client-supplied string.

**Impact:** If an attacker can predict or guess another user's session ID, they can hijack that session. If session IDs follow a predictable pattern (sequential, timestamp-based, etc.), brute-force is feasible.

**Proposed fix:** Generate session IDs server-side using `RNGCryptoServiceProvider`. Never accept client-supplied session IDs for session creation.

---

## D. Path Traversal in File Deletion

**Severity:** HIGH -- authenticated arbitrary file deletion.

**File:** `Microsoft.Dynamics.Nav.Service.ClientService/UploadDownloadController.cs:162-169`

**Root cause:** File deletion path constructed from user-supplied filename with inadequate sanitization:

```csharp
// UploadDownloadController.cs lines 162-172
string text = fileName;
if (text.Contains("TEMP\\", StringComparison.OrdinalIgnoreCase))
{
    text = text.Substring("TEMP\\".Length, text.Length - "TEMP\\".Length);
}
NavFile.GuardedDelete(text);
```

The `TEMP\\` prefix strip is bypassable:
- Mixed separators: `TEMP/../../etc/passwd`
- Case variations not fully handled
- No verification that the resolved path stays within the temp directory
- Relative path components (`../`) not stripped

**Impact:** An authenticated user could delete arbitrary files accessible to the BC service account.

**Proposed fix:** Resolve the full path, then verify it starts with the expected temp directory. Use `Path.GetFullPath()` and compare against the allowed base directory.

---

## E. Unrestricted JSON Deserialization of Client Parameters

**Severity:** HIGH -- potential for object injection.

**File:** `Microsoft.Dynamics.Framework.UI.Web/CallbackHandlerInteractionInvoker.cs:38-44`

**Root cause:** Client-supplied `NamedParameters` JSON string is deserialized into `Dictionary<string, object>` without schema validation:

```csharp
// CallbackHandlerInteractionInvoker.cs lines 38-44
if (!string.IsNullOrEmpty(item.NamedParameters))
{
    JsonSerializerSettings jsonSerializerSettings = new JsonSerializerSettings();
    jsonSerializerSettings.DateParseHandling = DateParseHandling.None;
    Dictionary<string, object> source = JsonConvert.DeserializeObject<Dictionary<string, object>>(
        item.NamedParameters, jsonSerializerSettings);
    interactionInvocation.NamedParameters.AddRange(source);
}
```

While `TypeNameHandling` defaults to `None` (preventing direct type instantiation gadgets), the `object` values can be complex JObject/JArray instances that downstream code may unsafely cast or process.

**Impact:** Downstream interaction strategies receive arbitrary object graphs from the client. Type confusion, unexpected property access, or unsafe casting in strategy code could lead to logic bypasses or crashes.

**Proposed fix:** Deserialize into strongly-typed parameter classes per interaction type, not generic `Dictionary<string, object>`.

---

## F. No JSON Depth or Size Limits

**Severity:** HIGH -- DoS via deeply nested or extremely large JSON.

**File:** `Microsoft.Dynamics.Nav.ClientServer.JsonRpc/SharedJsonSettings.cs:7-18`

**Root cause:** Newtonsoft.Json serializer configured without protective limits:

```csharp
// SharedJsonSettings.cs lines 9-17
jsonSerializer.TypeNameHandling = TypeNameHandling.None;  // Good
jsonSerializer.Converters.Add(new VersionConverter());
jsonSerializer.Converters.Add(new NavPolymorphicJsonConvert());
jsonSerializer.Converters.Add(navDataSetConverter);
// Missing: MaxDepth, MaxStringContentLength, MaxArrayLength, MaxBytesPerRead
```

**Impact:** An authenticated client sends deeply nested JSON (10,000+ levels) causing StackOverflowException, or a single string property with 2GB of data causing OutOfMemoryException. Either crashes the BC service.

**Proposed fix:** Set `MaxDepth = 64`, add request body size limits at the WebSocket layer.

---

## G. Polymorphic Type Instantiation via `$polyType`

**Severity:** HIGH -- type confusion, potential gadget chain.

**File:** `Microsoft.Dynamics.Nav.Types/NavPolymorphicJsonConvert.cs:71-100`

**Root cause:** Client JSON can include a `$polyType` field that triggers type resolution:

```csharp
// NavPolymorphicJsonConvert.cs lines 80-92
JObject jObject = JObject.Load(reader);  // Loads entire JSON into memory
string requestedType = jObject["$polyType"]?.Value<string>();

// Lines 113-126: TryBindToType
internal bool TryBindToType(Type baseType, string requestedType, out Type polymorphicType)
{
    if (TryGetAllowedExtensionTypeList(baseType, out var types))
    {
        polymorphicType = types.Where(x => x.FullName == requestedType).FirstOrDefault();
        if (polymorphicType != null)
            return true;  // Instantiates the matched type
    }
}
```

The allowed type list is built via reflection on `[NavJsonPolymorphicType]` attributes. If any allowed type has a dangerous constructor, property setter, or implements `ISerializable`, it could be exploited.

**Impact:** Type confusion within the allowed type whitelist. If any whitelisted type has side effects on construction or property setting, those side effects can be triggered by a crafted message.

**Proposed fix:** Minimize the whitelist. Audit all types with `[NavJsonPolymorphicType]` for unsafe constructors/setters.

---

## H. No WebSocket Rate Limiting

**Severity:** HIGH -- authenticated DoS.

**File:** `Microsoft.Dynamics.Nav.Service.ClientService/WebSocketController.cs:19-53`

**Root cause:** WebSocket accepts connections with only `[Authorize]` guard. No per-connection or per-user rate limiting:

```csharp
// WebSocketController.cs lines 17-31
public async Task Connect()
{
    if (base.HttpContext.WebSockets.IsWebSocketRequest)
    {
        WebSocket webSocket = await base.HttpContext.WebSockets.AcceptWebSocketAsync();
        // No rate limiting, no message throttling
        Task task = NsServiceJsonRpcHostFactory.CreateAndRunNsServiceJsonRpcService(...);
    }
}
```

**Impact:** An authenticated client can open multiple WebSocket connections and flood JSON-RPC messages, consuming server CPU and memory. No backpressure mechanism exists.

**Proposed fix:** Implement per-user connection limits and per-connection message rate limiting.

---

## I. Permission Token First-Write-Wins

**Severity:** HIGH -- permission cache poisoning.

**File:** `Microsoft.Dynamics.Framework.UI/UISession.cs:1853-1865`

**Root cause:** The first permission token received is accepted without validation:

```csharp
// UISession.cs lines 1853-1865
public void CheckPermissionsToken(long token)
{
    if (permissionToken == -1)
    {
        permissionToken = token;  // First value accepted unconditionally
    }
    else if (permissionToken != token)
    {
        // ... logging and cache clear ...
    }
}
```

**Impact:** If an attacker can trigger session initialization before the legitimate permission system sets the token, they can set a fake token. Subsequent permission checks compare against the attacker's token, potentially poisoning the permission cache.

**Proposed fix:** Generate permission tokens server-side during session creation. Never accept client-supplied tokens.

---

## J. 65KB Password Processed Before Size Validation

**Severity:** MEDIUM -- pre-auth resource consumption.

**File:** `Microsoft.Dynamics.Nav.Service/NavUserPasswordValidator.cs:183-190`

**This is the only finding with a pre-authentication attack surface.**

**Root cause:** Password size check occurs AFTER the credential has been extracted from the HTTP request and processed in memory:

```csharp
// NavUserPasswordValidator.cs lines 183-190
private static void CheckParmSize(string userName, string password)
{
    if (userName.Length > 10240 || password.Length > 65536)
    {
        throw new NavInvalidCredentialException(...);
    }
}
```

The password (up to 65KB) is fully decoded from Base64, stored in memory as a string, and potentially logged before this check rejects it.

**Impact:** An unauthenticated attacker can send 65KB passwords in rapid succession to consume server memory and CPU during NTLM negotiation. Not a full DoS but adds load.

**Proposed fix:** Check Content-Length before reading the request body. Reject requests with oversized Authorization headers at the HTTP middleware layer.

---

## K. Token Replay Across Load-Balanced Servers

**Severity:** MEDIUM -- authentication bypass in multi-server deployments.

**File:** `Microsoft.Dynamics.Nav.Service/TokenReplayDetection.cs:14-26`

**Root cause:** Token replay detection uses a process-local `ConcurrentDictionary`:

```csharp
// TokenReplayDetection.cs lines 14-26
private static ConcurrentDictionary<string, DateTime> usedAcsTokens =
    new ConcurrentDictionary<string, DateTime>();
```

In a load-balanced deployment with multiple BC service instances, each server maintains its own replay cache. A token used on Server A is not known to Server B.

**Impact:** An attacker captures a valid authentication token and replays it on a different server in the cluster within the 10-minute cleanup interval.

**Proposed fix:** Use a distributed cache (Redis, SQL) for token replay detection, or include server-specific nonces in tokens.

---

## L. PermissionsService Default Implementation is a Stub

**Severity:** MEDIUM -- authorization bypass if not overridden.

**File:** `Microsoft.Dynamics.Framework.UI/PermissionsService.cs:1-51`

**Root cause:** The default `PermissionsService` returns empty permissions:

```csharp
// PermissionsService.cs
public class PermissionsService : IUIPermissionsService, IUIService, IPermissionsService
{
    public virtual IReadOnlyDictionary<string, bool> CreatePermissions()
    {
        return new Dictionary<string, bool>();  // Empty -- no permissions
    }

    public virtual bool HasPermission(string permission)
    {
        Permissions.TryGetValue(permission, out var value);
        return value;  // Always false for empty dictionary
    }
}
```

**Impact:** If the BC runtime fails to register the proper permissions service override, all permission checks silently return false, potentially denying all access (fail-closed) or, depending on how callers interpret the result, allowing all access (fail-open).

**Proposed fix:** Make `PermissionsService` abstract, forcing implementations to provide real permission logic. Add a startup assertion that validates the service is properly registered.

---

## Summary

| # | Issue | Severity | Pre-Auth | Cross-User | File |
|---|---|---|---|---|---|
| A | Compression bomb (unbounded decompression) | CRITICAL | NO | YES (server crash) | NavDataSet.cs:226 |
| B | Client disables replay protection | CRITICAL | NO | NO | CallbackHandler.cs:310 |
| C | Session fixation (client-supplied ID) | HIGH | NO | YES (hijack) | UISessionManager.cs:196 |
| D | Path traversal in file deletion | HIGH | NO | YES (server files) | UploadDownloadController.cs:162 |
| E | Unrestricted JSON deser of parameters | HIGH | NO | NO | CallbackHandlerInteractionInvoker.cs:38 |
| F | No JSON depth/size limits | HIGH | NO | YES (server crash) | SharedJsonSettings.cs:7 |
| G | Polymorphic type instantiation | HIGH | NO | NO | NavPolymorphicJsonConvert.cs:71 |
| H | No WebSocket rate limiting | HIGH | NO | YES (server DoS) | WebSocketController.cs:19 |
| I | Permission token first-write-wins | HIGH | NO | NO | UISession.cs:1853 |
| J | 65KB password pre-auth processing | MEDIUM | **YES** | NO | NavUserPasswordValidator.cs:183 |
| K | Token replay across servers | MEDIUM | NO | YES (impersonation) | TokenReplayDetection.cs:14 |
| L | PermissionsService is stub | MEDIUM | NO | Depends | PermissionsService.cs:1 |
