import {
	CURRENT_SESSION_VERSION,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const COMMAND_NAME = "export-slice";
const LAST_TURN_COMMAND_NAME = "export-last-turn";
const VISIBLE_ITEMS = 10;

type ExportFormat = "html" | "jsonl";

interface SliceSelection {
	startIndex: number;
	endIndex: number;
}

interface SliceExportOptions {
	selection: SliceSelection;
	outputPathArg: string;
	defaultBaseName: string;
}

interface DisplayableEntry {
	entry: SessionMessageEntry;
	branchIndex: number;
	label: string;
}

export default function exportSliceExtension(pi: ExtensionAPI) {
	pi.registerCommand(COMMAND_NAME, {
		description: "Export a selected slice of the current branch",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(`/${COMMAND_NAME} requires interactive mode`, "error");
				return;
			}

			await ctx.waitForIdle();

			const branch = ctx.sessionManager.getBranch();
			const displayableEntries = getDisplayableEntries(branch);
			if (displayableEntries.length < 2) {
				ctx.ui.notify("Need at least two user/assistant messages on the current branch", "error");
				return;
			}

			const startItem = await selectSliceBoundary(ctx, {
				title: "Export Slice: Select Start",
				description: "Select the first user/assistant message to include in the export",
				entries: displayableEntries,
			});
			if (!startItem) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const endCandidates = displayableEntries.filter((item) => item.branchIndex >= startItem.branchIndex);
			const endItem = await selectSliceBoundary(ctx, {
				title: "Export Slice: Select End",
				description: "Select the last user/assistant message to include in the export",
				entries: endCandidates,
				initialSelectedId: startItem.entry.id,
			});
			if (!endItem) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			await exportSlice(pi, ctx, {
				selection: {
					startIndex: startItem.branchIndex,
					endIndex: endItem.branchIndex,
				},
				outputPathArg: args.trim(),
				defaultBaseName: `slice-${startItem.entry.id}-${endItem.entry.id}`,
			});
		},
	});

	pi.registerCommand(LAST_TURN_COMMAND_NAME, {
		description: "Export the last user turn on the current branch",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const branch = ctx.sessionManager.getBranch();
			if (branch.length === 0) {
				ctx.ui.notify("Nothing to export", "error");
				return;
			}

			const startIndex = findLastUserMessageIndex(branch);
			if (startIndex === -1) {
				ctx.ui.notify("No user message found on the current branch", "error");
				return;
			}

			await exportSlice(pi, ctx, {
				selection: {
					startIndex,
					endIndex: branch.length - 1,
				},
				outputPathArg: args.trim(),
				defaultBaseName: `last-turn-${branch[startIndex]?.id ?? "start"}-${branch[branch.length - 1]?.id ?? "end"}`,
			});
		},
	});
}

async function exportSlice(pi: ExtensionAPI, ctx: ExtensionCommandContext, options: SliceExportOptions) {
	const branch = ctx.sessionManager.getBranch();
	const slicedEntries = branch
		.slice(options.selection.startIndex, options.selection.endIndex + 1)
		.filter((entry) => entry.type !== "label");

	if (slicedEntries.length === 0) {
		ctx.ui.notify("Selected slice is empty", "error");
		return;
	}

	const format = resolveFormat(options.outputPathArg);
	const outputPath = resolveOutputPath(options.outputPathArg, options.defaultBaseName, format);
	mkdirSync(dirname(outputPath), { recursive: true });

	const jsonlPath = format === "jsonl" ? outputPath : `${outputPath}.jsonl.slice`;
	writeSliceJsonl(ctx.sessionManager.getCwd(), ctx.sessionManager.getSessionName(), slicedEntries, jsonlPath);

	if (format === "jsonl") {
		ctx.ui.notify(`Slice exported to ${jsonlPath}`, "info");
		return;
	}

	try {
		const result = await pi.exec("pi", ["--export", jsonlPath, outputPath]);
		if (result.code !== 0) {
			ctx.ui.notify(`HTML export failed: ${result.stderr || result.stdout || "unknown error"}`, "error");
			return;
		}

		ctx.ui.notify(`Slice exported to ${outputPath}`, "info");
	} finally {
		try {
			unlinkSync(jsonlPath);
		} catch {
			// Ignore temp cleanup errors.
		}
	}
}

async function selectSliceBoundary(
	ctx: ExtensionCommandContext,
	options: {
		title: string;
		description: string;
		entries: DisplayableEntry[];
		initialSelectedId?: string;
	},
): Promise<DisplayableEntry | undefined> {
	if (options.entries.length === 0) {
		return undefined;
	}

	const selectedId = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		let selectedIndex = options.initialSelectedId
			? Math.max(
				0,
				options.entries.findIndex((entry) => entry.entry.id === options.initialSelectedId),
			)
			: Math.max(0, options.entries.length - 1);

		return {
			render(width: number) {
				return renderSliceSelector(width, options.title, options.description, options.entries, selectedIndex);
			},
			invalidate() {
				// No cached state.
			},
			handleInput(data: string) {
				if (isUpKey(data)) {
					selectedIndex = selectedIndex === 0 ? options.entries.length - 1 : selectedIndex - 1;
					tui.requestRender();
					return;
				}
				if (isDownKey(data)) {
					selectedIndex = selectedIndex === options.entries.length - 1 ? 0 : selectedIndex + 1;
					tui.requestRender();
					return;
				}
				if (isConfirmKey(data)) {
					done(options.entries[selectedIndex]?.entry.id);
					return;
				}
				if (isCancelKey(data)) {
					done(undefined);
				}
			},
		};
	});

	if (!selectedId) {
		return undefined;
	}

	return options.entries.find((entry) => entry.entry.id === selectedId);
}

