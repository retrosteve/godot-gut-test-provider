"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "gut-test-provider-fixture-"));
const sampleFile = "tests/test_sample.gd";
const sampleMethod = "test_example_passes";
const secondMethod = "test_another_example";
const gutFailureMethodLine = 4;
const gutFailureSource =
	"extends RefCounted\n\nfunc _fail(text):\n\t_summary.failed += 1\n\tgut._fail(text)\n";

fs.mkdirSync(path.join(projectPath, "addons", "gut"), { recursive: true });
fs.mkdirSync(path.join(projectPath, "tests"), { recursive: true });
fs.mkdirSync(path.join(projectPath, "scripts"), { recursive: true });
fs.writeFileSync(path.join(projectPath, "project.godot"), "config_version=5\n");
fs.writeFileSync(
	path.join(projectPath, ".gutconfig.json"),
	JSON.stringify({ dirs: ["res://tests"], include_subdirs: true })
);
fs.writeFileSync(
	path.join(projectPath, "addons", "gut", "gut_cmdln.gd"),
	"extends SceneTree\n"
);
fs.writeFileSync(
	path.join(projectPath, "addons", "gut", "test.gd"),
	gutFailureSource
);
fs.writeFileSync(
	path.join(projectPath, sampleFile),
	`extends GutTest\n\nfunc ${sampleMethod}() -> void:\n\tassert_true(true)\n\nfunc ${secondMethod}() -> void:\n\tassert_true(true)\n`
);
fs.writeFileSync(
	path.join(projectPath, "scripts", "test_helper.gd"),
	"extends RefCounted\n\nfunc helper() -> void:\n\tpass\n"
);

process.on("exit", () => fs.rmSync(projectPath, { recursive: true, force: true }));

function collection() {
	const items = new Map();
	items.add = (item) => items.set(item.id, item);
	items.replace = (replacement) => {
		items.clear();
		replacement.forEach(items.add);
	};
	return items;
}

function enumerateTestItems(file) {
	const items = [];
	const visit = (children, innerClassName = "") => {
		for (const item of children.values()) {
			if (item.id.startsWith("suite:")) {
				visit(item.children, item.label);
			} else if (item.id.startsWith("test:")) {
				items.push({
					item,
					classname: `${file.id.slice("file:".length)}${
						innerClassName ? `.${innerClassName}` : ""
					}`
				});
			}
		}
	};
	visit(file.children);
	return items;
}

