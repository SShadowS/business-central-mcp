# Issue49 Permissions Probe

Test app for `bc_run_tests` (#43). It tells the AL Test Runner (page 130455, runner 130450) apart from runners that skip its before-test hook, like the dev endpoint's TestRunnerHub (SShadowS/bc-dev-mcp#49).

- App ID `6c3f0b8e-4f49-4b49-9a49-0049c0de4949`, version 1.0.0.3, object IDs 50490..50495
- Depends on Microsoft `Permissions Mock` and `Library Assert` (28.0.0.0 or later). Both must be installed, not only published.
- The compiled `.app` is committed so a test can publish it without symbols. To rebuild, put the Microsoft symbol packages in `.alpackages/` (git-ignored) and run `alc /project:. /packagecachepath:.alpackages`.

Publish: `curl -u <user>:<pw> -F "file=@SShadowS_Issue49 Permissions Probe_1.0.0.3.app" "http://<server>:7049/BC/dev/apps?SchemaUpdateMode=forcesync&tenant=default"`

## Expected results with `bc_run_tests { "codeunits": "50490..50494" }`

8 rows, 4 passed and 4 failed. Measured on Cronus28 (BC 28.4) and Cronus29 (BC 29.0) on 2026-10-19.

| Codeunit | Method | AL Test Runner | TestRunnerHub (for contrast) |
|---|---|---|---|
| 50490 Restrictive | MockIsStartedByRunner | passed | failed |
| 50490 Restrictive | PersonaBlocksCustomerRead | passed | failed |
| 50490 Restrictive | NoPersonaReadsCustomer | passed | passed |
| 50491 SelfStart | SelfStartedPersonaBlocksCustomerRead | passed | passed |
| 50491 SelfStart | MockStoppedAfterSelfStart | failed: "Permissions Mock leaked as started" | passed |
| 50492 Disabled | MockStateUnderDisabled | failed: "Permissions Mock IS started for a Disabled test" | passed |
| 50493 Observe Restrictive | Observe | failed (always), message starts `STATE mockStarted=Yes` | `STATE mockStarted=No` |
| 50494 Observe Disabled | Observe | failed (always), message starts `STATE mockStarted=Yes` | `STATE mockStarted=No` |

The two expected failures under the AL Test Runner are not bugs in the runner. It starts the mock for every test, Disabled ones too, so a test that expects it stopped fails. Assert on the rows, not on `outcome`.

The Observe tests always fail on purpose and report the effective permission state in the message. `probeLogRead` depends on the container:

- 50493 Restrictive: `probeLogRead=No` when Microsoft `Tests-TestLibraries` is installed (its codeunit 130302 sets D365 FULL ACCESS as the baseline), `probeLogRead=Yes` when it is not.
- 50494 Disabled: always `probeLogRead=Yes`.

`methods: "*Persona*"` matches 3 tests (PersonaBlocksCustomerRead, NoPersonaReadsCustomer, SelfStartedPersonaBlocksCustomerRead), all passed.