function renderSliceSelector(
	width: number,
	title: string,
	description: string,
	entries: DisplayableEntry[],
	selectedIndex: number,
): string[] {
	const safeWidth = Math.max(1, width);
	const lines = ["", title, description, "", rule(safeWidth), ""];

	const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(VISIBLE_ITEMS / 2), Math.max(0, entries.length - VISIBLE_ITEMS)));
	const endIndex = Math.min(entries.length, startIndex + VISIBLE_ITEMS);

	for (let i = startIndex; i < endIndex; i++) {
		const item = entries[i];
		const isSelected = i === selectedIndex;
		const cursor = isSelected ? "> " : "  ";
		const summary = truncateToWidth(item.label, Math.max(0, safeWidth - visibleWidth(cursor)), "");
		lines.push(truncateToWidth(`${cursor}${summary}`, safeWidth, ""));
		lines.push(truncateToWidth(`  Message ${item.branchIndex + 1} of ${entries.length}`, safeWidth, ""));
		lines.push("");
	}

	lines.push(rule(safeWidth));
	return lines.map((line) => truncateToWidth(line, safeWidth, ""));
}

function getDisplayableEntries(branch: SessionEntry[]): DisplayableEntry[] {
	return branch
		.map((entry, branchIndex) => {
			if (entry.type !== "message") {
				return undefined;
			}
			if (!isDisplayableRole(entry)) {
				return undefined;
			}

			return {
				entry,
				branchIndex,
				label: formatSelectorLabel(entry, branchIndex),
			};
		})
		.filter((item): item is DisplayableEntry => item !== undefined);
}

function isDisplayableRole(entry: SessionMessageEntry): boolean {
	return entry.message.role === "user" || entry.message.role === "assistant";
}

function formatSelectorLabel(entry: SessionMessageEntry, branchIndex: number): string {
	const role = entry.message.role;
	const text = summarizeMessage(entry).replace(/\s+/g, " ").trim() || "(empty)";
	return `${String(branchIndex + 1).padStart(3, "0")} [${role}] ${text.slice(0, 100)}`;
}

function summarizeMessage(entry: SessionMessageEntry): string {
	const { message } = entry;

	if (message.role === "user") {
		if (typeof message.content === "string") {
			return message.content;
		}
		return message.content
			.map((block) => (block.type === "text" ? block.text : `[${block.type}]`))
			.join(" ");
	}

	if (message.role === "assistant") {
		const parts = message.content
			.map((block) => {
				if (block.type === "text") {
					return block.text;
				}
				if (block.type === "thinking") {
					return "[thinking]";
				}
				if (block.type === "toolCall") {
					return `[tool:${block.name}]`;
				}
				return "";
			})
			.filter((part) => part.length > 0);
		return parts.join(" ");
	}

	return "";
}

function findLastUserMessageIndex(branch: SessionEntry[]): number {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "message" && entry.message.role === "user") {
			return i;
		}
	}
	return -1;
}

function resolveFormat(outputPathArg: string): ExportFormat {
	if (outputPathArg.endsWith(".jsonl")) {
		return "jsonl";
	}
	return "html";
}

function resolveOutputPath(outputPathArg: string, defaultBaseName: string, format: ExportFormat): string {
	if (outputPathArg.length > 0) {
		return resolve(outputPathArg);
	}

	const extension = format === "jsonl" ? "jsonl" : "html";
	return resolve(`${defaultBaseName}.${extension}`);
}

function writeSliceJsonl(cwd: string, sessionName: string | undefined, entries: SessionEntry[], outputPath: string): void {
	const now = new Date().toISOString();
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: randomUUID(),
		timestamp: now,
		cwd,
	};

	const lines = [JSON.stringify(header)];
	let previousId: string | null = null;

	for (const entry of entries) {
		const linearEntry = { ...entry, parentId: previousId };
		lines.push(JSON.stringify(linearEntry));
		previousId = entry.id;
	}

	if (sessionName) {
		lines.push(
			JSON.stringify({
				type: "session_info",
				id: createEntryId(),
				parentId: previousId,
				timestamp: now,
				name: `${sessionName} (slice)`,
			}),
		);
	}

	writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function createEntryId(): string {
	return randomBytes(4).toString("hex");
}

function rule(width: number): string {
	return "─".repeat(Math.max(1, width));
}

function isUpKey(data: string): boolean {
	return data === "\u001b[A" || data === "k";
}

function isDownKey(data: string): boolean {
	return data === "\u001b[B" || data === "j";
}

function isConfirmKey(data: string): boolean {
	return data === "\r" || data === "\n";
}

function isCancelKey(data: string): boolean {
	return data === "\u001b" || data === "\u0003";
}