function createHarness({
	failure = false,
	failureText = "Example assertion failure",
	hang = false,
	extraCases = false,
	timeoutSeconds = 30,
	breakOnFailure = true,
	additionalArguments = [],
	environment = {},
	resultStatuses = {},
	gutFailureSource: failureSource = gutFailureSource,
	workspaceState = new Map(),
	breakOnEveryFailure = false,
	debugStopWithoutSource = false,
	stopOnErrors = false,
	openFailureLocation = true,
	debugException = false,
	debugOutputSource = false,
	testLinePrefix = "",
	resultStatusSequences = {},
	repeatFailedCount = 3,
	environmentForReport = {},
	additionalArgumentsForReport = [],
	reportPath = path.join(os.tmpdir(), `gut-test-provider-report-${process.pid}.json`),
	versionOutput = "",
	additionalProject = false,
	innerClassSource = "",
	innerClassPrefix = "Test",
	startupError = ""
} = {}) {
	const profiles = [];
	const launches = [];
	const results = [];
	const errors = [];
	const outputs = [];
	const started = [];
	const debugConfigurations = [];
	const debugLauncherContents = [];
	const addedBreakpoints = [];
	const removedBreakpoints = [];
	const debugTrackerFactories = [];
	const openedDocuments = [];
	const debugStartListeners = [];
	const debugTerminationListeners = [];
	const cancelListeners = [];
	const commandHandlers = new Map();
	const controllers = [];
	const fileWatchers = [];
	fs.writeFileSync(
		path.join(projectPath, sampleFile),
		`${testLinePrefix}extends GutTest\n\nfunc ${sampleMethod}() -> void:\n\tassert_true(true)\n\nfunc ${secondMethod}() -> void:\n\tassert_true(true)\n${innerClassSource}`
	);
	fs.writeFileSync(
		path.join(projectPath, ".gutconfig.json"),
		JSON.stringify({
			dirs: ["res://tests"],
			include_subdirs: true,
			inner_class_prefix: innerClassPrefix
		})
	);
	const token = {
		isCancellationRequested: false,
		onCancellationRequested(listener) {
			cancelListeners.push(listener);
			return { dispose() {} };
		}
	};
	const disposable = () => ({ dispose() {} });
	fs.writeFileSync(path.join(projectPath, "addons", "gut", "test.gd"), failureSource);
	function createController() {
		return {
			items: collection(),
			dispose() {},
			createRunProfile(label, kind, callback, isDefault) {
				const profile = { label, kind, callback, isDefault };
				profiles.push(profile);
				return profile;
			},
			createTestItem(id, label, uri) {
				const item = { id, label, children: collection() };
				Object.defineProperty(item, "uri", {
					value: uri,
					enumerable: true,
					writable: false
				});
				return item;
			},
			createTestRun() {
			const run = {
				started(item) {
					started.push(item);
				},
				appendOutput(text, location, test) {
					outputs.push({ text, id: test?.id, location });
				},
				end() {}
			};
			for (const status of ["passed", "skipped", "failed", "errored"]) {
				run[status] = (item, message) => results.push({ id: item.id, status, message });
			}
			return run;
			}
		}
	};
	const controller = createController();
	controllers.push(controller);
	if (additionalProject) {
		const secondProjectPath = path.join(projectPath, "additional-project");
		fs.mkdirSync(path.join(secondProjectPath, "addons", "gut"), { recursive: true });
		fs.mkdirSync(path.join(secondProjectPath, "tests"), { recursive: true });
		fs.writeFileSync(path.join(secondProjectPath, "project.godot"), "config_version=5\n");
		fs.writeFileSync(
			path.join(secondProjectPath, "addons", "gut", "gut_cmdln.gd"),
			"extends SceneTree\n"
		);
		fs.writeFileSync(
			path.join(secondProjectPath, ".gutconfig.json"),
			JSON.stringify({ dirs: ["res://tests"] })
		);
		fs.writeFileSync(
			path.join(secondProjectPath, sampleFile),
			`extends GutTest\n\nfunc ${sampleMethod}() -> void:\n\tassert_true(true)\n`
		);
		const secondController = createController();
		secondController.rootPath = secondProjectPath;
		controllers.push(secondController);
	}
	const vscode = {
		tests: {
			createTestController(id, label) {
				const created = controllers.shift() ?? createController();
				created.id = id;
				created.label = label;
				controllers.push(created);
				return created;
			}
		},
		TestRunProfileKind: { Run: 1, Debug: 2 },
		SourceBreakpoint: class {
			constructor(location) {
				this.location = location;
			}
		},
		Uri: { file: (fsPath) => ({ fsPath }) },
		Range: class {
			constructor(startLine, startCharacter, endLine, endCharacter) {
				this.start = { line: startLine, character: startCharacter };
				this.end = { line: endLine, character: endCharacter };
			}
		},
		Selection: class {
			constructor(startLine, startCharacter, endLine, endCharacter) {
				this.start = { line: startLine, character: startCharacter };
				this.end = { line: endLine, character: endCharacter };
			}
		},
		Location: class {
			constructor(uri, range) {
				this.uri = uri;
				this.range = range;
			}
		},
		RelativePattern: class {},
		TestMessage: class {
			constructor(message) {
				this.message = message;
			}
		},
		window: {
			showErrorMessage: (message) => errors.push(message),
			async showTextDocument(uri) {
				const document = {
					uri,
					revealedRange: null,
					selection: null,
					revealRange(range) {
						this.revealedRange = range;
					}
				};
				openedDocuments.push(document);
				return document;
			}
		},
		workspace: {
			workspaceFolders: [
				{ uri: { fsPath: projectPath } },
				...(additionalProject
					? [{ uri: { fsPath: path.join(projectPath, "additional-project") } }]
					: [])
			],
			textDocuments: [],
			workspaceState: {
				get(key, fallback) {
					return workspaceState.has(key) ? workspaceState.get(key) : fallback;
				},
				async update(key, value) {
					workspaceState.set(key, value);
				}
			},
			getConfiguration: () => ({
				get(key, fallback) {
					if (key === "godotPath") {
						return "mock-godot";
					}
					if (key === "breakOnFailure") {
						return breakOnFailure;
					}
					if (key === "breakOnEveryFailure") {
						return breakOnEveryFailure;
					}
					if (key === "openFailureLocation") {
						return openFailureLocation;
					}
					if (key === "stopOnErrors") {
						return stopOnErrors;
					}
					if (key === "repeatFailedCount") {
						return repeatFailedCount;
					}
					if (key === "additionalArguments") {
						return additionalArgumentsForReport.length
							? additionalArgumentsForReport
							: additionalArguments;
					}
					if (key === "environment") {
						return Object.keys(environmentForReport).length
							? environmentForReport
							: environment;
					}
					return key === "timeoutSeconds" ? timeoutSeconds : fallback;
				}
			}),
			onDidChangeConfiguration: disposable,
			createFileSystemWatcher: () => {
				const watcher = {
					onDidCreate(listener) {
						this.created = listener;
					},
					onDidChange(listener) {
						this.changed = listener;
					},
					onDidDelete(listener) {
						this.deleted = listener;
					},
					dispose() {}
				};
				fileWatchers.push(watcher);
				return watcher;
			}
		}
	};
	vscode.commands = {
		registerCommand(name, callback) {
			commandHandlers.set(name, callback);
			return disposable();
		},
		executeCommand(name, ...args) {
			outputs.push({ command: name, args });
		}
	};
	vscode.window.showSaveDialog = async () => ({ fsPath: reportPath });
	vscode.window.showQuickPick = async (choices) => choices[0];
	vscode.window.showInformationMessage = async (message) => outputs.push({ text: message });
	const spawn = (executable, args, options) => {
		const launchNumber = launches.length;
		launches.push({ executable, args, options });
		const handle = new EventEmitter();
		handle.stdout = new EventEmitter();
		handle.stderr = new EventEmitter();
		handle.kill = () => handle.emit("close", null, "SIGTERM");
		if (hang) {
			queueMicrotask(() => handle.stdout.emit("data", Buffer.from("GUT is waiting\n")));
			return handle;
		}
		queueMicrotask(() => {
			handle.stdout.emit(
				"data",
				Buffer.from(startupError || "GUT output line\n")
			);
			if (versionOutput) {
				handle.stdout.emit("data", Buffer.from(`${versionOutput}\n`));
			}
			const cases = extraCases
				? [
						`<testcase name="${sampleMethod}" classname="tests/other_file.gd" status="fail" time="0.01">` +
						"<failure>Result from another file</failure>" +
						"</testcase>"
					]
				: [];
			for (const file of controller.items.values()) {
				for (const { item, classname } of enumerateTestItems(file)) {
					const sequence = resultStatusSequences[item.label];
					const caseStatus =
						sequence?.[Math.min(launchNumber, sequence.length - 1)] ??
						resultStatuses[item.label] ??
						(failure ? "fail" : args.includes("--headless") ? "pending" : "pass");
					cases.push(
						`<testcase name="${item.label}" classname="${classname}" status="${caseStatus}" time="0.01">` +
						(caseStatus === "fail" ? `<failure>${failureText}</failure>` : "") +
						(caseStatus === "pending"
							? "<skipped message=\"pending\"><![CDATA[Requires rendering]]></skipped>"
							: "") +
						"</testcase>"
					);
				}
			}
			fs.writeFileSync(args[args.indexOf("-gjunit_xml_file") + 1], cases.join(""));
			handle.emit("close", failure || startupError ? 1 : 0, null);
		});
		return handle;
	};
	const emitDebugTermination = (session) => {
		for (const listener of [...debugTerminationListeners]) {
			listener(session);
		}
	};
	vscode.debug = {
		registerDebugAdapterTrackerFactory(type, factory) {
			debugTrackerFactories.push({ type, factory });
			return disposable();
		},
		addBreakpoints(breakpoints) {
			addedBreakpoints.push(...breakpoints);
		},
		removeBreakpoints(breakpoints) {
			removedBreakpoints.push(...breakpoints);
		},
		onDidStartDebugSession(listener) {
			debugStartListeners.push(listener);
			return {
				dispose() {
					const index = debugStartListeners.indexOf(listener);
					if (index !== -1) {
						debugStartListeners.splice(index, 1);
					}
				}
			};
		},
		onDidTerminateDebugSession(listener) {
			debugTerminationListeners.push(listener);
			return {
				dispose() {
					const index = debugTerminationListeners.indexOf(listener);
					if (index !== -1) {
						debugTerminationListeners.splice(index, 1);
					}
				}
			};
		},
		async startDebugging(_folder, configuration) {
			debugConfigurations.push(configuration);
			if (configuration.editor_path !== "mock-godot") {
				debugLauncherContents.push(
					fs.readFileSync(configuration.editor_path, "utf8") +
						(process.platform === "win32"
							? fs.readFileSync(configuration.editor_path.replace(/\.cmd$/i, ".ps1"), "utf8")
							: "")
				);
			}
			const session = {
				name: configuration.name,
				type: configuration.type,
				async customRequest(command, args) {
					assert.equal(command, "stackTrace");
					return {
						stackFrames: [
							{
								line: addedBreakpoints[0].location.range.start.line + 1,
								source: { path: addedBreakpoints[0].location.uri.fsPath }
							},
							{
								line: 3,
								source: { path: path.join(projectPath, sampleFile) }
							}
						]
					};
				}
			};
			const trackerFactory = debugTrackerFactories.find((entry) => entry.type === "godot");
			const tracker = trackerFactory?.factory.createDebugAdapterTracker(session);
			for (const listener of [...debugStartListeners]) {
				listener(session);
			}
			tracker?.onDidSendMessage({
				type: "event",
				event: "output",
				body: {
					output: "Debug engine output\n",
					...(debugOutputSource
						? {
								source: { path: path.join(projectPath, sampleFile) },
								line: 3
							}
						: {})
				}
			});
			if (addedBreakpoints.length > 0) {
				for (let hit = 0; hit < 2; hit += 1) {
					tracker?.onDidSendMessage({
						type: "event",
						event: "stopped",
						body: {
							reason: "breakpoint",
							threadId: 1,
							...(debugStopWithoutSource
								? {}
								: {
										source: { path: addedBreakpoints[0].location.uri.fsPath },
										line: addedBreakpoints[0].location.range.start.line + 1
									})
						}
					});
				}
			}
			if (debugException) {
				tracker?.onDidSendMessage({
					type: "event",
					event: "stopped",
					body: {
						reason: "exception",
						threadId: 1,
						text: "Invalid call. Nonexistent function."
					}
				});
			}
			queueMicrotask(() => {
				const reportMatch =
					/"-gjunit_xml_file"\s+"([^"]+)"/.exec(configuration.additional_options);
				assert.ok(reportMatch, "Debug launch must include a JUnit report path.");
				const cases = [];
				for (const file of controller.items.values()) {
					for (const { item, classname } of enumerateTestItems(file)) {
						const caseStatus = resultStatuses[item.label] ?? "pass";
						cases.push(
							`<testcase name="${item.label}" classname="${classname}" status="${caseStatus}" time="0.01">` +
								(caseStatus === "fail" ? `<failure>${failureText}</failure>` : "") +
								"</testcase>"
						);
					}
				}
				fs.writeFileSync(reportMatch[1], cases.join(""));
				emitDebugTermination(session);
			});
			return true;
		},
		async stopDebugging(session) {
			emitDebugTermination(session);
			return true;
		}
	};
	const context = {
		subscriptions: [],
		workspaceState: {
			get(key, fallback) {
				return workspaceState.has(key) ? workspaceState.get(key) : fallback;
			},
			async update(key, value) {
				workspaceState.set(key, value);
			}
		}
	};
	const sandbox = {
		module: { exports: {} },
		require: (name) => {
			if (name === "vscode") {
				return vscode;
			}
			if (name === "node:child_process") {
				return { spawn };
			}
			return require(name);
		},
		process,
		Buffer,
		setTimeout,
		clearTimeout
	};
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, "extension.js"), "utf8"), sandbox);
	sandbox.module.exports.activate(context);
	return {
		profiles,
		controllers,
		fileWatchers,
		launches,
		debugConfigurations,
		debugLauncherContents,
		addedBreakpoints,
		removedBreakpoints,
		openedDocuments,
		workspaceState,
		reportPath,
		commandHandlers,
		cancelListeners,
		results,
		errors,
		outputs,
		started,
		controller,
		cancel() {
			token.isCancellationRequested = true;
			for (const listener of cancelListeners) {
				listener();
			}
		},
		async run(profileName, selection) {
			const file = controller.items.get(`file:${sampleFile}`);
			assert.ok(file, "The provider must discover the sample test file.");
			await controller.resolveHandler(file);
			const method = [...file.children.values()].find((item) => item.label === sampleMethod);
			assert.ok(method, "The provider must discover the selected test.");
			const include = selection === "all" ? undefined : [selection === "file" ? file : method];
			await this.runRequest(profileName, { include });
			return results.find((result) => result.id === method.id);
		},
		async runRequest(profileName, request) {
			const profile = profiles.find((candidate) => candidate.label === profileName);
			assert.ok(profile, `The ${profileName} profile must exist.`);
			await profile.callback(request, token);
			assert.deepEqual(errors, []);
		},
		async invokeCommand(name) {
			const callback = commandHandlers.get(name);
			assert.ok(callback, `The ${name} command must be registered.`);
			await callback();
		}
	};
}

