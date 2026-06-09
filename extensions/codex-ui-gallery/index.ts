import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { convertToPng } from "@earendil-works/pi-coding-agent";
import {
	allocateImageId,
	Container,
	deleteAllKittyImages,
	deleteKittyImage,
	getCellDimensions,
	getImageDimensions,
	Image as TerminalImage,
	matchesKey,
	Text,
	truncateToWidth,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

interface GalleryImage {
	id: string;
	path: string;
	mimeType: string;
	base64: string;
	displayMimeType?: string;
	displayBase64?: string;
	metadata?: Record<string, unknown>;
	prompt?: string;
	revisedPrompt?: string;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const DEFAULT_CANDIDATE_DIRS = [".codex-ui-design", ".codex-imagegen", "output/codex-app-imagegen"];

function expandHome(input: string): string {
	if (input === "~") return process.env.HOME || input;
	if (input.startsWith("~/")) return path.join(process.env.HOME || "", input.slice(2));
	return input;
}

function resolveUserPath(raw: string | undefined, cwd: string): string | undefined {
	if (!raw || !raw.trim()) return undefined;
	let p = raw.trim();
	if (p.startsWith("@")) p = p.slice(1);
	p = expandHome(p);
	return path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
}

function isImageFile(filePath: string): boolean {
	return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function mimeTypeFor(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
	if (ext === ".webp") return "image/webp";
	if (ext === ".gif") return "image/gif";
	return "image/png";
}

function readJson(filePath: string): any | undefined {
	try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return undefined; }
}

function mtimeMs(filePath: string): number {
	try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
}

function newestSummary(cwd: string): string | undefined {
	const candidates: string[] = [];
	for (const rel of DEFAULT_CANDIDATE_DIRS) {
		const dir = path.resolve(cwd, rel);
		collectSummaries(dir, candidates, 3);
	}
	return candidates.sort((a, b) => mtimeMs(b) - mtimeMs(a))[0];
}

function collectSummaries(dir: string, out: string[], depth: number): void {
	if (depth < 0) return;
	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isFile() && e.name === "summary.json") out.push(p);
		else if (e.isDirectory() && !e.name.startsWith(".")) collectSummaries(p, out, depth - 1);
	}
}

function metadataForImage(imagePath: string): Record<string, unknown> | undefined {
	const parsed = path.parse(imagePath);
	return readJson(path.join(parsed.dir, `${parsed.name}.json`));
}

function normalizeImageRecord(filePath: string, metadata?: Record<string, unknown>, id?: string): GalleryImage | undefined {
	if (!fs.existsSync(filePath) || !isImageFile(filePath)) return undefined;
	const buf = fs.readFileSync(filePath);
	return {
		id: id || String(metadata?.id || path.basename(filePath)),
		path: filePath,
		mimeType: mimeTypeFor(filePath),
		base64: buf.toString("base64"),
		metadata,
		prompt: typeof metadata?.prompt === "string" ? metadata.prompt : undefined,
		revisedPrompt: typeof metadata?.revisedPrompt === "string" ? metadata.revisedPrompt : undefined,
	};
}

async function prepareImageForTerminal(image: GalleryImage): Promise<GalleryImage> {
	if (image.displayBase64 && image.displayMimeType) return image;
	const converted = await convertToPng(image.base64, image.mimeType);
	if (!converted) return image;
	return {
		...image,
		displayBase64: converted.data,
		displayMimeType: converted.mimeType,
	};
}

async function prepareImagesForTerminal(images: GalleryImage[]): Promise<GalleryImage[]> {
	return Promise.all(images.map((image) => prepareImageForTerminal(image)));
}

function terminalBase64(image: GalleryImage): string {
	return image.displayBase64 || image.base64;
}

function terminalMimeType(image: GalleryImage): string {
	return image.displayMimeType || image.mimeType;
}

function imagesFromSummary(summaryPath: string): GalleryImage[] {
	const summary = readJson(summaryPath);
	const baseDir = path.dirname(summaryPath);
	const results = Array.isArray(summary?.results) ? summary.results : [];
	const images: GalleryImage[] = [];
	for (const r of results) {
		const metadata = (r?.metadata && typeof r.metadata === "object") ? r.metadata : undefined;
		const rawPath = r?.finalPath || metadata?.finalPath;
		if (typeof rawPath !== "string") continue;
		const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
		const img = normalizeImageRecord(filePath, metadata, String(r?.id || metadata?.id || path.basename(filePath)));
		if (img) images.push(img);
	}
	return images;
}

