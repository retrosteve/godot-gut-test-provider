"use strict";

const childProcess = require("node:child_process");
const crypto = require("node:crypto");
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
	const roots = findGodotProjects();
	if (roots.length === 0) {
		return;
	}
	const reproductionReports = new Map();
	context.subscriptions.push(
		vscode.commands.registerCommand("gutTestProvider.exportReproductionReport", async () => {
			const availableReports = [...reproductionReports.values()];
			if (availableReports.length === 0) {
				await vscode.window.showInformationMessage(
					"GUT Test Explorer: There is no failed test run to export."
				);
				return;
			}
			let selectedReport = availableReports[0];
			if (availableReports.length > 1) {
				const choice = await vscode.window.showQuickPick(
					availableReports.map((entry) => ({
						label: path.basename(entry.rootPath),
						description: entry.rootPath,
						entry
					})),
					{ placeHolder: "Choose the Godot project failure report to export" }
				);
				selectedReport = choice?.entry;
				if (!selectedReport) {
					return;
				}
			}
			const saveUri = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(
					path.join(selectedReport.rootPath, "gut-test-reproduction.json")
				),
				filters: { "JSON report": ["json"] }
			});
			if (!saveUri) {
				return;
			}
			try {
				fs.writeFileSync(
					saveUri.fsPath,
					`${JSON.stringify(selectedReport.report, null, 2)}\n`
				);
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
	for (const root of roots) {
		activateProject(context, root, roots.length, reproductionReports);
	}
}

function activateProject(context, root, projectCount, reproductionReports) {
	function findTestByReference(reference) {
		for (const [id, metadata] of testData) {
			if (
				metadata.kind === "test" &&
				metadata.relativePath === reference.relativePath &&
				(metadata.innerClassName ?? "") === (reference.innerClassName ?? "") &&
				metadata.methodName === reference.methodName
			) {
				return findTestItem(id);
			}
		}
		return null;
	}

	const rootPath = path.resolve(root.uri.fsPath);
	const rootHash = crypto.createHash("sha256").update(rootPath).digest("hex").slice(0, 12);
	const controller = vscode.tests.createTestController(
		`${CONTROLLER_ID}.${rootHash}`,
		projectCount > 1
			? `${CONTROLLER_LABEL} - ${path.basename(rootPath)}`
			: CONTROLLER_LABEL
	);
	const testData = new Map();
	let config = null;
	let watchers = [];
	let lastReproductionReport = null;
	let pendingContinuousChange = null;
	let continuousRunActive = false;
	let continuousChangePending = false;
	let activeContinuousRunCancel = null;
	const projectStateKey = `godotGutTestProvider.lastFailedRun.${rootHash}`;
	const defaultFailedRunState = { testIds: [], testRefs: [], rendered: false, debugMode: false };
	const failedRunState = context.workspaceState.get(
		projectStateKey,
		projectCount === 1
			? context.workspaceState.get("godotGutTestProvider.lastFailedRun", defaultFailedRunState)
			: defaultFailedRunState
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

	const continuousProfile = controller.createRunProfile(
		"Continuous",
		vscode.TestRunProfileKind.Run,
		(request, token) => runTests(request, token, false),
		false
	);
	continuousProfile.supportsContinuousRun = true;
	configureRunProfile(continuousProfile);
	const headlessProfile = controller.createRunProfile(
		"Headless",
		vscode.TestRunProfileKind.Run,
		(request, token) => runTests(request, token, false),
		true
	);
	configureRunProfile(headlessProfile);
	const renderedProfile = controller.createRunProfile(
		"Rendered",
		vscode.TestRunProfileKind.Run,
		(request, token) => runTests(request, token, true),
		false
	);
	configureRunProfile(renderedProfile);
	const debugProfile = controller.createRunProfile(
		"Debug",
		vscode.TestRunProfileKind.Debug,
		(request, token) => runTests(request, token, false, true),
		false
	);
	configureRunProfile(debugProfile);
	const rerunProfile = controller.createRunProfile(
		"Rerun Failed",
		vscode.TestRunProfileKind.Run,
		(request, token) => rerunFailedTests(request, token),
		false
	);
	configureRunProfile(rerunProfile);
	const repeatProfile = controller.createRunProfile(
		"Repeat Failed",
		vscode.TestRunProfileKind.Run,
		(request, token) => repeatFailedTests(request, token),
		false
	);
	configureRunProfile(repeatProfile);

	function configureRunProfile(profile) {
		profile.configureHandler = () =>
			vscode.commands.executeCommand(
				"workbench.action.openSettings",
				"@ext:retrosteve.godot-gut-test-provider"
			);
	}
	controller.refreshHandler = async () => refreshTests();
	controller.resolveHandler = async (item) => {
		if (!item) {
			await refreshTests();
			return;
		}
		await resolveTestFile(item);
	};
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
			const discoveredFiles = new Set();
			for (const testDirectory of config.directories) {
				if (!isWithin(root.uri.fsPath, testDirectory)) {
					continue;
				}
				for (const filePath of findTestFiles(testDirectory, config)) {
					const resolvedPath = path.resolve(filePath);
					discoveredFiles.add(resolvedPath);
					const relativePath = path.relative(root.uri.fsPath, resolvedPath)
						.split(path.sep)
						.join("/");
					const fileItem = controller.items.get(`file:${relativePath}`);
					if (!fileItem) {
						addTestFile(resolvedPath);
					} else {
						const metadata = testData.get(fileItem.id);
						if (metadata?.signature !== fileSignature(resolvedPath)) {
							await resolveTestFile(fileItem, true);
						}
					}
				}
			}
			for (const fileItem of collectionItems(controller.items)) {
				const metadata = testData.get(fileItem.id);
				if (metadata && !discoveredFiles.has(path.resolve(metadata.filePath))) {
					removeTestFile(fileItem);
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
		const relativePath = path.relative(root.uri.fsPath, filePath).split(path.sep).join("/");
		const uri = vscode.Uri.file(filePath);
		const fileItem = controller.createTestItem(
			`file:${relativePath}`,
			path.basename(filePath),
			uri
		);
		fileItem.canResolveChildren = true;
		testData.set(fileItem.id, {
			kind: "file",
			filePath,
			relativePath,
			discovered: false,
			signature: fileSignature(filePath)
		});
		controller.items.add(fileItem);
		return fileItem;
	}

	async function resolveTestFile(fileItem, force = false) {
		const fileMetadata = testData.get(fileItem.id);
		if (fileMetadata?.kind !== "file" || (fileMetadata.discovered && !force)) {
			return;
		}
		const document = vscode.workspace.textDocuments?.find(
			(openDocument) => openDocument.uri.fsPath === fileMetadata.filePath
		);
		const contents = document?.getText() ?? fs.readFileSync(fileMetadata.filePath, "utf8");
		const previousItems = new Map(
			collectionItems(fileItem.children).map((child) => [child.id, child])
		);
		const currentItems = [];
		const currentIds = new Set();
		const uri = vscode.Uri.file(fileMetadata.filePath);
		const lines = contents.split(/\r?\n/);
		const classPattern = /^([ \t]*)class[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*:/;
		const methodPattern = /^[ \t]*func[ \t]+(test_[A-Za-z0-9_]+)[ \t]*\(/;
		const innerClasses = [];
		const rootMethods = [];
		for (let index = 0; index < lines.length; index += 1) {
			const match = classPattern.exec(lines[index]);
			if (match) {
				const classIndent = match[1].length;
				let end = index + 1;
				while (end < lines.length) {
					const candidate = lines[end];
					if (
						candidate.trim().length > 0 &&
						!candidate.trimStart().startsWith("#") &&
						indentation(candidate) <= classIndent
					) {
						break;
					}
					end += 1;
				}
				const classBody = lines.slice(index + 1, end);
				if (
					match[2].startsWith(config.innerClassPrefix) &&
					classBody.some((line) =>
						/^[ \t]+extends[ \t]+(?:GutTest(?:[ \t]|$)|["']res:\/\/addons\/gut\/test\.gd["'](?:[ \t]|$))/.test(
							line
						)
					)
				) {
					innerClasses.push({
						name: match[2],
						line: index,
						indent: classIndent,
						lines: classBody
					});
				}
				index = end - 1;
				continue;
			}
			const methodMatch = methodPattern.exec(lines[index]);
			if (methodMatch && indentation(lines[index]) === 0) {
				rootMethods.push({ name: methodMatch[1], line: index });
			}
		}

		for (const method of rootMethods) {
			currentItems.push(
				createTestItem(fileMetadata, method.name, method.line, "", uri, previousItems, currentIds)
			);
		}
		for (const innerClass of innerClasses) {
			const suiteId = `suite:${fileMetadata.relativePath}:${innerClass.name}`;
			const suiteItem = previousItems.get(suiteId) ??
				controller.createTestItem(suiteId, innerClass.name, uri);
			suiteItem.range = new vscode.Range(innerClass.line, 0, innerClass.line, 0);
			suiteItem.canResolveChildren = false;
			const previousSuiteChildren = new Map(
				collectionItems(suiteItem.children).map((child) => [child.id, child])
			);
			const classTestIds = new Set();
			const classMethods = [];
			for (let index = 0; index < innerClass.lines.length; index += 1) {
				const methodMatch = methodPattern.exec(innerClass.lines[index]);
				if (methodMatch && indentation(innerClass.lines[index]) > innerClass.indent) {
					classMethods.push({
						name: methodMatch[1],
						line: innerClass.line + 1 + index
					});
				}
			}
			const suiteTests = classMethods.map((method) =>
				createTestItem(
					fileMetadata,
					method.name,
					method.line,
					innerClass.name,
					uri,
					previousSuiteChildren,
					classTestIds
				)
			);
			for (const previousChild of previousSuiteChildren.values()) {
				if (!classTestIds.has(previousChild.id)) {
					testData.delete(previousChild.id);
				}
			}
			suiteItem.children.replace(suiteTests);
			if (!currentIds.has(suiteId)) {
				currentIds.add(suiteId);
			}
			testData.set(suiteId, {
				kind: "suite",
				filePath: fileMetadata.filePath,
				relativePath: fileMetadata.relativePath,
				innerClassName: innerClass.name,
				line: innerClass.line
			});
			currentItems.push(suiteItem);
		}
		for (const previousItem of previousItems.values()) {
			if (
				previousItem.id.startsWith(`suite:${fileMetadata.relativePath}:`) &&
				!currentIds.has(previousItem.id)
			) {
				for (const child of collectionItems(previousItem.children)) {
					testData.delete(child.id);
				}
			}
			if (!currentIds.has(previousItem.id)) {
				testData.delete(previousItem.id);
			}
		}
		fileItem.children.replace(currentItems);
		fileMetadata.discovered = true;
		fileMetadata.signature = fileSignature(fileMetadata.filePath);
	}

	function createTestItem(
		fileMetadata,
		methodName,
		line,
		innerClassName,
		uri,
		previousItems,
		currentIds
	) {
		const classKey = innerClassName ? `${innerClassName}:` : "";
		const testId = `test:${fileMetadata.relativePath}:${classKey}${methodName}`;
		const testItem = previousItems.get(testId) ??
			controller.createTestItem(testId, methodName, uri);
		testItem.range = new vscode.Range(line, 0, line, 0);
		currentIds.add(testId);
		testData.set(testId, {
			kind: "test",
			filePath: fileMetadata.filePath,
			relativePath: fileMetadata.relativePath,
			innerClassName,
			methodName,
			line
		});
		return testItem;
	}

	function indentation(line) {
		return line.match(/^[ \t]*/)[0].length;
	}

	function removeTestFile(fileItem) {
		deleteTestTree(fileItem);
		controller.items.delete(fileItem.id);
	}

	function deleteTestTree(item) {
		for (const child of collectionItems(item.children)) {
			deleteTestTree(child);
		}
		testData.delete(item.id);
	}

	async function rerunFailedTests(request, token) {
		const failedTests = await resolveFailedTestItems();
		await runFailedTests(request, token, failedTests, 1);
	}

	async function repeatFailedTests(request, token) {
		const failedTests = await resolveFailedTestItems();
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

	async function resolveFailedTestItems() {
		if (lastFailedTestRefs.length === 0) {
			return lastFailedTestIds
				.map((id) => findTestItem(id))
				.filter((item) => item !== null);
		}
		await refreshTests();
		for (const reference of lastFailedTestRefs) {
			const fileItem = controller.items.get(`file:${reference.relativePath}`);
			if (fileItem) {
				await resolveTestFile(fileItem);
			}
		}
		return lastFailedTestRefs
			.map(findTestByReference)
			.filter((item) => item !== null);
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
			const pending = collectionItems(file.children);
			while (pending.length > 0) {
				const item = pending.pop();
				if (item.id === id) {
					return item;
				}
				pending.push(...collectionItems(item.children));
			}
		}
		return null;
	}

	async function runTests(request, token, rendered, debugMode = false, repeatCount = 1) {
		if (!request.continuous) {
			await runTestsOnce(request, token, rendered, debugMode, repeatCount);
			return;
		}
		continuousRunActive = true;
		try {
			while (!token.isCancellationRequested) {
				await runTestsOnce(request, token, rendered, debugMode, repeatCount);
				if (token.isCancellationRequested) {
					break;
				}
				const changed = await waitForContinuousChange(token);
				if (!changed) {
					break;
				}
			}
		} finally {
			continuousRunActive = false;
			continuousChangePending = false;
		}
	}

	async function waitForContinuousChange(token) {
		if (token.isCancellationRequested) {
			return false;
		}
		return new Promise((resolve) => {
			let timer = null;
			let cancellation = null;
			const finish = (changed) => {
				clearTimeout(timer);
				if (pendingContinuousChange === onChange) {
					pendingContinuousChange = null;
				}
				cancellation?.dispose();
				resolve(changed);
			};
			const onChange = () => {
				clearTimeout(timer);
				timer = setTimeout(() => {
					continuousChangePending = false;
					finish(true);
				}, 350);
			};
			pendingContinuousChange = onChange;
			cancellation = token.onCancellationRequested(() => finish(false));
			if (continuousChangePending) {
				onChange();
			}
		});
	}

	function notifyContinuousChange() {
		if (!continuousRunActive) {
			return;
		}
		continuousChangePending = true;
		activeContinuousRunCancel?.();
		pendingContinuousChange?.();
	}

	async function runTestsOnce(request, token, rendered, debugMode = false, repeatCount = 1) {
		const run = controller.createTestRun(request);
		const cancelled = { value: false };
		let activeProcess = null;
		let activeDebugSession = null;
		let cancelActiveRunForChange = null;
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
		if (continuousRunActive) {
			cancelActiveRunForChange = () => {
				if (cancelled.value) {
					return;
				}
				cancelled.value = true;
				activeProcess?.kill();
				if (activeDebugSession) {
					void vscode.debug.stopDebugging(activeDebugSession);
				}
			};
			activeContinuousRunCancel = cancelActiveRunForChange;
		}

		function isRequested(item) {
			if (!request.include?.length) {
				return true;
			}
			for (let node = item; node; node = node.parent) {
				if (request.include.includes(node)) {
					return true;
				}
			}
			return false;
		}

		function findRequestedTest(relativePath, methodName) {
			for (const fileItem of collectionItems(controller.items)) {
				for (const test of descendantTests(fileItem)) {
					const metadata = testData.get(test.id);
					if (metadata?.relativePath === relativePath && metadata.methodName === methodName) {
						return isRequested(test) ? test : null;
					}
				}
			}
			return null;
		}

		// Marks tests as started and provisionally passed or failed while GUT is still running.
		// The final results.xml report still sets the definitive state and messages.
		function createLiveTestReporter() {
			let buffer = "";
			let currentPath = null;
			let currentTest = null;
			let currentStatus = null;

			function finishCurrent() {
				currentTest = null;
				currentStatus = null;
			}

			function passCurrent() {
				if (currentTest && currentStatus === null) {
					currentStatus = "pass";
					run.passed(currentTest);
				}
			}

			function handleLine(line) {
				const fileMatch = /^res:\/\/(\S+\.gd)\s*$/.exec(line);
				if (fileMatch) {
					passCurrent();
					finishCurrent();
					currentPath = fileMatch[1];
					return;
				}
				const testMatch = /^\* (\S+)\s*$/.exec(line);
				if (testMatch) {
					passCurrent();
					finishCurrent();
					currentTest = currentPath ? findRequestedTest(currentPath, testMatch[1]) : null;
					if (currentTest) {
						run.started(currentTest);
					}
					return;
				}
				if (/^\d+\/\d+ passed\.\s*$/.test(line)) {
					passCurrent();
					finishCurrent();
					return;
				}
				if (/^(=|-{3,}\s*$|Totals|Scripts\b)/.test(line)) {
					finishCurrent();
					return;
				}
				const resultMatch = /^\s+\[(Passed|Failed)\]/.exec(line);
				if (resultMatch && currentTest) {
					if (resultMatch[1] === "Failed" && currentStatus !== "fail") {
						currentStatus = "fail";
						run.failed(currentTest, new vscode.TestMessage("Failed. Final details follow when the run ends."));
					} else if (resultMatch[1] === "Passed" && currentStatus === null) {
						currentStatus = "pass";
						run.passed(currentTest);
					}
				}
			}

			return {
				onOutput(text) {
					buffer += text;
					let newline = buffer.indexOf("\n");
					while (newline >= 0) {
						handleLine(buffer.slice(0, newline).replace(/\r$/, ""));
						buffer = buffer.slice(newline + 1);
						newline = buffer.indexOf("\n");
					}
				},
				flush() {
					if (buffer) {
						handleLine(buffer.replace(/\r$/, ""));
						buffer = "";
					}
					finishCurrent();
				}
			};
		}

		async function invokeSelection(relativePath, methodName, innerClassName = "") {
			const liveReporter = createLiveTestReporter();
			if (debugMode) {
				run.appendOutput(
					"Starting GUT through Godot Tools. Engine output is available in the Debug Console; cancel the test run to stop it.\r\n"
				);
				return invokeGutDebug(
					root.uri.fsPath,
					config,
					relativePath,
					methodName,
					innerClassName,
					(session) => {
						activeDebugSession = session;
					},
					token,
					(output, location) => {
						observeVersions(output);
						run.appendOutput(escapeOutput(output), location);
						liveReporter.onOutput(output);
					}
				).finally(() => liveReporter.flush());
			}
			const result = await invokeGut(
				root.uri.fsPath,
				config,
				relativePath,
				methodName,
				innerClassName,
				rendered,
				(processHandle) => {
					activeProcess = processHandle;
				},
				token,
				(output) => {
					observeVersions(output);
					run.appendOutput(escapeOutput(output));
				},
				(output) => liveReporter.onOutput(output)
			);
			liveReporter.flush();
			return result;
		}

		const observedVersions = { godot: null, gut: null };
		function observeVersions(output) {
			observedVersions.godot ??=
				/\bGodot Engine v?(\d+\.\d+(?:\.\d+)?)/i.exec(output)?.[1] ?? null;
			observedVersions.gut ??=
				/\bGUT version\s*:\s*([^\s]+)/i.exec(output)?.[1] ?? null;
		}

		try {
			config ??= loadGutConfig(root.uri.fsPath);
			await refreshTests();
			const filesToResolve = new Set();
			const requestedItems = request.include?.length
				? request.include
				: collectionItems(controller.items);
			for (const item of requestedItems) {
				const metadata = testData.get(item.id);
				const filePath = metadata?.filePath ?? item.uri?.fsPath;
				if (filePath && isWithin(root.uri.fsPath, filePath)) {
					const relativePath = path.relative(root.uri.fsPath, filePath)
						.split(path.sep)
						.join("/");
					const fileItem = controller.items.get(`file:${relativePath}`);
					if (fileItem) {
						filesToResolve.add(fileItem);
					}
				}
			}
			for (const fileItem of filesToResolve) {
				await resolveTestFile(fileItem);
			}
			selections = collectSelections(request);
			if (selections.runAll) {
				const files = collectionItems(controller.items).filter(
					(item) => descendantTests(item).length > 0
				);
				for (const file of files) {
					for (const test of descendantTests(file)) {
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
				const tests = descendantTests(fileItem);
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

			for (const selection of selections.suites) {
				if (cancelled.value) {
					break;
				}
				for (const test of descendantTests(selection.item)) {
					run.started(test);
				}
				const result = await invokeSelection(
					selection.relativePath,
					null,
					selection.innerClassName
				);
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

			for (const selection of selections.tests) {
				if (cancelled.value) {
					break;
				}
				run.started(selection.item);
				const attemptResults = [];
				for (let attempt = 1; attempt <= repeatCount && !cancelled.value; attempt += 1) {
					if (repeatCount > 1) {
						run.appendOutput(
							`Attempt ${attempt}/${repeatCount}: ${selection.relativePath}${selection.innerClassName ? `.${selection.innerClassName}` : ""}::${selection.methodName}\r\n`,
							undefined,
							selection.item
						);
					}
					attemptResults.push(
						await invokeSelection(
							selection.relativePath,
							selection.methodName,
							selection.innerClassName
						)
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
						...selections.suites.map((selection) => selection.item),
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
					methodName: metadata.methodName,
					innerClassName: metadata.innerClassName ?? ""
				}));
			await context.workspaceState.update(projectStateKey, {
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
			if (lastReproductionReport) {
				reproductionReports.set(rootHash, {
					rootPath: root.uri.fsPath,
					report: lastReproductionReport
				});
			} else {
				reproductionReports.delete(rootHash);
			}
			cancellation.dispose();
			if (activeContinuousRunCancel === cancelActiveRunForChange) {
				activeContinuousRunCancel = null;
			}
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
		const argumentsList = [
			"godot",
			...profileArguments,
			"--path",
			"<project-root>",
			"-s",
			"res://addons/gut/gut_cmdln.gd",
			"-gconfig=",
			`-gtest=res://${test.path}`,
		];
		if (test.innerClassName) {
			argumentsList.push("-ginner_class", test.innerClassName);
		}
		argumentsList.push("-gunit_test_name", test.methodName, "-gexit");
		return argumentsList;
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
			return { runAll: true, files: [], suites: [], tests: [] };
		}

		const excludedIds = new Set();
		for (const item of exclude) {
			addDescendantIds(item, excludedIds);
		}

		const files = new Map();
		const suites = new Map();
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
				const allTests = descendantTests(item);
				const selectedTests = allTests.filter((child) => !excludedIds.has(child.id));
				if (selectedTests.length === allTests.length) {
					files.set(item.id, { item, ...metadata });
				} else {
					for (const child of selectedTests) {
						addSelectedTest(child, tests);
					}
				}
			} else if (metadata.kind === "suite") {
				const allTests = descendantTests(item);
				const selectedTests = allTests.filter((child) => !excludedIds.has(child.id));
				if (selectedTests.length === allTests.length) {
					suites.set(item.id, { item, ...metadata });
				} else {
					for (const child of selectedTests) {
						addSelectedTest(child, tests);
					}
				}
			} else {
				addSelectedTest(item, tests);
			}
		}

		for (const [id, selection] of suites) {
			if (files.has(`file:${selection.relativePath}`)) {
				suites.delete(id);
			}
		}
		for (const [id, selection] of tests) {
			const fileId = `file:${selection.relativePath}`;
			if (
				files.has(fileId) ||
				[...suites.values()].some(
					(suite) =>
						suite.relativePath === selection.relativePath &&
						suite.innerClassName === selection.innerClassName
				)
			) {
				tests.delete(id);
			}
		}
		return {
			runAll: false,
			files: [...files.values()],
			suites: [...suites.values()],
			tests: [...tests.values()]
		};
	}

	function addSelectedTest(item, tests) {
		const metadata = testData.get(item.id);
		if (metadata?.kind === "test") {
			tests.set(item.id, { item, ...metadata });
		}
	}

	function descendantTests(item) {
		const tests = [];
		for (const child of collectionItems(item.children)) {
			if (testData.get(child.id)?.kind === "test") {
				tests.push(child);
			} else {
				tests.push(...descendantTests(child));
			}
		}
		return tests;
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
				const metadata = metadataById.get(parent.id);
				const tests =
					metadata?.kind === "file" || metadata?.kind === "suite"
						? descendantTests(parent)
						: [parent];
				for (const test of tests) {
					run.skipped(test);
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
				parentMetadata?.kind === "file" || parentMetadata?.kind === "suite"
					? descendantTests(parent)
					: [parent];
			for (const test of tests) {
				const metadata = metadataById.get(test.id);
				const testResults = metadata
					? resultsByKey.get(resultKey(testClassName(metadata), metadata.methodName))
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
						makeRunErrorMessage(
							result.error ??
								`GUT did not report a result for ${metadata?.methodName ?? test.label}.`,
							metadata
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
					run.errored(test, makeRunErrorMessage(result.error, metadata));
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

	function testClassName(metadata) {
		return `res://${metadata.relativePath}${
			metadata.innerClassName ? `.${metadata.innerClassName}` : ""
		}`;
	}

	function makeRunErrorMessage(message, metadata) {
		const testMessage = new vscode.TestMessage(message);
		const location = failureLocation(message, metadata, root.uri.fsPath);
		if (location) {
			testMessage.location = new vscode.Location(
				vscode.Uri.file(location.filePath),
				new vscode.Range(location.line - 1, 0, location.line - 1, 0)
			);
		}
		return testMessage;
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
			const line = Number(match[2]);
			if (!Number.isInteger(line) || line < 1 || !isWithin(projectPath, filePath)) {
				continue;
			}
			frames.push({
				line,
				filePath,
				relativePath: path.relative(projectPath, filePath).split(path.sep).join("/")
			});
		}
		if (frames.length > 0) {
			return frames;
		}

		const lineMatch = /\bat line (\d+)\b/i.exec(text);
		return lineMatch && metadata && Number(lineMatch[1]) > 0
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
		fileWatcher.onDidCreate((uri) => refreshForTestFile(uri, false));
		fileWatcher.onDidChange((uri) => refreshForTestFile(uri, false));
		fileWatcher.onDidDelete((uri) => refreshForTestFile(uri, true));

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
		notifyContinuousChange();
	}

	async function refreshForTestFile(uri, deleted) {
		const filePath = path.resolve(uri.fsPath);
		if (!isWithin(root.uri.fsPath, filePath)) {
			return;
		}
		if (isTestFilePath(filePath) && isConfiguredTestFile(filePath)) {
			const relativePath = path.relative(root.uri.fsPath, filePath).split(path.sep).join("/");
			const fileId = `file:${relativePath}`;
			const existing = controller.items.get(fileId);
			if (deleted || !fs.existsSync(filePath)) {
				if (existing) {
					removeTestFile(existing);
				}
			} else if (existing) {
				await resolveTestFile(existing, true);
			} else {
				addTestFile(filePath);
			}
		}
		notifyContinuousChange();
	}

	function isConfiguredTestFile(filePath) {
		return (
			isWithin(root.uri.fsPath, filePath) &&
			config?.directories.some((directory) => isWithin(directory, filePath)) === true
		);
	}

	function isTestFilePath(filePath) {
		const fileName = path.basename(filePath);
		const prefix = config?.prefix ?? "test_";
		const suffix = config?.suffix ?? ".gd";
		return fileName.startsWith(prefix) && fileName.endsWith(suffix);
	}

	function fileSignature(filePath) {
		try {
			const stat = fs.statSync(filePath);
			return `${stat.size}:${stat.mtimeMs}`;
		} catch {
			return "";
		}
	}

	context.subscriptions.push(
		controller,
		{ dispose: disposeWatchers },
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (event.affectsConfiguration("gutTestProvider", root)) {
				await refreshTests();
				setWatchers();
				notifyContinuousChange();
			}
		})
	);

	refreshTests().then(setWatchers);

	async function invokeGut(
		projectPath,
		gutConfig,
		relativePath,
		methodName,
		innerClassName,
		rendered,
		setProcess,
		token,
		onOutput,
		onRawOutput
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
			if (innerClassName) {
				args.push("-ginner_class", innerClassName);
			}
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
				gutConfig.environment,
				onRawOutput
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
		innerClassName,
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
			if (innerClassName) {
				argumentsList.push("-ginner_class", innerClassName);
			}
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

	function runProcess(executable, args, cwd, timeoutSeconds, token, setProcess, onOutput, environment, onRawOutput) {
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
				onRawOutput?.(text);
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
			innerClassPrefix: parsed.inner_class_prefix ?? "Test",
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
		const normalizedClassname = (classname ?? "")
			.replace(/^res:\/\//, "")
			.replace(/\\/g, "/");
		return `${normalizedClassname}::${name}`;
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

function findGodotProjects() {
	return (vscode.workspace.workspaceFolders ?? []).filter(
		(folder) =>
			fs.existsSync(path.join(folder.uri.fsPath, "project.godot")) &&
			fs.existsSync(path.join(folder.uri.fsPath, "addons", "gut", "gut_cmdln.gd"))
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