test("test items point at their func line", async () => {
	const harness = createHarness();
	const file = harness.controller.items.get(`file:${sampleFile}`);
	assert.equal(file.children.size, 0, "Test methods should be discovered on demand.");
	await harness.controller.resolveHandler(file);
	const method = [...file.children.values()].find((item) => item.label === sampleMethod);
	assert.equal(method.range.start.line, 2, "The range should start on the func line (0-based).");
});

test("run profile configuration opens the provider settings", async () => {
	const harness = createHarness();
	for (const profile of harness.profiles) {
		assert.equal(typeof profile.configureHandler, "function");
		await profile.configureHandler();
	}
	assert.equal(
		harness.outputs.filter(
			(output) =>
				output.command === "workbench.action.openSettings" &&
				output.args[0] === "@ext:retrosteve.godot-gut-test-provider"
		).length,
		harness.profiles.length
	);
});

test("test IDs remain stable when methods move and unchanged items are reused", async () => {
	const harness = createHarness();
	const file = harness.controller.items.get(`file:${sampleFile}`);
	await harness.controller.resolveHandler(file);
	const original = [...file.children.values()].find((item) => item.label === sampleMethod);
	fs.writeFileSync(
		path.join(projectPath, sampleFile),
		`# moved\n# moved again\nextends GutTest\n\nfunc ${sampleMethod}() -> void:\n\tassert_true(true)\n`
	);
	await harness.controller.refreshHandler();
	const moved = [...file.children.values()].find((item) => item.label === sampleMethod);
	assert.equal(moved.id, original.id);
	assert.equal(moved.range.start.line, 4);
});

