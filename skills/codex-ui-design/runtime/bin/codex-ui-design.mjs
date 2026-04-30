#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { createWriteStream, existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MODEL = process.env.CODEX_UI_MODEL || "gpt-5.5";
const DEFAULT_SKILL_PATH = "/Users/gfw/.codex/skills/.system/imagegen/SKILL.md";
const DEFAULT_OUT = ".codex-ui-design";
const DIRECTIONS = [
  ["artistic-universal", "brand-specific award-tier UI; let the content decide whether photography, illustration, typography, product object, diagram, or graphic system carries the interface"],
  ["swiss-editorial", "rigorous Swiss editorial grid, strong typography, measured whitespace, magazine hierarchy, delicate rules"],
  ["cinematic-product", "cinematic product/brand world with concrete hero visual, rich lighting, credible photography or rendered object"],
  ["brutalist-mono", "hard-edged mono/brutalist system, raw borders, data labels, high contrast, no generic SaaS softness"],
  ["warm-editorial", "human warm editorial design, craft textures, restrained palette, elegant serif/sans, premium approachable"],
  ["dark-neon-cyber", "deep dark technical interface with neon edges, grid glow, cinematic contrast, useful not gimmicky"],
  ["playful-maximal", "playful maximal interface, saturated colors, chunky type, stickers/illustrations, kinetic but usable"],
  ["diagrammatic-system", "technical diagram/information-graphic visual carrier, annotated flows, clear system model, precise UI density"],
  ["glass-ambient", "ambient glass/gradient interface with depth, soft iridescence, elegant panels, premium app feel"],
  ["kinetic-type", "oversized expressive type and motion-ready layout, strong words as visual carrier, sharp hierarchy"],
  ["minimal-luxury", "quiet luxury, extreme restraint, tactile details, exact spacing, subtle contrast, no template clutter"],
  ["app-command-center", "serious app/dashboard command center, operator-grade density, calm hierarchy, legible tables and panels"],
];

function usage() { return `codex-ui-design — image-first UI design via Codex app-server

Commands:
  probe [--model MODEL] [--out DIR]
  imagegen --prompt TEXT [--image IMG ...] | --prompts prompts.jsonl [--out DIR] [--concurrency N]
  generate --context TEXT [--variants N] [--concurrency N] [--out DIR]
  upgrade --target FILE_OR_URL [--context TEXT] [--variants N] [--concurrency N] [--out DIR]
  describe --image PNG [--out DIR]
  iterate --target FILE_OR_URL --reference PNG [--out DIR]

Env:
  CODEX_UI_MODEL       default ${DEFAULT_MODEL}
  CODEX_UI_KEEP_SERVER set 1 to leave app-servers running
`; }

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith("--")) { a._.push(raw); continue; }
    const eq = raw.indexOf("=");
    const key = raw.slice(2, eq === -1 ? undefined : eq);
    const val = eq === -1 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true) : raw.slice(eq + 1);
    if (a[key] === undefined) a[key] = val; else if (Array.isArray(a[key])) a[key].push(val); else a[key] = [a[key], val];
  }
  return a;
}
const asInt = (v, fb) => { const n = Number.parseInt(String(v ?? ""), 10); return Number.isFinite(n) && n > 0 ? n : fb; };
const abs = (p) => path.resolve(String(p || DEFAULT_OUT));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sanitizeName(value) { return String(value).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "image"; }
function inferExt(buf) { if (buf.subarray(0,8).toString("hex") === "89504e470d0a1a0a") return ".png"; if (buf.subarray(0,3).toString("hex") === "ffd8ff") return ".jpg"; if (buf.length >= 12 && buf.subarray(8,12).toString("ascii") === "WEBP") return ".webp"; return ".png"; }
function decodeImageResult(result) { if (!result || typeof result !== "string") return null; const m = result.match(/^data:[^;]+;base64,(.*)$/s); const b64 = (m ? m[1] : result).replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, ""); if (b64.length < 200) return null; try { return Buffer.from(b64, "base64"); } catch { return null; } }
async function freePort() { return new Promise((resolve, reject) => { const s = createServer(); s.unref(); s.on("error", reject); s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); }); }
async function waitReady(port, child, timeoutMs) { const deadline = Date.now() + timeoutMs; let exited = false; child.once("exit", () => { exited = true; }); while (Date.now() < deadline) { if (exited) throw new Error("codex app-server exited before ready"); try { const r = await fetch(`http://127.0.0.1:${port}/readyz`); if (r.ok) return; } catch {} await sleep(150); } throw new Error(`timed out waiting for readyz on ${port}`); }