function imagesFromDirectory(dir: string): GalleryImage[] {
	const summaryPath = path.join(dir, "summary.json");
	if (fs.existsSync(summaryPath)) return imagesFromSummary(summaryPath);
	let entries: string[] = [];
	try { entries = fs.readdirSync(dir); } catch { return []; }
	return entries
		.map((name) => path.join(dir, name))
		.filter(isImageFile)
		.sort((a, b) => a.localeCompare(b))
		.map((p) => normalizeImageRecord(p, metadataForImage(p)))
		.filter((x): x is GalleryImage => Boolean(x));
}

function loadImages(inputPath: string | undefined, cwd: string): { source: string; images: GalleryImage[] } {
	let source = resolveUserPath(inputPath, cwd);
	if (!source) source = newestSummary(cwd);
	if (!source) return { source: "", images: [] };
	if (!fs.existsSync(source)) return { source, images: [] };
	const stat = fs.statSync(source);
	if (stat.isDirectory()) return { source, images: imagesFromDirectory(source) };
	if (path.basename(source) === "summary.json") return { source, images: imagesFromSummary(source) };
	if (isImageFile(source)) {
		const sibling = imagesFromDirectory(path.dirname(source));
		const selected = sibling.findIndex((img) => img.path === source);
		if (selected > 0) return { source, images: [sibling[selected]!, ...sibling.slice(0, selected), ...sibling.slice(selected + 1)] };
		const single = normalizeImageRecord(source, metadataForImage(source));
		return { source, images: single ? [single] : [] };
	}
	return { source, images: [] };
}

function openPath(filePath: string): void {
	const platform = process.platform;
	const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
	const args = platform === "win32" ? ["/c", "start", "", filePath] : [filePath];
	const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
	child.unref();
}

function copyToClipboard(text: string): void {
	if (process.platform !== "darwin") return;
	const child = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
	child.stdin.end(text);
}

function fittedImageWidthCells(image: GalleryImage, terminalWidth: number, terminalRows: number, maxCols: number, reserveRows: number, fitToScreen: boolean): number {
	const inner = Math.max(20, terminalWidth - 4);
	if (!fitToScreen) return Math.max(20, Math.min(inner, maxCols));
	const dims = getImageDimensions(terminalBase64(image), terminalMimeType(image)) || { widthPx: 1440, heightPx: 1800 };
	const cell = getCellDimensions();
	const availableRows = Math.max(8, terminalRows - reserveRows);
	const byHeight = Math.floor((availableRows * cell.heightPx * dims.widthPx) / (dims.heightPx * cell.widthPx));
	return Math.max(16, Math.min(inner, maxCols, byHeight));
}

class InlineImageViewer {
	private maxCols = 118;
	private fitToScreen = true;
	private readonly imageId = allocateImageId();
	private readonly image: GalleryImage;
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly done: () => void;

	constructor(image: GalleryImage, theme: Theme, tui: TUI, done: () => void) {
		this.image = image;
		this.theme = theme;
		this.tui = tui;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter") || data === "q") return this.close();
		if (data === "+" || data === "=") { this.clearImage(); this.fitToScreen = false; this.maxCols = Math.min(180, this.maxCols + 16); }
		else if (data === "-" || data === "_") { this.clearImage(); this.fitToScreen = false; this.maxCols = Math.max(40, this.maxCols - 16); }
		else if (data === "0" || data === "f") { this.clearImage(); this.fitToScreen = true; this.maxCols = 118; }
		else if (data === "w") { this.clearImage(); this.fitToScreen = false; this.maxCols = 999; }
		else if (data === "o") openPath(this.image.path);
		else if (data === "c") copyToClipboard(this.image.path);
	}

	private clearImage(): void {
		try { process.stdout.write(deleteKittyImage(this.imageId)); } catch {}
	}

	private close(): void {
		this.clearImage();
		this.done();
	}

	render(width: number): string[] {
		const th = this.theme;
		const imageCols = fittedImageWidthCells(this.image, width, this.tui.terminal.rows, this.maxCols, 8, this.fitToScreen);
		const container = new Container();
		container.addChild(new Text(th.fg("accent", th.bold("Codex UI image viewer")) + th.fg("dim", `  ${path.basename(this.image.path)}`), 0, 0));
		container.addChild(new Text(th.fg("dim", this.image.path), 0, 0));
		container.addChild(new Text(th.fg("dim", "f/0 fit screen • w fit width • +/- manual zoom • o open • c copy • enter/esc close"), 0, 0));
		container.addChild(new TerminalImage(terminalBase64(this.image), terminalMimeType(this.image), { fallbackColor: (s: string) => th.fg("dim", s) }, {
			maxWidthCells: imageCols,
			filename: path.basename(this.image.path),
			imageId: this.imageId,
		}));
		const prompt = this.image.revisedPrompt || this.image.prompt;
		if (prompt) container.addChild(new Text(th.fg("muted", truncateToWidth(prompt.replace(/\s+/g, " "), Math.max(20, width - 4))), 0, 0));
		return container.render(width);
	}