test("multi-root workspaces create isolated controllers for each GUT project", async () => {
	const harness = createHarness({ additionalProject: true });
	assert.equal(harness.controllers.length, 2);
	assert.notEqual(harness.controllers[0].id, harness.controllers[1].id);
	assert.notEqual(harness.controllers[0].label, harness.controllers[1].label);
	for (const controller of harness.controllers) {
		const file = controller.items.get(`file:${sampleFile}`);
		assert.ok(file);
		await controller.resolveHandler(file);
		assert.ok([...file.children.values()].some((item) => item.label === sampleMethod));
	}
});

test("skipped tests report the GUT pending reason", async () => {
	const harness = createHarness();
	const result = await harness.run("Headless", "test");
	assert.equal(result.status, "skipped");
	assert.ok(
		harness.outputs.some((output) => output.id === result.id && output.text.includes("Requires rendering")),
		"The pending reason must be attached to the skipped test item."
	);
});

test("file runs report only test methods, not a file-level result", async () => {
	const harness = createHarness();
	await harness.run("Headless", "file");
	assert.equal(
		harness.results.some((item) => item.id.startsWith("file:")),
		false,
		"File nodes should not receive their own run result."
	);
	assert.ok(
		harness.results.some((item) => item.id.includes(sampleMethod) && item.status === "skipped"),
		"Each method should still receive its own result."
	);
	assert.ok(
		harness.outputs.every((output) => !output.id?.startsWith("file:")),
		"File nodes should not receive a summary output."
	);
});

test("passing tests report their location and duration", async () => {
	const harness = createHarness();
	const result = await harness.run("Rendered", "test");
	assert.equal(result.status, "passed");
	assert.ok(
		harness.outputs.some(
			(output) => output.id === result.id && /^PASS .+::.+/.test(output.text)
		),
		"Passing test items should have output describing the test."
	);
});

test("results are matched by file as well as test name", async () => {
	const harness = createHarness({ extraCases: true });
	const result = await harness.run("Rendered", "test");
	assert.equal(result.status, "passed", result.message?.message);
});

test("inner test classes are selectable and their JUnit results are matched", async () => {
	const innerMethod = "test_nested_passes";
	const harness = createHarness({
		innerClassPrefix: "Spec",
		innerClassSource: `class SpecNested:\n\textends GutTest\n\tfunc ${innerMethod}() -> void:\n\t\tassert_true(true)\n`
	});
	const file = harness.controller.items.get(`file:${sampleFile}`);
	await harness.controller.resolveHandler(file);
	const suite = [...file.children.values()].find((item) => item.id.startsWith("suite:"));
	assert.ok(suite, "The configured GUT inner-class prefix should create a suite.");
	const method = [...suite.children.values()].find((item) => item.label === innerMethod);
	assert.ok(method, "Methods inside a GUT inner class should be discovered.");

	await harness.runRequest("Rendered", { include: [suite] });

	const result = harness.results.find((item) => item.id === method.id);
	assert.equal(result.status, "passed", result.message?.message);
	const args = harness.launches[0].args;
	const innerClassArgument = args.indexOf("-ginner_class");
	assert.notEqual(innerClassArgument, -1, "The selected inner class must be passed to GUT.");
	assert.equal(args[innerClassArgument + 1], "SpecNested");
});

test("GUT startup errors link to source locations inside the project", async () => {
	const sourceLocation = `res://${sampleFile}:3`;
	const harness = createHarness({
		startupError: `SCRIPT ERROR: Parse Error at ${sourceLocation}\n`
	});

	const result = await harness.run("Rendered", "test");

	assert.equal(result.status, "errored");
	assert.equal(result.message.location.uri.fsPath, path.join(projectPath, sampleFile));
	assert.equal(result.message.location.range.start.line, 2);
});

test("Godot timeouts are reported as errors", async () => {
	const harness = createHarness({ hang: true, timeoutSeconds: 1 });
	const result = await harness.run("Rendered", "test");
	assert.equal(result.status, "errored");
	assert.match(result.message.message, /timed out after 1 seconds/);
});