async function startAppServer({ logsDir, timeoutMs }) {
  const port = await freePort();
  await fs.mkdir(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `app-server-${port}.log`);
  const log = createWriteStream(logPath, { flags: "a" });
  const child = spawn("codex", ["app-server", "--listen", `ws://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.pipe(log); child.stderr.pipe(log);
  await waitReady(port, child, timeoutMs);
  return { url: `ws://127.0.0.1:${port}`, port, logPath, child, async close() { if (process.env.CODEX_UI_KEEP_SERVER) return; if (child.exitCode !== null || child.signalCode !== null) return; child.kill("SIGTERM"); await sleep(500); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } };
}

class RpcClient {
  constructor(url) { this.url = url; this.ws = null; this.nextId = 1; this.pending = new Map(); this.handlers = new Set(); }
  async connect(timeoutMs = 10_000) { this.ws = new WebSocket(this.url); this.ws.addEventListener("message", (ev) => this.onMessage(ev)); return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("websocket connect timeout")), timeoutMs); this.ws.addEventListener("open", () => { clearTimeout(t); resolve(); }, { once: true }); this.ws.addEventListener("error", () => { clearTimeout(t); reject(new Error(`websocket failed ${this.url}`)); }, { once: true }); }); }
  onNotification(h) { this.handlers.add(h); return () => this.handlers.delete(h); }
  notify(method, params) { this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params })); }
  send(method, params, timeoutMs = 60_000) { const id = String(this.nextId++); const payload = { jsonrpc: "2.0", id, method }; if (params !== undefined) payload.params = params; this.ws.send(JSON.stringify(payload)); return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout for ${method}`)); }, timeoutMs); this.pending.set(id, { resolve, reject, timer, method }); }); }
  respondError(id, code, message) { this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })); }
  onMessage(ev) { const msg = JSON.parse(ev.data); if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) { const p = this.pending.get(String(msg.id)); if (p) { clearTimeout(p.timer); this.pending.delete(String(msg.id)); msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message || JSON.stringify(msg.error)}`)) : p.resolve(msg.result); } return; } if (msg.id !== undefined && msg.method) return this.handleServerRequest(msg); for (const h of this.handlers) h(msg); }
  handleServerRequest(msg) { if (msg.method?.includes("requestApproval")) return this.respondError(msg.id, -32000, "approval requests are disabled"); if (msg.method === "account/chatgptAuthTokens/refresh") return this.respondError(msg.id, -32001, "token refresh is not handled"); return this.respondError(msg.id, -32601, `server request not implemented: ${msg.method}`); }
  close() { try { this.ws?.close(); } catch {} }
}

async function initializeClient(rpc, opts) {
  const init = await rpc.send("initialize", { clientInfo: { name: "codex-ui-design", title: "Codex UI Design", version: "0.2.0" }, capabilities: { experimentalApi: true } }, opts.rpcTimeoutMs);
  rpc.notify("initialized");
  const auth = await rpc.send("getAuthStatus", { includeToken: false, refreshToken: false }, opts.rpcTimeoutMs);
  let account = null; try { account = await rpc.send("account/read", { refreshToken: false }, 20_000); } catch {}
  return { init, auth, account };
}

