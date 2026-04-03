# BC Server Bugs & Protocol Issues

Bugs and undocumented behaviors discovered in Business Central's WebSocket protocol server through decompiled source analysis and live testing.

---

## LogicalDispatcher Modal Frame Leak (BC27/BC28)

**Severity:** High -- blocks all new sessions for the same user until BC service restart.

**Symptom:** After a WebSocket disconnection (clean or abrupt), new sessions for the same user fail with `LogicalModalityViolationException: "There is a dialog box open in another browser window. You must close that dialog box or sign out."` -- even though no browser windows are open.

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

**Affected files (decompiled):**
- `Microsoft.Dynamics.Framework.UI/LogicalDispatcher.cs` -- `[ThreadStatic]` field, `DisposeCurrentDispatcher()`, `HasModalFrames`
- `Microsoft.Dynamics.Framework.UI/LogicalModalityVerifier.cs` -- `VerifyAnyModalFormOpen()`, `CheckAnyModalFormOpen()`
- `Microsoft.Dynamics.Framework.UI/LogicalDispatcherFrame.cs` -- `ContinueExecution` setter pops frame on close
- `Microsoft.Dynamics.Framework.UI/UISession.cs` -- `Dispose()`, `ClearInternal()` force-closes forms
- `Microsoft.Dynamics.Nav.Service/Connection.cs` -- `TerminateSessionAsync()` calls `session.DisposeAsync()`

**Fix (in BC source):** `DisposeCurrentDispatcher()` should clear the `Frames` stack before nulling the reference:

```csharp
internal static void DisposeCurrentDispatcher()
{
    LogicalDispatcher current = currentLogicalDispatcher;
    if (current != null)
    {
        current.Frames.Clear();  // Clear stale modal frames
    }
    currentLogicalDispatcher = null;
}
```

Alternatively, `LogicalThread.Dispose()` should explicitly clear dispatcher frames before disposal.

**Our workaround:** `BCSession.closeGracefully()` sends `CloseForm` for every open form and auto-dismisses save-changes dialogs (responding "no" via `SystemAction.No=390`) before closing the WebSocket. This ensures no modal frames remain in the dispatcher when the session ends. Only unrecoverable scenarios (process kill, power loss) can still trigger the bug.