test("cancelling a run skips its results", async () => {
	const harness = createHarness({ hang: true });
	const pending = harness.run("Rendered", "test");
	await new Promise((resolve) => setImmediate(resolve));
	harness.cancel();
	const result = await pending;
	assert.equal(harness.launches.length, 1);
	assert.equal(result.status, "skipped");
});

test("process output is streamed while a run is still active", async () => {
	const harness = createHarness({ hang: true });
	const pending = harness.run("Rendered", "test");
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(
		harness.outputs.some((output) => output.text.includes("GUT is waiting")),
		"Live Godot output should reach the Test Explorer before the process exits."
	);
	harness.cancel();
	await pending;
});

test("excluded tests are not run when their containing file is selected", async () => {
	const harness = createHarness();
	const file = harness.controller.items.get(`file:${sampleFile}`);
	await harness.controller.resolveHandler(file);
	const methods = [...file.children.values()];
	const excluded = methods.find((item) => item.label === secondMethod);
	const selected = methods.find((item) => item.label === sampleMethod);

	await harness.runRequest("Headless", { include: [file], exclude: [excluded] });

	assert.equal(harness.launches.length, 1);
	assert.equal(
		harness.launches[0].args[harness.launches[0].args.indexOf("-gunit_test_name") + 1],
		sampleMethod
	);
	assert.deepEqual(harness.started.map((item) => item.id), [selected.id]);
	assert.equal(harness.results.some((result) => result.id === excluded.id), false);
});

test("failure locations use the GDScript source file in the GUT report", async () => {
	const harness = createHarness({
		failure: true,
		failureText:
			"Expected 2 but got 3\n\n            at res://scripts/test_helper.gd:4\n            at res://scripts/caller.gd:12"
	});
	const result = await harness.run("Rendered", "test");
	assert.equal(result.status, "failed");
	assert.equal(result.message.location.range.start.line, 3);
	assert.equal(
		result.message.location.uri.fsPath,
		path.join(projectPath, "scripts", "test_helper.gd")
	);
	assert.ok(
		harness.outputs.some(
			(output) =>
				output.id === result.id &&
				output.text.includes("FAIL scripts/test_helper.gd:4::") &&
				output.text.includes("at scripts/caller.gd:12")
		)
	);
	assert.ok(
		harness.outputs.some(
			(output) =>
				output.id === result.id &&
				output.location?.uri.fsPath === path.join(projectPath, "scripts", "test_helper.gd")
		),
		"The failure output should be clickable at the reported source location."
	);
});

test("assertion messages expose expected and actual values to VS Code", async () => {
	const harness = createHarness({
		failure: true,
		failureText: "Expected: 2\nActual: 3"
	});
	const result = await harness.run("Rendered", "test");
	assert.equal(result.status, "failed");
	assert.equal(result.message.expectedOutput, "2");
	assert.equal(result.message.actualOutput, "3");

	const inlineHarness = createHarness({
		failure: true,
		failureText: "Expected 7 but got 8"
	});
	const inlineResult = await inlineHarness.run("Rendered", "test");
	assert.equal(inlineResult.message.expectedOutput, "7");
	assert.equal(inlineResult.message.actualOutput, "8");
});

test("parameterized failure labels are included in test output", async () => {
	const harness = createHarness({
		failure: true,
		failureText: "params[2] Expected 2 but got 3"
	});
	const result = await harness.run("Rendered", "test");
	assert.equal(result.status, "failed");
	assert.ok(
		harness.outputs.some(
			(output) =>
				output.id === result.id && output.text.includes("Parameterized case(s): params[2]")
		)
	);
});

test("Rerun Failed repeats only failures with the previous profile", async () => {
	const resultStatuses = {
		[sampleMethod]: "pass",
		[secondMethod]: "fail"
	};
	const harness = createHarness({ resultStatuses });
	await harness.runRequest("Rendered", { include: undefined });
	assert.equal(harness.results.filter((result) => result.status === "failed").length, 1);

	await harness.runRequest("Rerun Failed", { include: undefined });

	assert.equal(harness.launches.length, 2);
	const { args } = harness.launches[1];
	assert.equal(args.includes("--headless"), false, "The previous Rendered profile should be reused.");
	assert.ok(args.includes(`-gtest=res://${sampleFile}`));
	assert.equal(args[args.indexOf("-gunit_test_name") + 1], secondMethod);
	assert.equal(harness.started.at(-1).label, secondMethod);
});

test("Rerun Failed state survives provider reactivation", async () => {
	const workspaceState = new Map();
	const firstRun = createHarness({
		workspaceState,
		resultStatuses: {
			[sampleMethod]: "pass",
			[secondMethod]: "fail"
		}
	});
	await firstRun.runRequest("Rendered", { include: undefined });

	const nextActivation = createHarness({ workspaceState });
	await nextActivation.runRequest("Rerun Failed", { include: undefined });

	assert.equal(nextActivation.launches.length, 1);
	assert.equal(nextActivation.launches[0].args.includes("--headless"), false);
	assert.equal(
		nextActivation.launches[0].args[
			nextActivation.launches[0].args.indexOf("-gunit_test_name") + 1
		],
		secondMethod
	);
});

test("Rerun Failed resolves tests after their source line moves", async () => {
	const workspaceState = new Map();
	const firstRun = createHarness({
		workspaceState,
		resultStatuses: { [secondMethod]: "fail" }
	});
	await firstRun.runRequest("Rendered", { include: undefined });

	const nextActivation = createHarness({
		workspaceState,
		testLinePrefix: "# moved down\n# moved again\n"
	});
	await nextActivation.runRequest("Rerun Failed", { include: undefined });

	assert.equal(nextActivation.launches.length, 1);
	assert.equal(
		nextActivation.launches[0].args[
			nextActivation.launches[0].args.indexOf("-gunit_test_name") + 1
		],
		secondMethod
	);
});

