# Godot GUT Test Provider

A VS Code Test Explorer provider for Godot projects that use the GUT addon at
`addons/gut/gut_cmdln.gd`.

## Third-party dependency: GUT

GUT (Godot Unit Test) is a separate, third-party GDScript testing framework
maintained in the [`bitwes/Gut` repository](https://github.com/bitwes/Gut).
This extension provides VS Code Test Explorer integration; it does not bundle,
install, or redistribute GUT. Install and enable GUT in each Godot project
separately. The provider expects the add-on's command-line entry point at
`addons/gut/gut_cmdln.gd`.

See the upstream [GUT add-on source](https://github.com/bitwes/Gut/tree/main/addons/gut)
and its [MIT license](https://github.com/bitwes/Gut/blob/main/addons/gut/LICENSE.md)
for the add-on's own implementation and terms. GUT's license applies to GUT,
not to this provider; this provider's package remains separately marked
`UNLICENSED`.

## Requirements

- VS Code 1.80 or newer
- A Godot project containing the GUT addon at `addons/gut`
- Godot executable configured through `gutTestProvider.godotPath`,
  `gut-extension.godotOverridePath`, `GODOT4`/`GODOT`, or Godot Tools
- Godot Tools (`geequlim.godot-tools`) for the **Debug** profile

The provider reads `.gutconfig.json` when present. Without it, it searches
`res://tests` for `test_*.gd` files and does not recurse into subdirectories.

## Build and install

From this directory, package the extension and install the generated VSIX:

```powershell
npx --yes @vscode/vsce package --no-dependencies --out godot-gut-test-provider.vsix
code --install-extension .\godot-gut-test-provider.vsix --force
```

Reload the VS Code window after installation.

## Test

```sh
npm test
```

The tests use a temporary generic Godot/GUT fixture and do not depend on a
particular game project.

## Settings

- `gutTestProvider.godotPath`: optional Godot executable path.
- `gutTestProvider.timeoutSeconds`: maximum duration for a non-debug GUT run.
- `gutTestProvider.repeatFailedCount`: number of attempts made by **Repeat
  Failed** (2-20, default 3).
- `gutTestProvider.breakOnFailure`: pause the Debug profile at GUT's assertion
  failure handler (enabled by default).
- `gutTestProvider.breakOnEveryFailure`: keep pausing on every GUT assertion
  failure instead of removing the automatic breakpoint after the first hit.
- `gutTestProvider.openFailureLocation`: open and select the project source
  frame when Debug pauses on a GUT assertion failure or runtime error.
- `gutTestProvider.stopOnErrors`: report and navigate to Godot runtime errors
  when the debugger pauses for an exception (disabled by default).
- `gutTestProvider.additionalArguments`: array of extra Godot/GUT arguments.
  Provider-managed script, selection, report, and debugger arguments cannot be
  overridden.
- `gutTestProvider.environment`: environment variables passed to Godot in all
  profiles. Values can reference existing process variables with
  `${env:NAME}`. Missing references are reported as errors. Debug runs use a
  temporary launcher so the Godot Tools debugger inherits the configured
  values without embedding referenced secret values in the launcher.

The Test Explorer provides **Headless** and **Rendered** run profiles, plus a
**Debug** profile that launches GUT through Godot Tools so GDScript breakpoints
are available. Headless and Rendered runs stream Godot output into the test run
while it is executing. Failure locations use file-and-line information from GUT
when available, falling back to the test file when GUT reports only a line.
Debug runs do not time out while stopped at a breakpoint; cancel the test run
or stop the debug session to end them. Debug output is also streamed into the
Test Explorer run. With `gutTestProvider.breakOnFailure` enabled, Debug pauses on
the first GUT assertion failure and removes that automatic breakpoint while
paused. Set `gutTestProvider.breakOnEveryFailure` to `true` to keep it enabled.
The call stack shows the failing test above GUT's assertion handler. **Rerun
Failed** repeats only failures from the most recent run, using the same profile;
this state is persisted in the workspace between VS Code reloads and resolves
tests by file and method name if their source lines move. Parameterized
failures report the `params[n]` iteration labels GUT provides, but GUT 9.5
aggregates iterations into one testcase and does not support selecting a single
iteration.

**Repeat Failed** runs the most recent failures the configured number of times.
The final result remains failed if any attempt fails, and the output identifies
flaky results and shows each attempt's outcome. **GUT Test Explorer: Export
Last Failure Report** in the Command Palette saves a JSON report containing
project-relative test references, statuses, failure locations, detected Godot
and GUT versions, and a generic command-argument template. It omits raw output,
configured argument values, environment values, and absolute project paths.
When GUT's failure text uses recognizable `Expected` and `Actual` labels, those
values are also exposed as structured VS Code test-message details.
