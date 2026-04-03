# BC Server Bugs & Protocol Issues

Bugs and undocumented behaviors discovered in Business Central's WebSocket protocol server through decompiled source analysis and live testing. Verified against BC27 and BC28 (protocol version 15041).

---

## 1. LogicalDispatcher Modal Frame Leak

**Severity:** HIGH -- blocks all new sessions for the same user until BC service restart.

**Symptom:** After a WebSocket disconnection (clean or abrupt), new sessions for the same user fail with `LogicalModalityViolationException: "There is a dialog box open in another browser window."` -- even though no browser windows are open.

**Root cause:** `LogicalDispatcher` is stored in a `[ThreadStatic]` field (`LogicalDispatcher.cs:9-10`). When a session ends, `DisposeCurrentDispatcher()` (`LogicalDispatcher.cs:90-93`) sets the thread-static reference to null but does NOT clear the `Frames` stack:

```csharp
// LogicalDispatcher.cs lines 90-93
internal static void DisposeCurrentDispatcher()
{
    currentLogicalDispatcher = null;  // Clears reference but NOT Frames stack
}
```

When a new session is assigned to the same server thread, `LogicalModalityVerifier.VerifyAnyModalFormOpen()` (`LogicalModalityVerifier.cs:69-74`) checks `logicalDispatcher.HasModalFrames` which returns true because the old `Frames` stack still contains modal frames from the dead session:

```csharp
// LogicalDispatcher.cs line 44
public bool HasModalFrames => Frames.Any(frame => frame.ModalForm != null);
```

**Trigger conditions:**
1. A session opens a page that creates a draft record (e.g., Sales Order page 42)
2. The session closes the page, which triggers a "save changes?" modal dialog
3. The session disconnects (WebSocket closes) before the modal dialog is dismissed
4. The dispatcher thread retains the modal frame in its `Frames` stack
5. A new session created on the same thread inherits the stale modal state

**Affected files:**
- `Microsoft.Dynamics.Framework.UI/LogicalDispatcher.cs` -- `[ThreadStatic]` field, `DisposeCurrentDispatcher()`, `HasModalFrames`
- `Microsoft.Dynamics.Framework.UI/LogicalModalityVerifier.cs` -- `VerifyAnyModalFormOpen()`, `CheckAnyModalFormOpen()`
- `Microsoft.Dynamics.Framework.UI/LogicalDispatcherFrame.cs` -- `ContinueExecution` setter pops frame on close
- `Microsoft.Dynamics.Framework.UI/UISession.cs` -- `Dispose()`, `ClearInternal()` force-closes forms
- `Microsoft.Dynamics.Nav.Service/Connection.cs` -- `TerminateSessionAsync()` calls `session.DisposeAsync()`

**Proposed fix:** `DisposeCurrentDispatcher()` should clear the `Frames` stack before nulling the reference:

```csharp
internal static void DisposeCurrentDispatcher()
{
    LogicalDispatcher current = currentLogicalDispatcher;
    if (current != null)
    {
        current.Frames.Clear();
    }
    currentLogicalDispatcher = null;
}
```

**Our workaround:** `BCSession.closeGracefully()` sends `CloseForm` for every open form and auto-dismisses save-changes dialogs before closing the WebSocket.

---

## 2. SequenceNumberProvider Integer Overflow

**Severity:** HIGH -- makes the entire session non-responsive with no recovery path.

**Symptom:** After an extremely long-running session, all subsequent requests fail with `InvalidOperationException: "Tried to set a lower sequence number."` The session becomes permanently unusable.

**Root cause:** `SequenceNumberProvider` (`SequenceNumberProvider.cs`) increments a `long` with no overflow check:

```csharp
public class SequenceNumberProvider : ISequenceNumberProvider
{
    public long Current { get; private set; } = -1L;

    public long NextNumber()
    {
        return ++Current;  // No overflow check
    }
}
```

When `Current` reaches `long.MaxValue`, the next increment wraps to `long.MinValue`. `InteractionSequencing` (`InteractionSequencing.cs:28-29`) then rejects the negative value:

```csharp
if (value < lastSequenceNo)
{
    throw new InvalidOperationException("Tried to set a lower sequence number.");
}
```

**Practical impact:** Requires ~9.2 quintillion interactions to trigger. Not realistic in normal use but could matter for automated test harnesses or long-running integrations that never restart.

**Affected files:**
- `Microsoft.Dynamics.Framework.UI/SequenceNumberProvider.cs` -- no overflow guard
- `Microsoft.Dynamics.Framework.UI.Web/InteractionSequencing.cs` -- rejects wrapped values

**Proposed fix:** Add overflow check or use modular comparison.