test("Rerun Failed reports when there are no previous failures", async () => {
	const harness = createHarness();
	await harness.runRequest("Rerun Failed", { include: undefined });
	assert.equal(harness.launches.length, 0);
	assert.ok(harness.outputs.some((output) => output.text.includes("No failed GUT tests")));
});

test("Rerun Failed preserves the Debug profile", async () => {
	const harness = createHarness({ resultStatuses: { [secondMethod]: "fail" } });
	await harness.runRequest("Debug", { include: undefined });
	await harness.runRequest("Rerun Failed", { include: undefined });
	assert.equal(harness.debugConfigurations.length, 2);
	assert.equal(harness.launches.length, 0);
	assert.equal(
		harness.debugConfigurations[0].additional_options.includes("-gunit_test_name"),
		false
	);
	assert.ok(
		harness.debugConfigurations[1].additional_options.includes(
			`"-gunit_test_name" "${secondMethod}"`
		)
	);
});

test("Repeat Failed reruns previous failures and reports every attempt", async () => {
	const harness = createHarness({
		resultStatusSequences: {
			[sampleMethod]: ["fail", "fail", "pass", "fail"]
		},
		repeatFailedCount: 3
	});
	await harness.run("Rendered", "test");
	await harness.runRequest("Repeat Failed", { include: undefined });

	assert.equal(harness.launches.length, 4);
	const result = harness.results.at(-1);
	assert.equal(result.status, "failed");
	assert.match(result.message.message, /Attempt 1: fail/);
	assert.match(result.message.message, /Attempt 2: pass/);
	assert.match(result.message.message, /Attempt 3: fail/);
	assert.ok(
		harness.outputs.some((output) => output.text.includes("Attempts: 2 failed, 1 passed"))
	);
	assert.ok(
		harness.outputs.some((output) => output.text.includes("Attempt 2/3")),
		"Each repeated attempt should be visible in Test Explorer output."
	);
});

test("Repeat Failed reports invalid repetition counts", async () => {
	const harness = createHarness({ failure: true, repeatFailedCount: 1 });
	await harness.run("Rendered", "test");
	const profile = harness.profiles.find((candidate) => candidate.label === "Repeat Failed");
	await profile.callback(
		{ include: undefined },
		{
			isCancellationRequested: false,
			onCancellationRequested() {
				return { dispose() {} };
			}
		}
	);
	assert.ok(
		harness.errors.some((message) => message.includes("must be an integer from 2 to 20"))
	);
});