	invalidate(): void {}
}

class NativeGalleryComponent {
	private selected = 0;
	private showPrompt = false;
	private maxCols = 118;
	private fitToScreen = true;
	private readonly imageId = allocateImageId();
	private readonly images: GalleryImage[];
	private readonly source: string;
	private readonly theme: Theme;
	private readonly tui: TUI;
	private readonly done: (value: string | null) => void;

	constructor(images: GalleryImage[], source: string, theme: Theme, tui: TUI, done: (value: string | null) => void) {
		this.images = images;
		this.source = source;
		this.theme = theme;
		this.tui = tui;
		this.done = done;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") return this.close(null);
		if (matchesKey(data, "right") || matchesKey(data, "down") || data === "n" || data === "j") this.move(1);
		else if (matchesKey(data, "left") || matchesKey(data, "up") || data === "p" || data === "k") this.move(-1);
		else if (data === "g") this.moveTo(0);
		else if (data === "G") this.moveTo(this.images.length - 1);
		else if (data === "+" || data === "=") { this.clearImage(); this.fitToScreen = false; this.maxCols = Math.min(180, this.maxCols + 16); }
		else if (data === "-" || data === "_") { this.clearImage(); this.fitToScreen = false; this.maxCols = Math.max(40, this.maxCols - 16); }
		else if (data === "0" || data === "f") { this.clearImage(); this.fitToScreen = true; this.maxCols = 118; }
		else if (data === "w") { this.clearImage(); this.fitToScreen = false; this.maxCols = 999; }
		else if (data === "i") { this.clearImage(); this.showPrompt = !this.showPrompt; }
		else if (data === "o") openPath(this.current().path);
		else if (data === "c") copyToClipboard(this.current().path);
		else if (matchesKey(data, "enter") || data === "v") this.close(this.current().path);
	}

	private clearImage(): void {
		try { process.stdout.write(deleteKittyImage(this.imageId)); } catch {}
	}

	private close(value: string | null): void {
		this.clearImage();
		this.done(value);
	}

	private current(): GalleryImage { return this.images[this.selected]!; }
	private move(delta: number): void { this.moveTo((this.selected + delta + this.images.length) % this.images.length); }
	private moveTo(i: number): void { this.clearImage(); this.selected = Math.max(0, Math.min(this.images.length - 1, i)); }

	render(width: number): string[] {
		const th = this.theme;
		const img = this.current();
		const inner = Math.max(20, width - 4);
		const imageCols = fittedImageWidthCells(img, width, this.tui.terminal.rows, this.maxCols, this.showPrompt ? 12 : 10, this.fitToScreen);
		const container = new Container();
		container.addChild(new Text(th.fg("accent", th.bold("Codex UI Gallery")) + th.fg("muted", `  ${this.selected + 1}/${this.images.length}`), 0, 0));
		container.addChild(new Text(th.fg("dim", truncateToWidth(this.source || "latest generated images", inner)), 0, 0));
		container.addChild(new Text(th.fg("dim", "←/→ navigate • f/0 fit screen • w fit width • +/- zoom • i prompt • o open • esc close"), 0, 0));
		container.addChild(new Text(th.fg("toolTitle", path.basename(img.path)) + th.fg("dim", `  ${img.mimeType}`), 0, 0));
		container.addChild(new Text(th.fg("dim", truncateToWidth(img.path, inner)), 0, 0));
		container.addChild(new TerminalImage(terminalBase64(img), terminalMimeType(img), { fallbackColor: (s: string) => th.fg("dim", s) }, {
			maxWidthCells: imageCols,
			filename: path.basename(img.path),
			imageId: this.imageId,
		}));
		const prompt = img.revisedPrompt || img.prompt;
		if (prompt) {
			const text = this.showPrompt ? prompt : prompt.replace(/\s+/g, " ").slice(0, 260);
			container.addChild(new Text(th.fg("muted", truncateToWidth(text, inner)), 0, 0));
		}
		return container.render(width);
	}

	invalidate(): void {}
}

async function showInlineImageViewer(ctx: ExtensionContext | ExtensionCommandContext, image: GalleryImage): Promise<void> {
	if (!ctx.hasUI) return;
	const prepared = await prepareImageForTerminal(image);
	await ctx.ui.custom<void>((tui, theme, _kb, done) => new InlineImageViewer(prepared, theme, tui, () => done(undefined)));
}