async function withServer(opts, fn) { const server = await startAppServer({ logsDir: opts.logsDir, timeoutMs: opts.serverTimeoutMs }); const rpc = new RpcClient(server.url); try { await rpc.connect(opts.serverTimeoutMs); const state = await initializeClient(rpc, opts); return await fn(rpc, server, state); } finally { rpc.close(); await server.close(); } }
function threadParams(opts) { const p = { cwd: opts.cwd, approvalPolicy: "never", sandbox: "workspace-write", ephemeral: true, experimentalRawEvents: true, persistExtendedHistory: false, sessionStartSource: "startup", developerInstructions: "Use Codex built-in image generation when requested. Do not call external image APIs, do not require OPENAI_API_KEY, and do not expose auth tokens." }; if (opts.model) p.model = opts.model; return p; }
async function startThread(rpc, opts) { return rpc.send("thread/start", threadParams(opts), opts.rpcTimeoutMs); }
function toArray(value) { if (value === undefined || value === null || value === false) return []; return Array.isArray(value) ? value : [value]; }
function expandHome(input) { const s = String(input || ""); if (s === "~") return process.env.HOME || s; if (s.startsWith("~/")) return path.join(process.env.HOME || "", s.slice(2)); return s; }
function isRemoteImageRef(value) { return /^https?:\/\//i.test(String(value || "")); }
function normalizeImageRef(value, baseDir) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    const raw = value.url || value.path || value.file || value.image;
    if (!raw) return null;
    const label = typeof value.label === "string" ? value.label : typeof value.role === "string" ? value.role : undefined;
    const normalized = normalizeImageRef(String(raw), baseDir);
    return normalized ? { ...normalized, label } : null;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (isRemoteImageRef(raw)) return { type: "url", url: raw };
  const p = path.isAbsolute(expandHome(raw)) ? path.normalize(expandHome(raw)) : path.resolve(baseDir || process.cwd(), expandHome(raw));
  if (!existsSync(p)) throw new Error(`input image not found: ${p}`);
  return { type: "local", path: p };
}
function normalizeImageRefs(value, baseDir) { return toArray(value).flatMap((v) => { const img = normalizeImageRef(v, baseDir); return img ? [img] : []; }); }
function imagePromptNote(images) {
  if (!images?.length) return "";
  const lines = images.map((img, i) => {
    const label = img.label || "reference/edit target";
    const source = img.type === "url" ? img.url : img.path;
    return `Image ${i + 1}: ${label} (${source})`;
  });
  return `\n\nInput images:\n${lines.join("\n")}\nUse these input images as references/edit targets exactly as described by the prompt.`;
}
function imageMetadata(images = []) { return images.map((img, i) => { const ref = typeof img === "string" ? normalizeImageRef(img, process.cwd()) : img; return { index: i + 1, type: ref?.type || "local", path: ref?.path, url: ref?.url, label: ref?.label || null }; }); }
function buildInput({ text, images = [], imagegen = false, opts }) {
  const input = [];
  if (imagegen && opts.skillPath && existsSync(opts.skillPath)) input.push({ type: "skill", name: "imagegen", path: opts.skillPath });
  const normalizedImages = images.map((img) => typeof img === "string" ? normalizeImageRef(img, opts.cwd) : img).filter(Boolean);
  for (const img of normalizedImages) input.push(img.type === "url" ? { type: "image", url: img.url } : { type: "localImage", path: img.path });
  const note = imagegen ? imagePromptNote(normalizedImages) : "";
  input.push({ type: "text", text: imagegen ? `${text.trim()}${note}\n\nUse the built-in image generation tool and produce exactly one raster image. Do not call shell scripts or external APIs. Do not ask for OPENAI_API_KEY.\n$imagegen` : text, text_elements: [] });
  return input;
}

async function runTurn(rpc, job, opts) {
  const th = await startThread(rpc, opts); const threadId = th.thread.id; let turnId = null; const imageItems = [], rawImageItems = [], messages = [], warnings = [];
  const done = new Promise((resolve, reject) => { const timer = setTimeout(() => { off(); reject(new Error(`turn timeout for ${job.id || "turn"}`)); }, opts.turnTimeoutMs); const off = rpc.onNotification((msg) => { const p = msg.params || {}; if (p.threadId && p.threadId !== threadId) return; if (msg.method === "turn/started") turnId = p.turn?.id || p.turnId || turnId; if (msg.method === "warning") warnings.push(p.message || JSON.stringify(p)); if (msg.method === "error") warnings.push(p.message || JSON.stringify(p)); if (msg.method === "item/completed") { const item = p.item; if (item?.type === "imageGeneration") imageItems.push(item); if (item?.type === "agentMessage" && item.text) messages.push(item.text); } if (msg.method === "rawResponseItem/completed") { const item = p.item; if (item?.type === "image_generation_call") rawImageItems.push(item); if (item?.type === "message" && item.role === "assistant") { const txt = (item.content || []).map(c => c.text || "").join("").trim(); if (txt) messages.push(txt); } } if (msg.method === "item/agentMessage/delta" && p.delta) { /* keep final item text if emitted */ } if (msg.method === "turn/completed") { clearTimeout(timer); off(); resolve(p.turn); } }); });
  await rpc.send("turn/start", { threadId, input: buildInput({ text: job.prompt, images: job.images, imagegen: job.imagegen, opts }), cwd: opts.cwd, approvalPolicy: "never", model: opts.model }, opts.rpcTimeoutMs);
  const turn = await done;
  return { job, threadId, turnId: turnId || turn?.id || null, turnStatus: turn?.status || null, turnError: turn?.error || null, imageItems, rawImageItems, messages, warnings };
}

