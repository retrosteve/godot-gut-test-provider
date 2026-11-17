"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const vscode = require("vscode");

const CONTROLLER_ID = "godotGutTests";
const CONTROLLER_LABEL = "GUT";
const GUT_SCRIPT = "res://addons/gut/gut_cmdln.gd";
const OUTPUT_LIMIT = 100000;

function activate(context) {
	const root = findGodotProject();
	if (!root) {
		return;
	}

	function findTestByReference(reference) {
		for (const [id, metadata] of testData) {
			if (
				metadata.kind === "test" &&
				metadata.relativePath === reference.relativePath &&
				metadata.methodName === reference.methodName
			) {
				return findTestItem(id);
			}
		}
		return null;
	}

	const controller = vscode.tests.createTestController(CONTROLLER_ID, CONTROLLER_LABEL);
	const testData = new Map();
	let config = null;
	let watchers = [];
	let lastReproductionReport = null;
	const failedRunState = context.workspaceState.get(
		"godotGutTestProvider.lastFailedRun",
		{ testIds: [], testRefs: [], rendered: false, debugMode: false }
	) ?? { testIds: [], rendered: false, debugMode: false };
	let lastFailedTestIds = Array.isArray(failedRunState.testIds)
		? failedRunState.testIds.filter((id) => typeof id === "string")
		: [];
	let lastFailedTestRefs = Array.isArray(failedRunState.testRefs)
		? failedRunState.testRefs.filter(
				(reference) =>
					reference &&
					typeof reference.relativePath === "string" &&
					typeof reference.methodName === "string"
			)
		: [];
	let lastRunMode = {
		rendered: Boolean(failedRunState.rendered),
		debugMode: Boolean(failedRunState.debugMode)
	};

	controller.createRunProfile(
		"Headless",
		vscode.TestRunProfileKind.Run,
		(request, token) => runTests(request, token, false),
		true
	);
	controller.createRunProfile(
		"Rendered",
		vscode.TestRunProfileKind.Run,
		(request, token) => runTests(request, token, true),
		false
	);
	controller.createRunProfile(
		"Debug",
		vscode.TestRunProfileKind.Debug,
		(request, token) => runTests(request, token, false, true),
		false
	);
	controller.createRunProfile(
		"Rerun Failed",
		vscode.TestRunProfileKind.Run,
		(request, token) => rerunFailedTests(request, token),
		false
	);
	controller.createRunProfile(
		"Repeat Failed",
		vscode.TestRunProfileKind.Run,
		(request, token) => repeatFailedTests(request, token),
		false
	);
	context.subscriptions.push(
		vscode.commands.registerCommand("gutTestProvider.exportReproductionReport", async () => {
			if (!lastReproductionReport) {
				await vscode.window.showInformationMessage(
					"GUT Test Explorer: There is no failed test run to export."
				);
				return;
			}
			const saveUri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(
					path.join(root.uri.fsPath, "gut-test-reproduction.json")
				),
				filters: { "JSON report": ["json"] }
			});
			if (!saveUri) {
				return;
			}
			try {
				fs.writeFileSync(saveUri.fsPath, `${JSON.stringify(lastReproductionReport, null, 2)}\n`);
				await vscode.window.showInformationMessage(
					`GUT Test Explorer: Reproduction report saved to ${saveUri.fsPath}`
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await vscode.window.showErrorMessage(
					`GUT Test Explorer: Could not save the reproduction report: ${message}`
				);
			}
		})
	);

	controller.refreshHandler = async () => refreshTests();
	const debugTrackerFactory = vscode.debug.registerDebugAdapterTrackerFactory("godot", {
		createDebugAdapterTracker(session) {
			const trackerState = debugRunStates.get(session.name);
			if (!trackerState) {
				return undefined;
			}
			return {
				onDidSendMessage(message) {
					if (message.type !== "event") {
						return;
					}
					if (message.event === "output" && typeof message.body?.output === "string") {
						trackerState.onOutput(
							message.body.output,
							debugOutputLocation(message.body, root.uri.fsPath)
						);
					}
					if (message.event === "stopped" && message.body?.reason === "breakpoint") {
						void handleFailureBreakpointStop(session, trackerState, message.body);
					} else if (
						trackerState.stopOnErrors &&
						message.event === "stopped" &&
						message.body?.reason === "exception"
					) {
						void handleEngineErrorStop(session, trackerState, message.body);
					}
				}
			};
		}
	});
	const debugRunStates = new Map();
	context.subscriptions.push(debugTrackerFactory);

	async function refreshTests() {
		try {
			config = loadGutConfig(root.uri.fsPath);
			controller.items.replace([]);
			testData.clear();

			for (const testDirectory of config.directories) {
				if (!isWithin(root.uri.fsPath, testDirectory)) {
					continue;
				}

				for (const filePath of findTestFiles(testDirectory, config)) {
					addTestFile(filePath);
				}
			}
		} catch (error) {
			config = null;
			vscode.window.showErrorMessage(`GUT Test Explorer: ${error.message}`);
		}
	}

	async function handleEngineErrorStop(session, trackerState, body) {
		if (trackerState.checkingEngineError) {
			return;
		}
		trackerState.checkingEngineError = true;
		try {
			const frames = await getStoppedStack(session, body);
			const sourceFrame = findUserFrame(frames, root.uri.fsPath);
			const description = body.text ?? body.description ?? "Godot paused on a runtime error.";
			trackerState.onOutput(`\r\nGodot runtime error: ${description}\r\n`);
			if (sourceFrame) {
				await openDebugSourceFrame(sourceFrame, trackerState);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			trackerState.onOutput(`\r\nCould not inspect the Godot error stack: ${message}\r\n`);
		} finally {
			trackerState.checkingEngineError = false;
		}
	}

	async function getStoppedStack(session, body) {
		let frames = [];
		if (typeof body.threadId === "number") {
			const stack = await session.customRequest("stackTrace", {
				threadId: body.threadId,
				startFrame: 0,
				levels: 100
			});
			frames = stack.stackFrames ?? [];
		}
		if (frames.length === 0 && body.source?.path && typeof body.line === "number") {
			frames = [{ source: body.source, line: body.line }];
		}
		return frames;
	}

	function isFailureBreakpointFrame(frame, breakpoint) {
		const sourcePath = frame.source?.path;
		return (
			typeof sourcePath === "string" &&
			typeof frame.line === "number" &&
			path.resolve(sourcePath).toLowerCase() ===
				path.resolve(breakpoint.location.uri.fsPath).toLowerCase() &&
			frame.line === breakpoint.location.range.start.line + 1
		);
	}

	function findUserFrame(frames, projectPath) {
		for (const frame of frames) {
			const sourcePath = frame.source?.path;
			if (typeof sourcePath !== "string" || typeof frame.line !== "number") {
				continue;
			}
			const resolvedPath = path.resolve(sourcePath);
			if (!isWithin(projectPath, resolvedPath)) {
				continue;
			}
			const relativePath = path.relative(projectPath, resolvedPath).split(path.sep).join("/");
			if (relativePath.startsWith("addons/gut/")) {
				continue;
			}
			return { filePath: resolvedPath, line: frame.line, relativePath };
		}
		return null;
	}

	async function openDebugSourceFrame(frame, trackerState) {
		if (trackerState.openFailureLocation) {
			const uri = vscode.Uri.file(frame.filePath);
			const range = new vscode.Range(frame.line - 1, 0, frame.line - 1, 0);
			const location = new vscode.Location(uri, range);
			trackerState.onOutput(
				`Paused in ${frame.relativePath}:${frame.line}\r\n`,
				location
			);
			const editor = await vscode.window.showTextDocument(uri, { preview: true });
			editor.selection = new vscode.Selection(frame.line - 1, 0, frame.line - 1, 0);
			editor.revealRange(range);
		}
	}

	function debugOutputLocation(body, projectPath) {
		const sourcePath = body.source?.path;
		if (typeof sourcePath !== "string" || typeof body.line !== "number") {
			return undefined;
		}
		const filePath = path.resolve(sourcePath);
		if (!isWithin(projectPath, filePath)) {
			return undefined;
		}
		const line = body.line - 1;
		return new vscode.Location(
			vscode.Uri.file(filePath),
			new vscode.Range(line, 0, line, 0)
		);
	}

	function addTestFile(filePath) {
		const contents = fs.readFileSync(filePath, "utf8");
		const relativePath = path.relative(root.uri.fsPath, filePath).split(path.sep).join("/");
		const uri = vscode.Uri.file(filePath);
		const fileItem = controller.createTestItem(
			`file:${relativePath}`,
			path.basename(filePath),
			uri
		);
		fileItem.canResolveChildren = false;
		testData.set(fileItem.id, { kind: "file", filePath, relativePath });

		const methodPattern = /^[ \t]*func[ \t]+(test_[A-Za-z0-9_]+)[ \t]*\(/gm;
		let match;
		while ((match = methodPattern.exec(contents)) !== null) {
			const methodName = match[1];
			const line = countLines(contents, match.index);
			const testItem = controller.createTestItem(
				`test:${relativePath}:${line}:${methodName}`,
				methodName,
				uri
			);
			testItem.range = new vscode.Range(line, 0, line, 0);
			testData.set(testItem.id, {
				kind: "test",
				filePath,
				relativePath,
				methodName,
				line
			});
			fileItem.children.add(testItem);
		}

		if (fileItem.children.size > 0) {
			controller.items.add(fileItem);
		}
	}

	async function rerunFailedTests(request, token) {
		const failedTests = lastFailedTestRefs.length > 0
			? lastFailedTestRefs.map(findTestByReference).filter((item) => item !== null)
			: lastFailedTestIds.map((id) => findTestItem(id))
			.filter((item) => item !== null);
		await runFailedTests(request, token, failedTests, 1);
	}

	async function repeatFailedTests(request, token) {
		const failedTests = lastFailedTestRefs.length > 0
			? lastFailedTestRefs.map(findTestByReference).filter((item) => item !== null)
			: lastFailedTestIds.map((id) => findTestItem(id))
			.filter((item) => item !== null);
		const repeatCount = vscode.workspace
			.getConfiguration("gutTestProvider", root.uri)
			.get("repeatFailedCount", 3);
		if (!Number.isInteger(repeatCount) || repeatCount < 2 || repeatCount > 20) {
			await vscode.window.showErrorMessage(
				"GUT Test Explorer: gutTestProvider.repeatFailedCount must be an integer from 2 to 20."
			);
			return;
		}
		await runFailedTests(request, token, failedTests, repeatCount);
	}

	async function runFailedTests(request, token, failedTests, repeatCount) {
		if (failedTests.length === 0) {
			const run = controller.createTestRun(request);
			run.appendOutput("No failed GUT tests are available to rerun.\r\n");
			run.end();
			return;
		}
		await runTests(
			{ include: failedTests },
			token,
			lastRunMode.rendered,
			lastRunMode.debugMode,
			repeatCount
		);
	}

	async function handleFailureBreakpointStop(session, trackerState, body) {
		const breakpoint = trackerState.breakpoint;
		if (!breakpoint || trackerState.checkingBreakpointStop) {
			return;
		}
		trackerState.checkingBreakpointStop = true;
		try {
			const frames = await getStoppedStack(session, body);
			const breakpointFrame = frames.find((frame) => isFailureBreakpointFrame(frame, breakpoint));
			if (
				!breakpointFrame
			) {
				return;
			}

			const sourceFrame = findUserFrame(frames, root.uri.fsPath);
			if (trackerState.breakOnEveryFailure) {
				trackerState.onOutput(
					"\r\nPaused at a GUT assertion failure. Later failures will also pause because gutTestProvider.breakOnEveryFailure is enabled.\r\n"
				);
			} else {
				trackerState.breakpoint = null;
				vscode.debug.removeBreakpoints([breakpoint]);
				trackerState.onOutput(
					"\r\nPaused on the first GUT assertion failure. Later assertion failures will not trigger this automatic breakpoint.\r\n"
				);
			}
			if (sourceFrame) {
				await openDebugSourceFrame(sourceFrame, trackerState);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			trackerState.onOutput(
				`\r\nCould not process the stopped GUT failure frame: ${message}\r\n`
			);
		} finally {
			trackerState.checkingBreakpointStop = false;
		}
	}

	function findTestItem(id) {
		for (const file of collectionItems(controller.items)) {
			if (file.id === id) {
				return file;
			}
			for (const test of collectionItems(file.children)) {
				if (test.id === id) {
					return test;
				}
			}
		}
		return null;
	}

	async function runTests(request, token, rendered, debugMode = false, repeatCount = 1) {
		const run = controller.createTestRun(request);
		const cancelled = { value: false };
		let activeProcess = null;
		let activeDebugSession = null;
		let selections = null;
		const failedTestIds = new Set();
		const reportCases = [];
		const runMode = { rendered, debugMode };
		const cancellation = token.onCancellationRequested(() => {
			cancelled.value = true;
			if (activeProcess) {
				activeProcess.kill();
			}
			if (activeDebugSession) {
				void vscode.debug.stopDebugging(activeDebugSession);
			}
		});

		async function invokeSelection(relativePath, methodName) {
			if (debugMode) {
				run.appendOutput(
					"Starting GUT through Godot Tools. Engine output is available in the Debug Console; cancel the test run to stop it.\r\n"
				);
				return invokeGutDebug(
					root.uri.fsPath,
					config,
					relativePath,
					methodName,
					(session) => {
						activeDebugSession = session;
					},
					token,
					(output, location) => {
						observeVersions(output);
						run.appendOutput(escapeOutput(output), location);
					}
				);
			}
			return invokeGut(
				root.uri.fsPath,
				config,
				relativePath,
				methodName,
				rendered,
				(processHandle) => {
					activeProcess = processHandle;
				},
				token,
				(output) => {
					observeVersions(output);
					run.appendOutput(escapeOutput(output));
				}
			);
		}

		const observedVersions = { godot: null, gut: null };
		function observeVersions(output) {
			observedVersions.godot ??=
				/\bGodot Engine v?(\d+\.\d+(?:\.\d+)?)/i.exec(output)?.[1] ?? null;
			observedVersions.gut ??=
				/\bGUT version\s*:\s*([^\s]+)/i.exec(output)?.[1] ?? null;
		}

		try {
			selections = collectSelections(request);
			config ??= loadGutConfig(root.uri.fsPath);
			if (selections.runAll) {
				const files = collectionItems(controller.items).filter(
					(item) => item.children.size > 0
				);
				for (const file of files) {
					for (const test of collectionItems(file.children)) {
						run.started(test);
					}
				}
				const result = await invokeSelection(null, null);
				reportRunResult(
					run,
					result,
					files,
					testData,
					cancelled.value,
					failedTestIds,
					reportCases
				);
				return;
			}

			for (const selection of selections.files) {
				if (cancelled.value) {
					break;
				}
				const fileItem = selection.item;
				const tests = collectionItems(fileItem.children);
				for (const test of tests) {
					run.started(test);
				}
				const result = await invokeSelection(selection.relativePath, null);
				reportRunResult(
					run,
					result,
					[fileItem],
					testData,
					cancelled.value,
					failedTestIds,
					reportCases
				);
			}

			for (const selection of selections.tests) {
				if (cancelled.value) {
					break;
				}
				run.started(selection.item);
				const attemptResults = [];
				for (let attempt = 1; attempt <= repeatCount && !cancelled.value; attempt += 1) {
					if (repeatCount > 1) {
						run.appendOutput(
							`Attempt ${attempt}/${repeatCount}: ${selection.relativePath}::${selection.methodName}\r\n`,
							undefined,
							selection.item
						);
					}
					attemptResults.push(
						await invokeSelection(selection.relativePath, selection.methodName)
					);
				}
				const result = repeatCount > 1
					? combineAttemptResults(attemptResults)
					: attemptResults[0];
				reportRunResult(
					run,
					result,
					[selection.item],
					testData,
					cancelled.value,
					failedTestIds,
					reportCases
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			run.appendOutput(`${message}\r\n`);
			const included = !selections || selections.runAll
				? collectionItems(controller.items)
				: [
						...selections.files.map((selection) => selection.item),
						...selections.tests.map((selection) => selection.item)
					];
			for (const item of included) {
				run.errored(item, new vscode.TestMessage(message));
				for (const child of collectionItems(item.children)) {
					run.errored(child, new vscode.TestMessage(message));
				}
			}
		} finally {
			lastFailedTestIds = [...failedTestIds];
			lastRunMode = runMode;
			lastFailedTestRefs = lastFailedTestIds
				.map((id) => testData.get(id))
				.filter((metadata) => metadata?.kind === "test")
				.map((metadata) => ({
					relativePath: metadata.relativePath,
					methodName: metadata.methodName
				}));
			await context.workspaceState.update("godotGutTestProvider.lastFailedRun", {
				testIds: lastFailedTestIds,
				testRefs: lastFailedTestRefs,
				rendered: runMode.rendered,
				debugMode: runMode.debugMode
			});
			const failures = reportCases.filter(
				(result) => result.status === "failed" || result.status === "errored"
			);
			lastReproductionReport = failures.length > 0
				? {
						formatVersion: 1,
						createdAt: new Date().toISOString(),
						provider: "GUT Test Explorer",
						versions: observedVersions,
						profile: runMode.debugMode
							? "Debug"
							: runMode.rendered
								? "Rendered"
								: "Headless",
						timeoutSeconds: config?.timeoutSeconds ?? null,
						additionalArgumentCount: config?.additionalArguments.length ?? 0,
						environmentVariableNames: Object.keys(config?.environment ?? {}).sort(),
						tests: failures.map((failure) => ({
							...failure,
							commandArguments: reproductionCommandArguments(
								runMode.debugMode
									? "Debug"
									: runMode.rendered
										? "Rendered"
										: "Headless",
								failure
							)
						})),
						debugRequiresGodotTools: runMode.debugMode,
						reproduction:
							"Open the project in VS Code and run the listed test with the recorded profile. The command argument arrays use <project-root> as a placeholder. Provider argument values and environment values are intentionally omitted."
					}
				: null;
			cancellation.dispose();
			run.end();
		}
	}

	function reproductionCommandArguments(profile, test) {
		const profileArguments =
			profile === "Headless"
				? ["--headless"]
				: profile === "Rendered"
					? [
							"--rendering-method",
							"gl_compatibility",
							"--resolution",
							"320x240",
							"--audio-driver",
							"Dummy"
						]
					: [];
		return [
			"godot",
			...profileArguments,
			"--path",
			"<project-root>",
			"-s",
			"res://addons/gut/gut_cmdln.gd",
			"-gconfig=",
			`-gtest=res://${test.path}`,
			"-gunit_test_name",
			test.methodName,
			"-gexit"
		];
	}

	function combineAttemptResults(attemptResults) {
		const resultsByKey = new Map();
		for (let attemptIndex = 0; attemptIndex < attemptResults.length; attemptIndex += 1) {
			const result = attemptResults[attemptIndex];
			for (const testResult of result.testCases) {
				const key = resultKey(testResult.classname, testResult.name);
				const entry = resultsByKey.get(key) ?? {
					sample: testResult,
					attempts: Array(attemptResults.length).fill(null)
				};
				entry.attempts[attemptIndex] = testResult;
				resultsByKey.set(key, entry);
			}
		}

		const testCases = [];
		const errors = attemptResults.map((result) => result.error).filter(Boolean);
		for (const entry of resultsByKey.values()) {
			const completedAttempts = entry.attempts.filter(Boolean);
			const failures = completedAttempts.filter((result) => result.status === "fail");
			const hasMissingResult = completedAttempts.length !== attemptResults.length;
			const status = hasMissingResult
				? "error"
				: failures.length > 0
				? "fail"
				: completedAttempts.every((result) => result.status === "pending")
					? "pending"
					: "pass";
			const outcomeLines = entry.attempts.map(
				(result, index) => `Attempt ${index + 1}: ${result?.status ?? "no result"}`
			);
			testCases.push({
				...entry.sample,
				status,
				duration: completedAttempts.reduce(
					(total, result) => total + (result.duration ?? 0),
					0
				),
				message: `${outcomeLines.join("\n")}\n${failures
					.map((result) => result.message)
					.filter(Boolean)
					.join("\n\n")}`,
				attemptOutcomes: entry.attempts.map((result) => result?.status ?? "missing")
			});
			if (hasMissingResult) {
				errors.push(`GUT did not report a result for ${entry.sample.name} in every attempt.`);
			}
		}
		return {
			testCases,
			error: errors.length > 0 ? [...new Set(errors)].join("\n") : null,
			output: attemptResults.map((result) => result.output).filter(Boolean).join("\n"),
			outputStreamed: attemptResults.every((result) => result.outputStreamed)
		};
	}

	function collectSelections(request) {
		const include = request.include;
		const exclude = request.exclude ?? [];
		if ((!include || include.length === 0) && exclude.length === 0) {
			return { runAll: true, files: [], tests: [] };
		}

		const excludedIds = new Set();
		for (const item of exclude) {
			addDescendantIds(item, excludedIds);
		}

		const files = new Map();
		const tests = new Map();
		const requestedItems =
			include && include.length > 0 ? include : collectionItems(controller.items);
		for (const item of requestedItems) {
			if (excludedIds.has(item.id)) {
				continue;
			}
			const metadata = testData.get(item.id);
			if (!metadata) {
				continue;
			}
			if (metadata.kind === "file") {
				const childTests = collectionItems(item.children).filter(
					(child) => !excludedIds.has(child.id)
				);
				if (childTests.length === item.children.size) {
					files.set(item.id, { item, ...metadata });
				} else {
					for (const child of childTests) {
						const childMetadata = testData.get(child.id);
						if (childMetadata) {
							tests.set(child.id, { item: child, ...childMetadata });
						}
					}
				}
			} else {
				tests.set(item.id, { item, ...metadata });
			}
		}

		for (const [id, selection] of tests) {
			const fileId = `file:${selection.relativePath}`;
			if (files.has(fileId)) {
				tests.delete(id);
			}
		}
		return { runAll: false, files: [...files.values()], tests: [...tests.values()] };
	}

	function addDescendantIds(item, ids) {
		ids.add(item.id);
		for (const child of collectionItems(item.children)) {
			addDescendantIds(child, ids);
		}
	}

	function reportRunResult(
		run,
		result,
		selectedParents,
		metadataById,
		isCancelled,
		failedTestIds,
		reportCases = []
	) {
		const output = truncateOutput(result.output);
		if (output && !result.outputStreamed) {
			run.appendOutput(escapeOutput(output));
		}

		if (isCancelled) {
			for (const parent of selectedParents) {
				if (metadataById.get(parent.id)?.kind === "file") {
					for (const child of collectionItems(parent.children)) {
						run.skipped(child);
					}
				} else {
					run.skipped(parent);
				}
			}
			return;
		}

		const resultsByKey = new Map();
		for (const testResult of result.testCases) {
			const key = resultKey(testResult.classname, testResult.name);
			const list = resultsByKey.get(key) ?? [];
			list.push(testResult);
			resultsByKey.set(key, list);
		}

		for (const parent of selectedParents) {
			const parentMetadata = metadataById.get(parent.id);
			const tests =
				parentMetadata?.kind === "file"
					? collectionItems(parent.children)
					: [parent];
			for (const test of tests) {
				const metadata = metadataById.get(test.id);
				const testResults = metadata
					? resultsByKey.get(resultKey(metadata.relativePath, metadata.methodName))
					: null;
				if (!testResults || testResults.length === 0) {
					reportCases.push({
						path: metadata?.relativePath ?? "",
						methodName: metadata?.methodName ?? test.label,
						status: "errored",
						attempts: []
					});
					run.errored(
						test,
						new vscode.TestMessage(
							result.error ??
								`GUT did not report a result for ${metadata?.methodName ?? test.label}.`
						)
					);
					continue;
				}

				const testResult = testResults.shift();
				if (result.error) {
					reportCases.push({
						path: metadata?.relativePath ?? "",
						methodName: metadata?.methodName ?? test.label,
						status: "errored",
						attempts: testResult.attemptOutcomes ?? [testResult.status]
					});
					run.errored(test, new vscode.TestMessage(result.error));
				} else if (testResult.status === "pending") {
					reportCases.push({
						path: metadata?.relativePath ?? "",
						methodName: metadata?.methodName ?? test.label,
						status: "skipped",
						attempts: testResult.attemptOutcomes ?? [testResult.status]
					});
					if (testResult.message) {
						run.appendOutput(escapeOutput(`${testResult.message}\r\n`), undefined, test);
					}
					run.skipped(test);
				} else if (testResult.status === "fail") {
					const frames = failureFrames(testResult.message, metadata, root.uri.fsPath);
					const location = frames[0] ?? null;
					const message = failureMessage(testResult.message, metadata, root.uri.fsPath);
					reportCases.push({
						path: metadata?.relativePath ?? "",
						methodName: metadata?.methodName ?? test.label,
						status: "failed",
						attempts: testResult.attemptOutcomes ?? [testResult.status],
						flaky:
							testResult.attemptOutcomes?.includes("fail") === true &&
							testResult.attemptOutcomes.includes("pass"),
						failureLocation: location
							? { path: location.relativePath, line: location.line }
							: null
					});
					const parameterCases = [
						...new Set((testResult.message ?? "").match(/params\[\d+\]/g) ?? [])
					];
					const frameOutput = frames
						.map((frame) => `  at ${frame.relativePath}:${frame.line}`)
						.join("\r\n");
					const parameterOutput = parameterCases.length
						? `Parameterized case(s): ${parameterCases.join(", ")}\r\n`
						: "";
					const attemptOutcomes = testResult.attemptOutcomes ?? [];
					const attemptSummary = attemptOutcomes.length > 1
						? `Attempts: ${attemptOutcomes.filter((status) => status === "fail").length} failed, ${attemptOutcomes.filter((status) => status === "pass").length} passed, ${attemptOutcomes.filter((status) => status === "pending").length} skipped\r\n`
						: "";
					run.appendOutput(
						escapeOutput(
							`FAIL ${location?.relativePath ?? metadata?.relativePath ?? ""}${location ? `:${location.line}` : ""}::${metadata?.methodName ?? test.label}\r\n${testResult.message || "(no message reported by GUT)"}\r\n${attemptSummary}${parameterOutput}${frameOutput ? `${frameOutput}\r\n` : ""}`
						),
						location
							? new vscode.Location(
									vscode.Uri.file(location.filePath),
									new vscode.Range(location.line - 1, 0, location.line - 1, 0)
								)
							: undefined,
						test
					);
					failedTestIds.add(test.id);
					run.failed(test, message, testResult.duration);
				} else {
					reportCases.push({
						path: metadata?.relativePath ?? "",
						methodName: metadata?.methodName ?? test.label,
						status: "passed",
						attempts: testResult.attemptOutcomes ?? [testResult.status]
					});
					const durationText =
						testResult.duration === undefined ? "" : ` (${testResult.duration} ms)`;
					run.appendOutput(
						escapeOutput(`PASS ${metadata?.relativePath ?? ""}::${metadata?.methodName ?? test.label}${durationText}\r\n`),
						undefined,
						test
					);
					run.passed(test, testResult.duration);
				}
			}
		}
	}

	function failureFrames(message, metadata, projectPath) {
		const text = message ?? "";
		const frames = [];
		const sourcePattern =
			/(?:^|[\s("'`])((?:res:\/\/|[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])?[^:\r\n]*?\.gd):(\d+)\b/gm;
		let match;
		while ((match = sourcePattern.exec(text)) !== null) {
			const sourcePath = match[1];
			const filePath = sourcePath.startsWith("res://")
				? path.resolve(projectPath, sourcePath.slice(6).replace(/[\\/]/g, path.sep))
				: path.isAbsolute(sourcePath)
					? sourcePath
					: path.resolve(projectPath, sourcePath);
			frames.push({
				line: Number(match[2]),
				filePath,
				relativePath: path.relative(projectPath, filePath).split(path.sep).join("/")
			});
		}
		if (frames.length > 0) {
			return frames;
		}

		const lineMatch = /\bat line (\d+)\b/i.exec(text);
		return lineMatch && metadata
			? [
					{
						line: Number(lineMatch[1]),
						filePath: metadata.filePath,
						relativePath: metadata.relativePath
					}
				]
			: [];
	}

	function failureLocation(message, metadata, projectPath) {
		return failureFrames(message, metadata, projectPath)[0] ?? null;
	}

	function failureMessage(message, metadata, projectPath) {
		const text = message || "GUT reported a failure without a message.";
		const testMessage = new vscode.TestMessage(text);
		const assertionDetails = parseAssertionDetails(text);
		if (assertionDetails) {
			testMessage.expectedOutput = assertionDetails.expected;
			testMessage.actualOutput = assertionDetails.actual;
		}
		const location = failureLocation(message, metadata, projectPath);
		if (location) {
			const line = location.line - 1;
			testMessage.location = new vscode.Location(
				vscode.Uri.file(location.filePath),
				new vscode.Range(line, 0, line, 0)
			);
		}
		return testMessage;
	}

	function parseAssertionDetails(message) {
		const labeled = /^\s*Expected\s*:\s*(.*?)\s*\r?\n\s*Actual\s*:\s*([^\r\n]*)/im.exec(
			message
		);
		if (labeled) {
			return { expected: labeled[1], actual: labeled[2] };
		}
		const got = /\bExpected\s+(.+?)\s+but\s+(?:got|was)\s+(.+?)(?:\r?\n|$)/i.exec(
			message
		);
		return got ? { expected: got[1], actual: got[2] } : null;
	}

	function setWatchers() {
		disposeWatchers();
		const fileWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(root, "**/*.gd")
		);
		fileWatcher.onDidCreate(refreshForTestFile);
		fileWatcher.onDidChange(refreshForTestFile);
		fileWatcher.onDidDelete(refreshForTestFile);

		const configWatcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(root, ".gutconfig.json")
		);
		configWatcher.onDidCreate(onConfigChange);
		configWatcher.onDidChange(onConfigChange);
		watchers = [fileWatcher, configWatcher];
	}

	function disposeWatchers() {
		for (const watcher of watchers) {
			watcher.dispose();
		}
		watchers = [];
	}

	async function onConfigChange() {
		await refreshTests();
		setWatchers();
	}

	async function refreshForTestFile(uri) {
		if (isTestFilePath(uri.fsPath)) {
			await refreshTests();
		}
	}

	function isTestFilePath(filePath) {
		const fileName = path.basename(filePath);
		const prefix = config?.prefix ?? "test_";
		const suffix = config?.suffix ?? ".gd";
		return fileName.startsWith(prefix) && fileName.endsWith(suffix);
	}

	context.subscriptions.push(
		controller,
		{ dispose: disposeWatchers },
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (event.affectsConfiguration("gutTestProvider", root)) {
				await refreshTests();
				setWatchers();
			}
		})
	);

	refreshTests().then(setWatchers);

	async function invokeGut(
		projectPath,
		gutConfig,
		relativePath,
		methodName,
		rendered,
		setProcess,
		token,
		onOutput
	) {
		const godotPath = await resolveGodotPath(root);
		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gut-test-provider-"));
		const reportPath = path.join(temporaryDirectory, "results.xml");
		const args = [
			...(rendered
				? ["--rendering-method", "gl_compatibility", "--resolution", "320x240", "--audio-driver", "Dummy"]
				: ["--headless"]),
			...gutConfig.additionalArguments,
			"--path",
			projectPath,
			"-s",
			GUT_SCRIPT
		];

		if (relativePath) {
			args.push("-gconfig=", `-gtest=res://${relativePath}`);
			if (methodName) {
				args.push("-gunit_test_name", methodName);
			}
		}

		args.push("-gjunit_xml_file", reportPath, "-gexit", "-gdisable_colors");

		try {
			const processResult = await runProcess(
				godotPath,
				args,
				projectPath,
				gutConfig.timeoutSeconds,
				token,
				setProcess,
				onOutput,
				gutConfig.environment
			);
			const testCases = fs.existsSync(reportPath)
				? parseJUnit(fs.readFileSync(reportPath, "utf8"))
				: [];
			const error =
				processResult.timedOut
					? `GUT timed out after ${gutConfig.timeoutSeconds} seconds. Increase gutTestProvider.timeoutSeconds if the suite is slow.`
					: processResult.exitCode !== 0 &&
						  !testCases.some((testCase) => testCase.status === "fail")
						? processResult.output.trim() || `Godot exited with code ${processResult.exitCode}.`
						: null;

			return {
				...processResult,
				testCases,
				error,
				outputStreamed: Boolean(onOutput)
			};
		} finally {
			fs.rmSync(temporaryDirectory, { recursive: true, force: true });
		}
	}

	async function invokeGutDebug(
		projectPath,
		gutConfig,
		relativePath,
		methodName,
		setDebugSession,
		token,
		onOutput
	) {
		const godotPath = await resolveGodotPath(root);
		validateEnvironmentReferences(gutConfig.environment);
		const argumentsList = [...gutConfig.additionalArguments];
		const breakOnFailure = vscode.workspace
			.getConfiguration("gutTestProvider", root.uri)
			.get("breakOnFailure", true);
		const breakOnEveryFailure = vscode.workspace
			.getConfiguration("gutTestProvider", root.uri)
			.get("breakOnEveryFailure", false);
		const openFailureLocation = vscode.workspace
			.getConfiguration("gutTestProvider", root.uri)
			.get("openFailureLocation", true);
		const stopOnErrors = vscode.workspace
			.getConfiguration("gutTestProvider", root.uri)
			.get("stopOnErrors", false);
		const failureBreakpointLocation = breakOnFailure
			? findGutFailureBreakpoint(projectPath)
			: null;
		argumentsList.push("-s", GUT_SCRIPT);

		if (relativePath) {
			argumentsList.push("-gconfig=", `-gtest=res://${relativePath}`);
			if (methodName) {
				argumentsList.push("-gunit_test_name", methodName);
			}
		}

		const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gut-test-provider-debug-"));
		const reportPath = path.join(temporaryDirectory, "results.xml");
		argumentsList.push("-gjunit_xml_file", reportPath, "-gexit", "-gdisable_colors");

		let debugSession = null;
		let debugName = null;
		let breakpoint = null;
		let startListener = null;
		let terminationListener = null;
		let cancellation = null;

		try {
			const launchPath = Object.keys(gutConfig.environment).length > 0
				? createGodotEnvironmentLauncher(temporaryDirectory, godotPath, gutConfig.environment)
				: godotPath;
			debugName = `GUT Debug ${Date.now()}-${Math.random().toString(36).slice(2)}`;
			breakpoint = failureBreakpointLocation
				? createFailureBreakpoint(projectPath, failureBreakpointLocation)
				: null;
			const debugConfiguration = {
				name: debugName,
				type: "godot",
				request: "launch",
				project: projectPath,
				editor_path: launchPath,
				address: "127.0.0.1",
				port: 6007,
				additional_options: argumentsList.map(quoteShellArgument).join(" ")
			};
			debugRunStates.set(debugName, {
				breakpoint,
				breakOnEveryFailure,
				openFailureLocation,
				stopOnErrors,
				checkingBreakpointStop: false,
				checkingEngineError: false,
				onOutput
			});
			if (breakpoint) {
				vscode.debug.addBreakpoints([breakpoint]);
			}
			const terminated = new Promise((resolve) => {
				terminationListener = vscode.debug.onDidTerminateDebugSession((session) => {
					if (session.name === debugName) {
						resolve();
					}
				});
			});

			startListener = vscode.debug.onDidStartDebugSession((session) => {
				if (session.name === debugName) {
					debugSession = session;
					setDebugSession(session);
					if (token.isCancellationRequested) {
						void vscode.debug.stopDebugging(session);
					}
				}
			});
			cancellation = token.onCancellationRequested(() => {
				if (debugSession) {
					void vscode.debug.stopDebugging(debugSession);
				}
			});

			const started = await vscode.debug.startDebugging(root, debugConfiguration);
			if (!started) {
				throw new Error(
					"Could not start the GUT debug session. Install and enable Godot Tools (geequlim.godot-tools)."
				);
			}

			await terminated;

			const testCases = fs.existsSync(reportPath)
				? parseJUnit(fs.readFileSync(reportPath, "utf8"))
				: [];
			const error =
				testCases.length === 0
					? "The Godot debug session ended before GUT wrote a JUnit report."
					: null;

			return {
				exitCode: error ? 1 : 0,
				signal: null,
				output: "",
				timedOut: false,
				testCases,
				error
			};
		} finally {
			startListener?.dispose();
			terminationListener?.dispose();
			cancellation?.dispose();
			const remainingBreakpoint = debugName
				? debugRunStates.get(debugName)?.breakpoint
				: breakpoint;
			if (remainingBreakpoint) {
				vscode.debug.removeBreakpoints([remainingBreakpoint]);
			}
			if (debugName) {
				debugRunStates.delete(debugName);
			}
			setDebugSession(null);
			fs.rmSync(temporaryDirectory, { recursive: true, force: true });
		}
	}

	function createFailureBreakpoint(projectPath, location) {
		const separator = location.lastIndexOf("::");
		const resourcePath = location.slice(0, separator);
		const line = Number(location.slice(separator + 2));
		const filePath = path.resolve(projectPath, resourcePath.slice("res://".length));
		const range = new vscode.Range(line - 1, 0, line - 1, 0);
		return new vscode.SourceBreakpoint(new vscode.Location(vscode.Uri.file(filePath), range));
	}

	function quoteShellArgument(value) {
		const text = String(value);
		return process.platform === "win32"
			? `"${text.replace(/"/g, '\\"')}"`
			: `'${text.replace(/'/g, "'\\''")}'`;
	}

	function createGodotEnvironmentLauncher(directory, godotPath, environment) {
		const encodedGodotPath = Buffer.from(godotPath, "utf8").toString("base64");
		const encodedEnvironment = Buffer.from(JSON.stringify(environment), "utf8").toString("base64");
		if (process.platform === "win32") {
			const powershellPath = path.join(directory, "godot-env.ps1");
			const batchPath = path.join(directory, "godot-env.cmd");
			fs.writeFileSync(
				powershellPath,
				[
					"$ErrorActionPreference = 'Stop'",
					`$executable = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedGodotPath}'))`,
					`$environment = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedEnvironment}')) | ConvertFrom-Json`,
					"foreach ($property in $environment.PSObject.Properties) {",
					"  $value = [regex]::Replace([string]$property.Value, '\\$\\{env:([^}]+)\\}', [System.Text.RegularExpressions.MatchEvaluator]{ param($match) $resolved = [Environment]::GetEnvironmentVariable($match.Groups[1].Value); if ($null -eq $resolved) { throw ('Environment variable ' + $match.Groups[1].Value + ' is not set.') }; return $resolved })",
					"  Set-Item -Path ('Env:' + $property.Name) -Value $value",
					"}",
					"& $executable @args",
					"exit $LASTEXITCODE",
					""
				].join("\r\n"),
				"utf8"
			);
			fs.writeFileSync(
				batchPath,
				[
					"@echo off",
					`powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${powershellPath}" %*`,
					"exit /b %errorlevel%",
					""
				].join("\r\n"),
				"utf8"
			);
			return batchPath;
		}

		const launcherPath = path.join(directory, "godot-env.sh");
		const exports = Object.entries(environment)
			.map(([name, value]) => `export ${name}=${shellEnvironmentExpression(value)}`)
			.join("\n");
		fs.writeFileSync(
			launcherPath,
			`#!/bin/sh\n${exports}\nexec ${quoteShellArgument(godotPath)} "$@"\n`,
			"utf8"
		);
		fs.chmodSync(launcherPath, 0o700);
		return launcherPath;
	}

	function shellEnvironmentExpression(value) {
		const parts = [];
		const placeholder = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
		let cursor = 0;
		let match;
		while ((match = placeholder.exec(value)) !== null) {
			if (match.index > cursor) {
				parts.push(quoteShellArgument(value.slice(cursor, match.index)));
			}
			parts.push(`"$${match[1]}"`);
			cursor = match.index + match[0].length;
		}
		if (cursor < value.length || parts.length === 0) {
			parts.push(quoteShellArgument(value.slice(cursor)));
		}
		return parts.join("");
	}

	function findGutFailureBreakpoint(projectPath) {
		const relativePath = "addons/gut/test.gd";
		const filePath = path.join(projectPath, relativePath);
		if (!fs.existsSync(filePath)) {
			throw new Error(
				`Cannot set a GUT failure breakpoint: ${relativePath} was not found. Disable gutTestProvider.breakOnFailure to run without it.`
			);
		}

		const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
		const methodIndex = lines.findIndex((line) => /^[ \t]*func[ \t]+_fail[ \t]*\(/.test(line));
		if (methodIndex === -1) {
			throw new Error(
				`Cannot set a GUT failure breakpoint: ${relativePath} has no _fail() method. Disable gutTestProvider.breakOnFailure to run without it.`
			);
		}

		const methodIndent = lines[methodIndex].match(/^[ \t]*/)[0].length;
		let firstStatementLine = null;
		let failureCallLine = null;
		for (let index = methodIndex + 1; index < lines.length; index += 1) {
			const line = lines[index];
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) {
				continue;
			}
			if (line.match(/^[ \t]*/)[0].length <= methodIndent) {
				break;
			}
			if (/gut\._fail\s*\(/.test(line)) {
				failureCallLine = index + 1;
			}
			firstStatementLine ??= index + 1;
		}
		if (!failureCallLine || !firstStatementLine) {
			throw new Error(
				`Cannot set a GUT failure breakpoint: ${relativePath}::_fail() does not delegate to GUT's failure handler. This GUT version may be incompatible; disable gutTestProvider.breakOnFailure to continue.`
			);
		}
		return `res://${relativePath}::${firstStatementLine}`;
	}

	async function resolveGodotPath(folder) {
		const configuration = vscode.workspace.getConfiguration("gutTestProvider", folder.uri);
		const gutOverride = vscode.workspace
			.getConfiguration("gut-extension", folder.uri)
			.get("godotOverridePath", "");
		const configuredPath =
			configuration.get("godotPath", "") ||
			gutOverride ||
			process.env.GODOT4 ||
			process.env.GODOT;
		if (configuredPath) {
			return expandEnvironmentVariables(configuredPath);
		}

		try {
			const godotToolsPath = await vscode.commands.executeCommand("godotTools.getGodotPath");
			if (typeof godotToolsPath === "string" && godotToolsPath.length > 0) {
				return godotToolsPath;
			}
		} catch {
			// Fall through to an actionable error when Godot Tools is unavailable.
		}

		throw new Error(
			"Godot executable not configured. Set gutTestProvider.godotPath or gut-extension.godotOverridePath."
		);
	}

	function runProcess(executable, args, cwd, timeoutSeconds, token, setProcess, onOutput, environment) {
		return new Promise((resolve, reject) => {
			const processHandle = childProcess.spawn(executable, args, {
				cwd,
				env: { ...process.env, ...resolveEnvironment(environment) },
				windowsHide: true
			});
			setProcess(processHandle);

			let output = "";
			let streamedCharacters = 0;
			let streamTruncated = false;
			let settled = false;
			const append = (text) => {
				if (!text) {
					return;
				}
				output += text;
				if (output.length > OUTPUT_LIMIT) {
					output = output.slice(-OUTPUT_LIMIT);
				}
				if (onOutput && streamedCharacters < OUTPUT_LIMIT) {
					const available = OUTPUT_LIMIT - streamedCharacters;
					const displayed = text.slice(0, available);
					if (displayed) {
						onOutput(displayed);
						streamedCharacters += displayed.length;
					}
					if (displayed.length < text.length && !streamTruncated) {
						onOutput("\r\n[Further output omitted after 100000 characters.]\r\n");
						streamTruncated = true;
					}
				}
			};
			const stdoutDecoder = new StringDecoder("utf8");
			const stderrDecoder = new StringDecoder("utf8");
			const timeout = setTimeout(() => {
				processHandle.kill();
			}, timeoutSeconds * 1000);
			const cancelSubscription = token.onCancellationRequested(() => {
				processHandle.kill();
			});

			processHandle.stdout.on("data", (chunk) => append(stdoutDecoder.write(chunk)));
			processHandle.stderr.on("data", (chunk) => append(stderrDecoder.write(chunk)));
			processHandle.on("error", (error) => {
				if (!settled) {
					settled = true;
					clearTimeout(timeout);
					cancelSubscription.dispose();
					reject(new Error(`Could not start Godot: ${error.message}`));
				}
			});
			processHandle.on("close", (exitCode, signal) => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timeout);
				cancelSubscription.dispose();
				append(stdoutDecoder.end());
				append(stderrDecoder.end());
				resolve({
					exitCode: typeof exitCode === "number" ? exitCode : 1,
					signal,
					output,
					timedOut: !token.isCancellationRequested && exitCode === null
				});
			});
		});
	}

	function findGodotProject() {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (fs.existsSync(path.join(folder.uri.fsPath, "project.godot"))) {
				return folder;
			}
		}
		return null;
	}

	function collectionItems(collection) {
		const items = [];
		collection.forEach((item) => items.push(item));
		return items;
	}

	function loadGutConfig(projectPath) {
		const configPath = path.join(projectPath, ".gutconfig.json");
		let parsed = {};
		if (fs.existsSync(configPath)) {
			parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
		}
		const directories = (parsed.dirs ?? ["res://tests"]).map((entry) =>
			resolveProjectPath(projectPath, entry)
		);
		const providerConfiguration = vscode.workspace.getConfiguration(
			"gutTestProvider",
			root.uri
		);
		return {
			directories,
			includeSubdirs: parsed.include_subdirs ?? false,
			prefix: parsed.prefix ?? "test_",
			suffix: parsed.suffix ?? ".gd",
			timeoutSeconds: providerConfiguration.get("timeoutSeconds", 120),
			additionalArguments: readAdditionalArguments(providerConfiguration),
			environment: readEnvironment(providerConfiguration)
		};
	}

	function readAdditionalArguments(providerConfiguration) {
		const value = providerConfiguration.get("additionalArguments", []);
		if (
			!Array.isArray(value) ||
			value.some((argument) => typeof argument !== "string" || argument.trim().length === 0)
		) {
			throw new Error("gutTestProvider.additionalArguments must be an array of strings.");
		}
		const reservedArguments = [
			"-s",
			"--script",
			"--path",
			"--headless",
			"--rendering-method",
			"--resolution",
			"--audio-driver",
			"--remote-debug",
			"--breakpoints",
			"-b",
			"-gconfig",
			"-gtest",
			"-gunit_test_name",
			"-gjunit_xml_file",
			"-gexit"
		];
		for (const argument of value) {
			const flag = argument.split("=")[0];
			if (reservedArguments.includes(flag)) {
				throw new Error(
					`gutTestProvider.additionalArguments cannot override the provider-managed argument "${flag}".`
				);
			}
		}
		return value;
	}

	function readEnvironment(providerConfiguration) {
		const value = providerConfiguration.get("environment", {});
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("gutTestProvider.environment must be an object of string values.");
		}
		const environment = {};
		for (const [name, entry] of Object.entries(value)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof entry !== "string") {
				throw new Error(
					"gutTestProvider.environment keys must be valid environment variable names with string values."
				);
			}
			environment[name] = entry;
		}
		return environment;
	}

	function resolveEnvironment(environment) {
		const resolved = {};
		for (const [name, value] of Object.entries(environment)) {
			resolved[name] = expandEnvironmentVariables(value, true);
		}
		return resolved;
	}

	function validateEnvironmentReferences(environment) {
		for (const value of Object.values(environment)) {
			expandEnvironmentVariables(value, true);
		}
	}

	function resolveProjectPath(projectPath, value) {
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`Invalid GUT test directory: ${String(value)}`);
		}
		const relative = value.startsWith("res://") ? value.slice(6) : value;
		return path.resolve(projectPath, relative.replace(/[\\/]/g, path.sep));
	}

	function findTestFiles(directory, gutConfig) {
		if (!fs.existsSync(directory)) {
			return [];
		}
		const results = [];
		const walk = (currentDirectory) => {
			for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
				const entryPath = path.join(currentDirectory, entry.name);
				if (entry.isDirectory()) {
					if (gutConfig.includeSubdirs) {
						walk(entryPath);
					}
				} else if (
					entry.isFile() &&
					entry.name.startsWith(gutConfig.prefix) &&
					entry.name.endsWith(gutConfig.suffix)
				) {
					results.push(entryPath);
				}
			}
		};
		walk(directory);
		return results;
	}

	function isWithin(parent, candidate) {
		const relative = path.relative(parent, candidate);
		return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
	}

	function countLines(text, endIndex) {
		let lines = 0;
		for (let index = 0; index < endIndex; index += 1) {
			if (text.charCodeAt(index) === 10) {
				lines += 1;
			}
		}
		return lines;
	}

	function parseJUnit(xml) {
		const results = [];
		const testcasePattern = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
		let match;
		while ((match = testcasePattern.exec(xml)) !== null) {
			const attributes = match[1];
			const content = match[2];
			const name = readAttribute(attributes, "name");
			const classname = readAttribute(attributes, "classname");
			const status = readAttribute(attributes, "status");
			const time = Number(readAttribute(attributes, "time") ?? 0);
			const failure = content.match(/<failure\b[^>]*>([\s\S]*?)<\/failure>/);
			const skipped = content.match(/<skipped\b[^>]*>([\s\S]*?)<\/skipped>/);
			results.push({
				name,
				classname,
				status: failure ? "fail" : skipped ? "pending" : status ?? "pass",
				message: failure
					? decodeXml(unwrapCdata(failure[1]))
					: skipped
						? decodeXml(unwrapCdata(skipped[1]))
						: "",
				duration: Number.isFinite(time) ? Math.round(time * 1000) : undefined
			});
		}
		return results;
	}

	function resultKey(classname, name) {
		return `${classname}::${name}`;
	}

	function readAttribute(attributes, name) {
		const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = attributes.match(new RegExp(`\\b${escapedName}="([^"]*)"`));
		return match ? decodeXml(match[1]) : null;
	}

	function unwrapCdata(value) {
		return value.replace(/^<!\[CDATA\[|\]\]>$/g, "");
	}

	function decodeXml(value) {
		return value
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&amp;/g, "&");
	}

	function expandEnvironmentVariables(value, failWhenMissing = false) {
		return value.replace(/\$\{env:([^}]+)\}/g, (match, variable) => {
			const environmentValue = process.env[variable];
			if (environmentValue === undefined && failWhenMissing) {
				throw new Error(
					`Environment variable "${variable}" referenced by gutTestProvider.environment is not set.`
				);
			}
			return environmentValue ?? "";
		});
	}

	function truncateOutput(output) {
		return output.length > OUTPUT_LIMIT
			? `[Earlier output omitted]\r\n${output.slice(-OUTPUT_LIMIT)}`
			: output;
	}

	function escapeOutput(output) {
		return output.replace(/\r?\n/g, "\r\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
	}
}

function deactivate() {}

module.exports = { activate, deactivate };