---

## 3. InteractionSequencing Dictionary Memory Leak

**Severity:** MEDIUM -- gradual memory exhaustion on BC server.

**Symptom:** BC server memory grows over time, especially with many short-lived sessions.

**Root cause:** `ClientSession` maintains a `ConcurrentDictionary<string, InteractionSequencing>` (`ClientSession.cs:36`) indexed by SPA instance ID prefix. Cleanup only triggers when `Count >= 10` and removes only one entry:

```csharp
if (interactionSequencings.Count >= 10)
{
    RemoveOldestSequenceingEntry();  // Removes exactly 1
}
value = new InteractionSequencing();
interactionSequencings[array[0]] = value;  // Allows growth to 11+
```

No per-session cleanup exists. Each `InteractionSequencing` also holds an unbounded `List<Exception>`.

**Affected files:**
- `Microsoft.Dynamics.Framework.UI.Web/ClientSession.cs:36,189-228` -- dictionary with inadequate cleanup

---

## 4. ResponseSequencing Unbounded Dictionary Growth

**Severity:** MEDIUM -- per-session memory leak.

**Symptom:** Memory grows proportionally to unique SPA instance IDs used during a session's lifetime.

**Root cause:** `ResponseSequencing.currentSequencingNumbers` dictionary (`ResponseSequencing.cs:20`) creates a new `SequenceNumberProvider` for each unique `spaId` but never removes entries:

```csharp
public ISequenceNumberProvider GetSequenceNumberProvider(string spaId)
{
    if (currentSequencingNumbers.TryGetValue(spaId, out var value))
        return value;
    SequenceNumberProvider sequenceNumberProvider = new SequenceNumberProvider();
    currentSequencingNumbers[spaId] = sequenceNumberProvider;  // Never removed
    return sequenceNumberProvider;
}
```

**Affected files:**
- `Microsoft.Dynamics.Framework.UI.Web/ResponseSequencing.cs:20` -- no eviction

---

## 5. UISession.DisposeDisposableResources No Exception Handling

**Severity:** MEDIUM -- resource cleanup failure on session teardown.

**Symptom:** Database connections, file handles, or other IDisposable resources may leak when a session ends.

**Root cause:** The dispose loop in `UISession.DisposeDisposableResources()` (`UISession.cs:1737-1751`) has no try-catch around individual `Dispose()` calls:

```csharp
private void DisposeDisposableResources()
{
    lock (syncRootDisposableResources)
    {
        foreach (IDisposable disposableResource in disposableResources)
        {
            disposableResource.Dispose();  // No try-catch; one failure skips the rest
        }
        disposableResources.Clear();
    }
}
```

If any single `Dispose()` throws, all remaining resources are skipped but the list is still cleared, losing references to undisposed resources.

**Proposed fix:** Wrap each `Dispose()` in a try-catch.

---

## 6. Duplicate Form Registration Race

**Severity:** MEDIUM -- form state corruption on rapid close.

**Root cause:** `UISession.RegisterForm()` (`UISession.cs:1433-1449`) adds forms to both `openedForms` (by ID, unique) and `openedFormsByName` (by name, list). The list can accumulate duplicates if a form is re-registered. `ReleaseForm` (`UISession.cs:1472`) removes only the first occurrence from the list, potentially leaving stale entries.

---

## 7. Static Resource Caches Cross-Session

**Severity:** LOW -- potential information disclosure between tenants.

**Root cause:** `UISession.IconsAndImages` and `UISession.ResourceSets` (`UISession.cs:503-553`) are static caches shared across all sessions. They are never invalidated on session end. If cache entries are tenant-specific or user-specific, data could leak between sessions.

**Affected files:**
- `Microsoft.Dynamics.Framework.UI/UISession.cs:503-553` -- static singleton caches

---

## Summary

| # | Issue | Severity | Type | Practical Impact |
|---|---|---|---|---|
| 1 | ThreadStatic Modal Frame Leak | HIGH | State Leak | Blocks user sessions after disconnect |
| 2 | Sequence Number Overflow | HIGH | Protocol | Session permanently unusable (theoretical) |
| 3 | InteractionSequencing Memory Leak | MEDIUM | DoS | Server memory growth |
| 4 | ResponseSequencing Dict Growth | MEDIUM | DoS | Per-session memory leak |
| 5 | Dispose Without Exception Handling | MEDIUM | Resource Leak | DB/file handle leaks on teardown |
| 6 | Duplicate Form Registration | MEDIUM | Data Integrity | Form state corruption on rapid close |
| 7 | Static Cache Cross-Session | LOW | Info Disclosure | Theoretical tenant data leak |