test("Continuous profile reruns selected tests after project GDScript changes", async () => {
	const harness = createHarness();
	const profile = harness.profiles.find((candidate) => candidate.label === "Continuous");
	assert.equal(profile.supportsContinuousRun, true);
	const file = harness.controller.items.get(`file:${sampleFile}`);
	await harness.controller.resolveHandler(file);
	const method = [...file.children.values()].find((item) => item.label === sampleMethod);
	const continuousToken = {
		isCancellationRequested: false,
		onCancellationRequested(listener) {
			harness.cancelListeners.push(listener);
			return { dispose() {} };
		}
	};
	const pending = profile.callback(
		{ include: [method], continuous: true },
		continuousToken
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(harness.launches.length, 1);
	fs.writeFileSync(
		path.join(projectPath, sampleFile),
		`# changed\nextends GutTest\n\nfunc ${sampleMethod}() -> void:\n\tassert_true(true)\n`
	);
	await harness.fileWatchers[0].changed({ fsPath: path.join(projectPath, sampleFile) });
	await new Promise((resolve) => setTimeout(resolve, 450));
	assert.equal(harness.launches.length, 2);
	continuousToken.isCancellationRequested = true;
	for (const listener of harness.cancelListeners) {
		listener();
	}
	await pending;
});

test("Continuous changes cancel stale active runs before rerunning", async () => {
	const harness = createHarness({ hang: true });
	const profile = harness.profiles.find((candidate) => candidate.label === "Continuous");
	const file = harness.controller.items.get(`file:${sampleFile}`);
	await harness.controller.resolveHandler(file);
	const method = [...file.children.values()].find((item) => item.label === sampleMethod);
	const continuousListeners = [];
	const continuousToken = {
		isCancellationRequested: false,
		onCancellationRequested(listener) {
			continuousListeners.push(listener);
			return { dispose() {} };
		}
	};
	const pending = profile.callback(
		{ include: [method], continuous: true },
		continuousToken
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(harness.launches.length, 1);
	fs.writeFileSync(
		path.join(projectPath, sampleFile),
		`# changed while running\nextends GutTest\n\nfunc ${sampleMethod}() -> void:\n\tassert_true(true)\n`
	);
	await harness.fileWatchers[0].changed({ fsPath: path.join(projectPath, sampleFile) });
	for (let attempt = 0; attempt < 30 && harness.launches.length < 2; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(harness.launches.length, 2, "The changed selection should be run again.");
	assert.ok(
		harness.results.some(
			(result) => result.id === method.id && result.status === "skipped"
		),
		"The cancelled stale run should not report an error or pass."
	);
	continuousToken.isCancellationRequested = true;
	for (const listener of continuousListeners) {
		listener();
	}
	await pending;
});

test("reproduction reports export generic test references without argument or environment values", async () => {
	const reportPath = path.join(os.tmpdir(), `gut-test-provider-export-${process.pid}.json`);
	const secret = "report-test-secret";
	const harness = createHarness({
		failure: true,
		failureText: `Expected ${secret}`,
		environmentForReport: { GUT_TOKEN: secret },
		additionalArgumentsForReport: [`--private=${secret}`],
		reportPath,
		versionOutput: "Godot Engine v4.5.1.stable\nGUT version: 9.5.0"
	});
	try {
		await harness.run("Rendered", "test");
		await harness.invokeCommand("gutTestProvider.exportReproductionReport");
		const reportText = fs.readFileSync(reportPath, "utf8");
		const report = JSON.parse(reportText);
		assert.equal(report.profile, "Rendered");
		assert.deepEqual(report.environmentVariableNames, ["GUT_TOKEN"]);
		assert.equal(report.additionalArgumentCount, 1);
		assert.deepEqual(report.versions, { godot: "4.5.1", gut: "9.5.0" });
		assert.equal(report.tests[0].path, sampleFile);
		assert.equal(report.tests[0].methodName, sampleMethod);
		assert.deepEqual(report.tests[0].commandArguments, [
			"godot",
			"--rendering-method",
			"gl_compatibility",
			"--resolution",
			"320x240",
			"--audio-driver",
			"Dummy",
			"--path",
			"<project-root>",
			"-s",
			"res://addons/gut/gut_cmdln.gd",
			"-gconfig=",
			`-gtest=res://${sampleFile}`,
			"-gunit_test_name",
			sampleMethod,
			"-gexit"
		]);
		assert.equal(reportText.includes(secret), false);
		assert.equal(reportText.includes(projectPath), false);
	} finally {
		fs.rmSync(reportPath, { force: true });
	}
});

test("additional Godot arguments and environment reach normal runs", async () => {
	const harness = createHarness({
		additionalArguments: ["--verbose", "-glog=3"],
		environment: { GUT_DEBUG_MODE: "verbose value" }
	});
	await harness.run("Rendered", "test");
	const { args, options } = harness.launches[0];
	assert.ok(args.includes("--verbose"));
	assert.ok(args.includes("-glog=3"));
	assert.equal(options.env.GUT_DEBUG_MODE, "verbose value");
});

test("Debug profile forwards environment variables through its launcher", async () => {
	const environment = { GUT_DEBUG_MODE: "verbose value" };
	const harness = createHarness({
		environment,
		additionalArguments: ["--verbose", "-glog=3"]
	});
	const result = await harness.run("Debug", "test");
	const configuration = harness.debugConfigurations[0];
	assert.ok(configuration, `Debug failed: ${result?.message?.message ?? "unknown error"}`);
	const encoded = Buffer.from(JSON.stringify(environment), "utf8").toString("base64");
	assert.notEqual(configuration.editor_path, "mock-godot");
	assert.ok(harness.debugLauncherContents[0].includes(encoded));
	assert.ok(configuration.additional_options.includes('"--verbose"'));
	assert.ok(configuration.additional_options.includes('"-glog=3"'));
});

test("additional arguments cannot override provider-managed GUT options", async () => {
	const harness = createHarness({ additionalArguments: ["-gtest=res://other.gd"] });
	assert.ok(
		harness.errors.some((message) =>
			message.includes('cannot override the provider-managed argument "-gtest"')
		)
	);
	assert.ok(
		harness.controller.items.size === 0,
		"Invalid configuration should prevent test discovery."
	);
	assert.equal(harness.launches.length, 0);
});

test("Debug profile explains when the GUT failure hook is incompatible", async () => {
	const harness = createHarness({
		gutFailureSource: "extends RefCounted\n\nfunc _fail(text):\n\tpass\n"
	});
	const result = await harness.run("Debug", "test");
	assert.equal(result.status, "errored");
	assert.equal(harness.debugConfigurations.length, 0);
	assert.ok(
		harness.outputs.some((output) =>
			output.text.includes("This GUT version may be incompatible")
		)
	);
});

test("Debug profile launches GUT through the Godot Tools debugger", async () => {
	const harness = createHarness();
	const result = await harness.run("Debug", "test");
	const configuration = harness.debugConfigurations[0];
	assert.equal(result.status, "passed");
	assert.equal(configuration.type, "godot");
	assert.equal(configuration.request, "launch");
	assert.equal(configuration.project, projectPath);
	assert.equal(configuration.editor_path, "mock-godot");
	assert.match(
		configuration.additional_options,
		/"-s"\s+"res:\/\/addons\/gut\/gut_cmdln\.gd"/
	);
	assert.match(configuration.additional_options, /"-gunit_test_name"\s+"test_example_passes"/);
	assert.equal(configuration.additional_options.includes('"-b"'), false);
	assert.equal(harness.addedBreakpoints.length, 1);
	assert.equal(
		harness.addedBreakpoints[0].location.uri.fsPath,
		path.join(projectPath, "addons", "gut", "test.gd")
	);
	assert.equal(
		harness.addedBreakpoints[0].location.range.start.line,
		gutFailureMethodLine - 1
	);
	assert.deepEqual(harness.removedBreakpoints, harness.addedBreakpoints);
	assert.ok(
		harness.outputs.some((output) =>
			output.text.includes("Later assertion failures will not trigger")
		)
	);
	assert.ok(
		harness.outputs.some((output) => output.text.includes("Debug engine output")),
		"Godot Tools output events should stream into the Test Explorer run."
	);
	assert.ok(
		harness.openedDocuments.some(
			(document) => document.uri.fsPath === path.join(projectPath, sampleFile)
		)
	);
	assert.ok(
		harness.openedDocuments.some(
			(document) => document.selection.start.line === 2
		)
	);
});

test("Debug profile can disable the automatic GUT failure breakpoint", async () => {
	const harness = createHarness({ breakOnFailure: false });
	await harness.run("Debug", "test");
	assert.doesNotMatch(harness.debugConfigurations[0].additional_options, /"-b"/);
	assert.equal(harness.addedBreakpoints.length, 0);
});

test("one-shot failure breakpoint resolves the stopped stack when the event omits its source", async () => {
	const harness = createHarness({ debugStopWithoutSource: true });
	await harness.run("Debug", "test");
	assert.equal(harness.removedBreakpoints.length, 1);
	assert.ok(
		harness.outputs.some((output) => output.text.includes("Later assertion failures will not trigger"))
	);
});

test("breakOnEveryFailure keeps the GUT breakpoint active for later failures", async () => {
	const harness = createHarness({ breakOnEveryFailure: true });
	await harness.run("Debug", "test");
	assert.equal(harness.removedBreakpoints.length, 1, "The remaining breakpoint is cleaned up at session end.");
	assert.ok(
		harness.outputs.some((output) => output.text.includes("Later failures will also pause"))
	);
	assert.equal(
		harness.outputs.some((output) => output.text.includes("Later assertion failures will not trigger")),
		false
	);
});

test("Debug profile can disable automatic failure-source navigation", async () => {
	const harness = createHarness({ openFailureLocation: false });
	await harness.run("Debug", "test");
	assert.equal(harness.openedDocuments.length, 0);
});

test("stopOnErrors reports and opens a Godot runtime error frame", async () => {
	const harness = createHarness({ stopOnErrors: true, debugException: true });
	await harness.run("Debug", "test");
	assert.ok(
		harness.outputs.some((output) =>
			output.text.includes("Godot runtime error: Invalid call")
		)
	);
	assert.ok(
		harness.openedDocuments.some(
			(document) => document.uri.fsPath === path.join(projectPath, sampleFile)
		)
	);
});

test("Godot debugger output is linked to its reported script line", async () => {
	const harness = createHarness({ debugOutputSource: true });
	await harness.run("Debug", "test");
	assert.ok(
		harness.outputs.some(
			(output) =>
				output.text.includes("Debug engine output") &&
				output.location?.uri.fsPath === path.join(projectPath, sampleFile) &&
				output.location.range.start.line === 2
		)
	);
});

test("environment references resolve at runtime and are not embedded in debug launchers", async () => {
	const variableName = "GUT_TEST_PROVIDER_SECRET";
	const secret = "local-test-secret";
	const previousValue = process.env[variableName];
	process.env[variableName] = secret;
	try {
		const environment = { GUT_SECRET: `\${env:${variableName}}` };
		const normalHarness = createHarness({ environment });
		await normalHarness.run("Rendered", "test");
		assert.equal(normalHarness.launches[0].options.env.GUT_SECRET, secret);

		const debugHarness = createHarness({ environment });
		await debugHarness.run("Debug", "test");
		const launcher = debugHarness.debugLauncherContents[0];
		assert.ok(launcher.includes("GetEnvironmentVariable"));
		assert.equal(launcher.includes(secret), false);
		assert.equal(launcher.includes(Buffer.from(secret).toString("base64")), false);
	} finally {
		if (previousValue === undefined) {
			delete process.env[variableName];
		} else {
			process.env[variableName] = previousValue;
		}
	}
});

test("missing environment references fail with a clear error", async () => {
	const variableName = "GUT_TEST_PROVIDER_MISSING";
	const previousValue = process.env[variableName];
	delete process.env[variableName];
	try {
		const harness = createHarness({
			environment: { GUT_SECRET: `\${env:${variableName}}` }
		});
		const result = await harness.run("Rendered", "test");
		assert.equal(result.status, "errored");
		assert.ok(
			harness.outputs.some((output) =>
				output.text.includes(`Environment variable "${variableName}"`)
			)
		);
	} finally {
		if (previousValue !== undefined) {
			process.env[variableName] = previousValue;
		}
	}
});

for (const profile of ["Headless", "Rendered"]) {
	for (const selection of ["all", "file", "test"]) {
		test(`${profile} profile runs ${selection} selection`, async () => {
			const harness = createHarness();
			assert.deepEqual(
				harness.profiles.map(({ label, isDefault }) => ({ label, isDefault })),
				[
					{ label: "Continuous", isDefault: false },
					{ label: "Headless", isDefault: true },
					{ label: "Rendered", isDefault: false },
					{ label: "Debug", isDefault: false },
					{ label: "Rerun Failed", isDefault: false },
					{ label: "Repeat Failed", isDefault: false }
				]
			);
			const result = await harness.run(profile, selection);
			assert.equal(harness.launches.length, 1);
			const { args, options } = harness.launches[0];
			assert.equal(options.cwd, projectPath);
			assert.equal(args.includes("--headless"), profile === "Headless");
			if (profile === "Rendered") {
				assert.equal(args[args.indexOf("--rendering-method") + 1], "gl_compatibility");
				assert.equal(args[args.indexOf("--resolution") + 1], "320x240");
				assert.equal(args[args.indexOf("--audio-driver") + 1], "Dummy");
			}
			assert.equal(args.includes("-gconfig="), selection !== "all");
			assert.equal(args.includes(`-gtest=res://${sampleFile}`), selection !== "all");
			assert.equal(args.includes("-gunit_test_name"), selection === "test");
			if (selection === "test") {
				assert.equal(args[args.indexOf("-gunit_test_name") + 1], sampleMethod);
			}
			assert.equal(result.status, profile === "Headless" ? "skipped" : "passed");
			assert.equal(
				harness.outputs.filter((output) => output.text.includes("GUT output line")).length,
				1,
				"Live process output should not be appended a second time after process exit."
			);
			assert.equal(fs.existsSync(args[args.indexOf("-gjunit_xml_file") + 1]), false);
		});
	}
	test(`${profile} profile reports assertion failures`, async () => {
		const harness = createHarness({ failure: true });
		const result = await harness.run(profile, "test");
		assert.equal(result.status, "failed");
		assert.equal(result.message.message, "Example assertion failure");
	});
		test(`${profile} profile points assertion failures at the reported line`, async () => {
			const harness = createHarness({
				failure: true,
				failureText: "Expected 2 but got 3\n\n            at line 48"
			});
			const result = await harness.run(profile, "test");
			assert.equal(result.status, "failed");
			assert.equal(result.message.location.range.start.line, 47);
			assert.equal(result.message.location.uri.fsPath, path.join(projectPath, sampleFile));
			assert.ok(
				harness.outputs.some((output) => output.id === result.id && output.text.startsWith(`FAIL ${sampleFile}:48::`)),
				"The output should name the failing file, line and test."
			);
		});
}
