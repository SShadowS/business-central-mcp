permissionset 50490 "I49 Company Only"
{
    Assignable = true;
    Permissions = tabledata "Company Information" = R;
}

// Restrictive codeunit: how a persona-based suite is written.
codeunit 50490 "I49 Restrictive Tests"
{
    Subtype = Test;
    TestPermissions = Restrictive;

    var
        Assert: Codeunit "Library Assert";
        PermissionsMock: Codeunit "Permissions Mock";

    [Test]
    procedure MockIsStartedByRunner()
    begin
        // Pass = the runner started the Permissions Mock for this test.
        Assert.IsTrue(PermissionsMock.IsStarted(), 'Permissions Mock is NOT started for this Restrictive test');
    end;

    [Test]
    procedure PersonaBlocksCustomerRead()
    var
        Customer: Record Customer;
    begin
        // Persona without Customer access. If the mock is not running, Set() is a silent no-op
        // and the read succeeds as SUPER, so the asserterror fails.
        PermissionsMock.Set('I49 Company Only');
        asserterror Customer.FindFirst();
        Assert.ExpectedErrorCode('DB:ClientReadDenied');
    end;

    [Test]
    procedure NoPersonaReadsCustomer()
    var
        Customer: Record Customer;
    begin
        // Restrictive without a persona: does the platform itself restrict anything?
        if Customer.FindFirst() then;
    end;
}

// Self-starting variant: does the mock work in a TestRunnerHub session when the test starts it?
codeunit 50491 "I49 SelfStart Tests"
{
    Subtype = Test;
    TestPermissions = Restrictive;

    var
        Assert: Codeunit "Library Assert";
        PermissionsMock: Codeunit "Permissions Mock";

    [Test]
    procedure SelfStartedPersonaBlocksCustomerRead()
    var
        Customer: Record Customer;
        StartedHere: Boolean;
        ReadErr: Text;
    begin
        if not PermissionsMock.IsStarted() then begin
            PermissionsMock.Start();
            StartedHere := true;
        end;
        PermissionsMock.Set('I49 Company Only');
        if not TryReadCustomer(Customer) then
            ReadErr := GetLastErrorText();
        PermissionsMock.ClearAssignments();
        if StartedHere then
            PermissionsMock.Stop();
        Assert.AreNotEqual('', ReadErr, 'Customer read was NOT blocked by the self-started persona');
        Assert.IsTrue(StrPos(ReadErr, 'Customer') > 0, 'Unexpected error: ' + ReadErr);
    end;

    [Test]
    procedure MockStoppedAfterSelfStart()
    begin
        // Verifies the previous test did not leak a started SingleInstance mock into the session.
        Assert.IsFalse(PermissionsMock.IsStarted(), 'Permissions Mock leaked as started');
    end;

    [TryFunction]
    local procedure TryReadCustomer(var Customer: Record Customer)
    begin
        Customer.FindFirst();
    end;
}

// Disabled codeunit: does the AL runner start the mock here too? (It toggles regardless of TestPermissions.)
codeunit 50492 "I49 Disabled Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    var
        Assert: Codeunit "Library Assert";
        PermissionsMock: Codeunit "Permissions Mock";

    [Test]
    procedure MockStateUnderDisabled()
    begin
        Assert.IsFalse(PermissionsMock.IsStarted(), 'Permissions Mock IS started for a Disabled test');
    end;
}

// Observation only: always fails, the message reports the effective permission state.
codeunit 50493 "I49 Observe Restrictive"
{
    Subtype = Test;
    TestPermissions = Restrictive;

    [Test]
    procedure Observe()
    var
        Probe: Codeunit "I49 Observe Lib";
    begin
        Error(Probe.State());
    end;
}

codeunit 50494 "I49 Observe Disabled"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure Observe()
    var
        Probe: Codeunit "I49 Observe Lib";
    begin
        Error(Probe.State());
    end;
}

codeunit 50495 "I49 Observe Lib"
{
    procedure State(): Text
    var
        AccessControl: Record "Access Control";
        Customer: Record Customer;
        PermissionsMock: Codeunit "Permissions Mock";
    begin
        exit(StrSubstNo('STATE mockStarted=%1 accessControlWrite=%2 customerWrite=%3 customerRead=%4 probeLogRead=%5 | %6',
            PermissionsMock.IsStarted(), AccessControl.WritePermission(), Customer.WritePermission(), Customer.ReadPermission(),
            ProbeLog.ReadPermission(), D365FullFacts()));
    end;

    local procedure D365FullFacts(): Text
    var
        ExpandedPermission: Record "Expanded Permission";
        Total: Integer;
        AccessControlInsert: Text;
        ProbeLogRead: Text;
    begin
        ExpandedPermission.SetRange("Role ID", 'D365 FULL ACCESS');
        Total := ExpandedPermission.Count();
        ExpandedPermission.SetRange("Object Type", ExpandedPermission."Object Type"::"Table Data");
        ExpandedPermission.SetRange("Object ID", Database::"Access Control");
        if ExpandedPermission.FindFirst() then
            AccessControlInsert := Format(ExpandedPermission."Insert Permission")
        else
            AccessControlInsert := 'absent';
        ExpandedPermission.SetRange("Object ID", Database::"I49 Probe Log");
        if ExpandedPermission.FindFirst() then
            ProbeLogRead := Format(ExpandedPermission."Read Permission")
        else
            ProbeLogRead := 'absent';
        exit(StrSubstNo('D365FULL rows=%1 accessControlInsert=%2 probeLogRead=%3', Total, AccessControlInsert, ProbeLogRead));
    end;

    var
        ProbeLog: Record "I49 Probe Log";
}

// Extension table with no permission set granting it: readable only as SUPER (or with no effective sets).
table 50490 "I49 Probe Log"
{
    DataClassification = SystemMetadata;
    InherentPermissions = X;
    fields
    {
        field(1; "Entry No."; Integer) { }
    }
    keys
    {
        key(PK; "Entry No.") { Clustered = true; }
    }
}