async function persistImage(run, opts) {
  await fs.mkdir(opts.outDir, { recursive: true });
  const id = sanitizeName(run.job.id || "image");
  const primary = run.imageItems.at(-1) || null; const raw = run.rawImageItems.at(-1) || null;
  let finalPath = null, sourcePath = null, source = null;
  if (primary?.savedPath && existsSync(primary.savedPath)) { sourcePath = primary.savedPath; finalPath = path.join(opts.outDir, `${id}${path.extname(sourcePath) || ".png"}`); copyFileSync(sourcePath, finalPath); source = "savedPath"; }
  else { const buf = decodeImageResult(primary?.result || raw?.result); if (buf) { finalPath = path.join(opts.outDir, `${id}${inferExt(buf)}`); await fs.writeFile(finalPath, buf); source = "base64-result"; } }
  const metadata = { id: run.job.id, prompt: run.job.prompt, inputImages: imageMetadata(run.job.images), source, sourcePath, finalPath, threadId: run.threadId, turnId: run.turnId, turnStatus: run.turnStatus, turnError: run.turnError, revisedPrompt: primary?.revisedPrompt || raw?.revised_prompt || null, imageStatus: primary?.status || raw?.status || null, messageText: run.messages.join("\n\n").slice(0, 4000), warnings: run.warnings, completedAt: new Date().toISOString() };
  const metadataPath = path.join(opts.outDir, `${id}.json`); await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  if (!finalPath) throw new Error(`no image result for ${run.job.id}; see ${metadataPath}`);
  return { finalPath, metadataPath, metadata };
}