async function showGallery(ctx: ExtensionContext | ExtensionCommandContext, rawPath?: string): Promise<string | null> {
	const { source, images: rawImages } = loadImages(rawPath, ctx.cwd);
	const images = await prepareImagesForTerminal(rawImages);
	if (!images.length) {
		if (ctx.hasUI) ctx.ui.notify(`No Codex UI images found${source ? ` at ${source}` : ""}`, "warning");
		return null;
	}
	if (!ctx.hasUI) return images[0]?.path ?? null;
	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => new NativeGalleryComponent(images, source, theme, tui, done));
}

function imageByPath(rawPath: string, cwd: string): GalleryImage | undefined {
	const resolved = resolveUserPath(rawPath, cwd);
	if (!resolved) return undefined;
	return normalizeImageRecord(resolved, metadataForImage(resolved));
}

function textFromToolContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.map((part: any) => part?.type === "text" ? String(part.text || "") : "").join("\n");
}

function extractSummaryPath(text: string, cwd: string): string | undefined {
	const candidates: string[] = [];
	for (const m of text.matchAll(/(?:Summary:\s*)?([^\s`"']*summary\.json)/g)) candidates.push(m[1]!);
	for (const c of candidates) {
		const p = resolveUserPath(c, cwd);
		if (p && fs.existsSync(p)) return p;
	}
	return undefined;
}

export default function codexUiGallery(pi: ExtensionAPI) {
	pi.registerCommand("codex-gallery-clear", {
		description: "Clear lingering terminal graphics from the Codex UI gallery",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			try { process.stdout.write(deleteAllKittyImages()); } catch {}
			ctx.ui.notify("Cleared terminal images", "info");
		},
	});

	pi.registerCommand("codex-image", {
		description: "Render a high-quality Codex UI image viewer inside Pi. Arg: image path.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const image = imageByPath(args.trim(), ctx.cwd);
			if (!image) return ctx.ui.notify("No image found for /codex-image", "warning");
			await showInlineImageViewer(ctx, image);
		},
	});

	pi.registerCommand("codex-gallery", {
		description: "Open a high-quality native gallery for codex-ui-design images. Optional arg: output dir, summary.json, or image path.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await showGallery(ctx, args.trim() || undefined);
		},
	});

	pi.registerTool({
		name: "show_codex_ui_gallery",
		label: "Codex UI Gallery",
		description: "Open a high-quality native Pi TUI gallery for images generated by codex-ui-design. Path may be an output directory, summary.json, or image file. If omitted, opens the newest local Codex UI output.",
		promptSnippet: "Open a high-quality native TUI gallery for generated codex-ui-design images",
		promptGuidelines: [
			"Use show_codex_ui_gallery after running codex-ui-design image generation when the user needs to inspect generated UI mockups inside Pi.",
		],
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Output directory, summary.json, or image path. Defaults to newest .codex-ui-design/.codex-imagegen summary under cwd." })),
		}),
		async execute(_toolCallId, params: { path?: string }, _signal, _onUpdate, ctx) {
			const { source, images: rawImages } = loadImages(params.path, ctx.cwd);
			const images = await prepareImagesForTerminal(rawImages);
			let selectedPath: string | null | undefined = images[0]?.path;
			if (ctx.hasUI && images.length) selectedPath = await showGallery(ctx, params.path);
			const selected = selectedPath ? (imageByPath(selectedPath, ctx.cwd) || images.find((img) => img.path === selectedPath)) : undefined;
			const content: any[] = [{ type: "text", text: images.length ? `Opened Codex UI gallery for ${images.length} image(s) from ${source}${selected ? `. Selected: ${selected.path}` : "."}` : `No Codex UI images found${source ? ` at ${source}` : ""}.` }];
			if (selected) content.push({ type: "image", data: selected.base64, mimeType: selected.mimeType });
			return {
				content,
				details: { source, selected: selected?.path, images: images.map((img) => ({ id: img.id, path: img.path, prompt: img.prompt, revisedPrompt: img.revisedPrompt })) },
			};
		},
	});

	pi.on("tool_result", async (event: any, ctx: ExtensionContext) => {
		if (!ctx.hasUI || process.env.PI_CODEX_GALLERY_AUTO === "0") return;
		if (event.toolName !== "bash") return;
		const command = String(event.input?.command || "");
		if (!/codex-ui-design|codex-app-imagegen|scripts\/(generate|upgrade|imagegen)\.sh/.test(command)) return;
		const text = textFromToolContent(event.content);
		const summaryPath = extractSummaryPath(text, ctx.cwd) || newestSummary(ctx.cwd);
		if (!summaryPath) return;
		const { images } = loadImages(summaryPath, ctx.cwd);
		if (!images.length) return;
		await showGallery(ctx, summaryPath);
	});
}