async function worker(workerId, queue, opts, results) { await withServer(opts, async (rpc) => { while (queue.length) { const job = queue.shift(); try { const run = await runTurn(rpc, { ...job, imagegen: true }, opts); const p = await persistImage(run, opts); results.push({ id: job.id, ok: true, workerId, ...p }); console.error(`[worker ${workerId}] ${job.id} -> ${p.finalPath}`); } catch (e) { results.push({ id: job.id, ok: false, workerId, error: e.message }); console.error(`[worker ${workerId}] ${job.id} failed: ${e.message}`); } } }); }
async function runImageJobs(jobs, opts) { const queue = [...jobs]; const results = []; const c = Math.min(asInt(opts.concurrency, 1), jobs.length || 1); await fs.mkdir(opts.outDir, { recursive: true }); await Promise.all(Array.from({ length: c }, (_, i) => worker(i + 1, queue, opts, results))); const summary = { ok: results.every(r => r.ok), concurrency: c, total: results.length, succeeded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results }; const summaryPath = path.join(opts.outDir, "summary.json"); await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`); return { summary, summaryPath }; }

async function screenshot(target, outPath) { const puppeteer = await import("puppeteer"); const browser = await puppeteer.default.launch({ headless: "new" }); try { const page = await browser.newPage(); await page.setViewport({ width: 1920, height: 2880, deviceScaleFactor: 1 }); const url = /^https?:|^file:/.test(target) ? target : pathToFileURL(path.resolve(target)).href; await page.goto(url, { waitUntil: "networkidle0", timeout: 60_000 }); await sleep(1000); await page.screenshot({ path: outPath, type: "png", fullPage: false }); } finally { await browser.close(); } }
function pickDirections(n) { return DIRECTIONS.slice().sort(() => Math.random() - 0.5).slice(0, Math.min(n, DIRECTIONS.length)); }
function uiPrompt({ context, direction, mode }) { const [slug, vibe] = direction; const lead = mode === "upgrade" ? "You are editing the attached screenshot into a much stronger production UI reference. Preserve visible copy, brand name, nav semantics, CTA meaning, and information architecture; radically improve composition, type, imagery, palette, spacing, components, and visual system." : "You are designing a new interface from scratch from the brief below. Create a complete, credible desktop UI mockup that can be implemented as a real web product, landing page, dashboard, or app surface."; return `${lead}\n\nBRIEF / CONTEXT:\n${context || "No extra context provided."}\n\nDIRECTION: ${slug}\n${vibe}\n\nMake a concrete art-direction choice based on the product: product image, photography, illustration/character, typography, diagram/information graphic, or graphic system. Do not default to generic SaaS cards, blue CTAs, emoji decoration, Inter-only typography, or bland dashboard chrome. The output should look like a high-end interface screenshot, not an abstract poster.\n\nRender as a tall desktop web UI screenshot, 1440–1920px wide and up to 2880px tall, front-on, no browser chrome, no device frame, no watermark, readable text, no broken glyphs, no duplicated words.`; }
const SPEC_PROMPT = `You are a senior design engineer. The attached image is the approved target UI design. Write an implementation build spec for Pi to reproduce it in real code. Output Markdown only with: # Design spec, ## Hard constraints, ## Summary, ## Canvas & palette, ## Typography, ## Layout & sections, ## Components & micro-details, ## Implementation notes. Be concise, numeric, and specific.`;
function buildGallery(outDir, results, beforePath, kind) { const cards = results.map((r) => r.ok ? `<a class="card" href="./${path.basename(r.finalPath)}" target="_blank"><img src="./${path.basename(r.finalPath)}"><h2>${r.id}</h2><p>${r.metadata?.revisedPrompt?.slice(0,220) || ""}</p></a>` : `<article class="card fail"><h2>${r.id}</h2><pre>${r.error}</pre></article>`).join("\n"); const before = beforePath ? `<section class="before"><img src="./${path.basename(beforePath)}"><span>before</span></section>` : ""; const html = `<!doctype html><meta charset="utf-8"><title>codex-ui-design ${kind}</title><style>body{margin:0;background:#090909;color:#f4f1ea;font-family:ui-sans-serif,system-ui;padding:32px}h1{font-size:48px;letter-spacing:-.04em;margin:0 0 12px}.before{display:flex;gap:16px;align-items:center;margin:24px 0}.before img{width:280px;border:1px solid #333;border-radius:10px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:18px}.card{display:block;color:inherit;text-decoration:none;background:#121212;border:1px solid #262626;border-radius:18px;overflow:hidden}.card img{width:100%;aspect-ratio:1/1.35;object-fit:cover;display:block}.card h2{font-size:18px;margin:14px 16px 6px}.card p,.card pre{color:#aaa;font-size:12px;margin:0 16px 16px;white-space:pre-wrap}.fail{padding:16px;border-color:#633}</style><h1>codex-ui-design ${kind}</h1><p>Pick a reference image, then run describe.sh on it.</p>${before}<main class="grid">${cards}</main>`; const p = path.join(outDir, "gallery.html"); writeFileSync(p, html); return p; }
async function textWithImages(prompt, images, opts, outFile) { return withServer(opts, async (rpc) => { const run = await runTurn(rpc, { id: "text", prompt, images, imagegen: false }, opts); const txt = run.messages.join("\n\n").trim() || "# No output\n"; await fs.writeFile(outFile, `${txt}\n`); return outFile; }); }

async function loadPromptJobs(args, opts) {
  const entries = [];
  const cwd = opts?.cwd || process.cwd();
  const globalImages = normalizeImageRefs([...toArray(args.image), ...toArray(args["input-image"])], cwd);
  for (const prompt of toArray(args.prompt)) entries.push({ line: String(prompt), baseDir: cwd });
  if (args.prompts) {
    const promptsPath = path.resolve(cwd, String(args.prompts));
    const text = await fs.readFile(promptsPath, "utf8");
    const baseDir = path.dirname(promptsPath);
    entries.push(...text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => ({ line, baseDir })));
  }
  if (!entries.length) throw new Error("provide --prompt TEXT or --prompts prompts.jsonl");
  return entries.map(({ line, baseDir }, idx) => {
    if (line.startsWith("{")) {
      const o = JSON.parse(line);
      const prompt = o.prompt || o.text || "";
      const perJobImages = normalizeImageRefs(o.images ?? o.image ?? o.inputImages ?? o.input_image, baseDir);
      return { id: o.id || `image-${idx+1}`, prompt, images: [...globalImages, ...perJobImages] };
    }
    return { id: `image-${idx+1}`, prompt: line, images: globalImages };
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2); const args = parseArgs(rest); if (!cmd || cmd === "--help" || args.help) { console.log(usage()); return; }
  const outDir = abs(args.out || args["out-dir"] || DEFAULT_OUT); const opts = { cwd: path.resolve(args.cwd || process.cwd()), outDir, logsDir: path.resolve(args["logs-dir"] || path.join(outDir, "logs")), model: args.model === "default" ? null : (args.model || DEFAULT_MODEL), skillPath: args["skill-path"] === "none" ? null : (args["skill-path"] || DEFAULT_SKILL_PATH), concurrency: asInt(args.concurrency, 4), serverTimeoutMs: asInt(args["server-timeout-ms"], 30_000), rpcTimeoutMs: asInt(args["rpc-timeout-ms"], 120_000), turnTimeoutMs: asInt(args["turn-timeout-ms"], 300_000) };
  await fs.mkdir(outDir, { recursive: true });
  if (cmd === "probe") return withServer(opts, async (rpc, server, state) => { const run = await runTurn(rpc, { id: "probe", prompt: "Reply exactly: OK", imagegen: false }, opts); console.log(JSON.stringify({ ok: true, model: opts.model, authMethod: state.auth?.authMethod, accountType: state.account?.type || null, planType: state.account?.planType || null, serverUrl: server.url, logPath: server.logPath, threadId: run.threadId, turnStatus: run.turnStatus, messageText: run.messages.join("\n") }, null, 2)); });
  if (cmd === "imagegen") { const jobs = await loadPromptJobs(args, opts); const { summaryPath } = await runImageJobs(jobs, opts); console.log(summaryPath); if (JSON.parse(readFileSync(summaryPath, "utf8")).failed) process.exitCode = 1; return; }
  if (cmd === "generate") { const context = args.context || args._.join(" "); if (!context.trim()) throw new Error("generate requires --context"); const dirs = pickDirections(asInt(args.variants, 1)); const jobs = dirs.map((d, i) => ({ id: `mockup-${String(i+1).padStart(2,"0")}-${d[0]}`, prompt: uiPrompt({ context, direction: d, mode: "generate" }) })); const { summary } = await runImageJobs(jobs, opts); const gallery = buildGallery(outDir, summary.results, null, "generate"); if (summary.results.length === 1 && summary.results[0].ok) await textWithImages(SPEC_PROMPT, [summary.results[0].finalPath], opts, path.join(outDir, "spec.md")); console.log(`# codex-ui-design generate\n\nGallery: ${gallery}\nSummary: ${path.join(outDir, "summary.json")}`); return; }
  if (cmd === "upgrade") { const target = args.target || args._[0]; if (!target) throw new Error("upgrade requires --target"); if (!/^https?:/.test(target) && !existsSync(target)) throw new Error(`target not found: ${target}`); const before = path.join(outDir, "before.png"); console.error(`[codex-ui-design] screenshot ${target} -> ${before}`); await screenshot(target, before); const dirs = pickDirections(asInt(args.variants, 1)); const jobs = dirs.map((d, i) => ({ id: dirs.length === 1 ? "after" : `after-${String(i+1).padStart(2,"0")}-${d[0]}`, prompt: uiPrompt({ context: args.context || "", direction: d, mode: "upgrade" }), images: [before] })); const { summary } = await runImageJobs(jobs, opts); const gallery = buildGallery(outDir, summary.results, before, "upgrade"); if (summary.results.length === 1 && summary.results[0].ok) await textWithImages(SPEC_PROMPT, [summary.results[0].finalPath], opts, path.join(outDir, "spec.md")); console.log(`# codex-ui-design upgrade\n\nBefore: ${before}\nGallery: ${gallery}\nSummary: ${path.join(outDir, "summary.json")}`); return; }
  if (cmd === "describe") { const img = args.image || args.after || args._[0]; if (!img || !existsSync(img)) throw new Error("describe requires --image <png>"); const p = await textWithImages(SPEC_PROMPT, [img], opts, path.join(outDir, "spec.md")); console.log(`# codex-ui-design describe\n\nSpec: ${p}`); return; }
  if (cmd === "iterate") { const target = args.target || args._[0]; if (!target) throw new Error("iterate requires --target"); if (!args.reference || !existsSync(args.reference)) throw new Error("iterate requires --reference <png>"); const current = path.join(outDir, "current.png"); await screenshot(target, current); const p = await textWithImages("IMAGE 1 is current implementation. IMAGE 2 is approved reference. Write only a surgical Markdown delta spec of residual fixes: type scale, line breaks, density, max-widths, colors, components, casing, image placement. Numeric where possible.", [current, args.reference], opts, path.join(outDir, "delta.md")); console.log(`# codex-ui-design iterate\n\nCurrent: ${current}\nDelta: ${p}`); return; }
  throw new Error(`unknown command: ${cmd}`);
}
main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
