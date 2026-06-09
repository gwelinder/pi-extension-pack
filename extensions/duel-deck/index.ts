/**
 * Duel Deck Extension
 *
 * Parallel UI generation with multiple model × skill combos.
 * The current strategy keeps creative framing inside the system prompt,
 * runs contenders directly in parallel, and enforces a per-contender timeout.
 *
 * Learnings baked in:
 *   - Triple philosophy base: frontend-skill + frontend-design + emil-design-eng
 *   - Too much context or too many instruction blocks lowers visual quality
 *   - Strong creative framing beats slow enrichment when enrichment times out
 *   - frontend-design + emil-design-eng as dual base beats either alone
 */

import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface Contender {
	id: string;
	label: string;
	model: string;
	thinking?: string;
	skills: string[];
}

interface ContenderResult {
	contender: Contender;
	html: string;
	error?: string;
	duration: number;
}

const DEFAULT_CONTENDERS: Contender[] = [
	{
		id: "core",
		label: "Triple Core",
		model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
		thinking: "high",
		skills: ["frontend-skill", "frontend-design", "emil-design-eng", "bolder", "overdrive"],
	},
	{
		id: "refined",
		label: "Triple Refined",
		model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
		thinking: "high",
		skills: ["frontend-skill", "frontend-design", "emil-design-eng", "bolder", "overdrive", "typeset", "polish"],
	},
	{
		id: "full",
		label: "Triple Full",
		model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
		thinking: "high",
		skills: ["frontend-skill", "frontend-design", "emil-design-eng", "bolder", "overdrive", "typeset", "colorize", "arrange", "distill"],
	},
	{
		id: "mega",
		label: "MEGA",
		model: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
		thinking: "high",
		skills: [
			"frontend-skill", "frontend-design", "emil-design-eng",
			"bolder", "overdrive", "typeset", "colorize", "arrange",
			"distill", "animate", "delight", "polish", "make-interfaces-feel-better",
		],
	},
];

const CONTENDER_TIMEOUT_MS = 120_000;
const TIMEOUT_GRACE_MS = 5_000;

function readSkillFile(name: string): string {
	for (const p of [
		path.join(os.homedir(), ".pi", "agent", "skills", name, "SKILL.md"),
		path.join(os.homedir(), ".pi", "agent", "skills-managed", "active", name, "SKILL.md"),
	]) {
		try { return fs.readFileSync(p, "utf-8"); } catch {}
	}
	return `(skill "${name}" not found)`;
}

/**
 * Compress a skill file for injection.
 * Strips: YAML frontmatter, gotchas/auto-generated sections, boilerplate instructions
 *         (MANDATORY PREPARATION, "Use the X skill", "Also load"), long worked examples.
 * Keeps: philosophy, principles, rules, do/don't lists, tables (font recs, color guides,
 *        animation timings, easing curves), short code snippets (CSS values, font stacks).
 * Code blocks under 8 lines are kept (they contain actionable values like easing curves).
 */
function compressSkill(name: string, content: string): string {
	const lines = content.split("\n");
	const kept: string[] = [];
	let inFrontmatter = false;
	let inCodeBlock = false;
	let codeBlockLines: string[] = [];
	let codeBlockStart = "";
	let inGotchas = false;
	let inBoilerplateSection = false;
	let blankRun = 0;

	for (const line of lines) {
		// Skip YAML frontmatter (only at very start of file)
		if (line.trim() === "---") {
			if (!inFrontmatter && kept.length === 0) {
				inFrontmatter = true;
				continue;
			} else if (inFrontmatter) {
				inFrontmatter = false;
				continue;
			}
			// Other --- lines (section breaks) — skip them
			continue;
		}
		if (inFrontmatter) continue;

		// Buffer code blocks — keep short ones (≤8 lines), skip long examples
		if (line.trim().startsWith("```")) {
			if (inCodeBlock) {
				// End of code block — keep if short
				if (codeBlockLines.length <= 8) {
					kept.push(codeBlockStart);
					kept.push(...codeBlockLines);
					kept.push(line);
				}
				codeBlockLines = [];
				inCodeBlock = false;
			} else {
				inCodeBlock = true;
				codeBlockStart = line;
			}
			continue;
		}
		if (inCodeBlock) {
			codeBlockLines.push(line);
			continue;
		}

		// Skip gotchas / auto-generated / worked examples sections
		if (/^#+\s*(gotchas|auto-generated|worked example|full example|complete chain|customization)/i.test(line)) {
			inGotchas = true;
			continue;
		}
		if (inGotchas && /^#+\s/.test(line) && !/gotcha|example|auto-gen|customiz/i.test(line)) {
			inGotchas = false;
		}
		if (inGotchas) continue;

		// Skip boilerplate instruction sections
		if (/^#+\s*(MANDATORY PREPARATION|Propose Before|Iterate with Browser)/i.test(line)) {
			inBoilerplateSection = true;
			continue;
		}
		if (inBoilerplateSection && /^#+\s/.test(line)) {
			inBoilerplateSection = false;
		}
		if (inBoilerplateSection) continue;

		// Skip individual boilerplate lines
		if (/^(Use the frontend-design skill|Also load|See \[.*\]\(|Read the .* skill|Check the .* for)/i.test(line.trim())) continue;
		if (/^>\s*\*\*`/.test(line.trim())) continue;
		if (/^Start your response with:/i.test(line.trim())) continue;
		// Skip the ASCII art banners
		if (/^[─━》⚡]/.test(line.trim())) continue;

		// Collapse multiple blank lines
		if (line.trim() === "") {
			blankRun++;
			if (blankRun <= 1) kept.push("");
			continue;
		}
		blankRun = 0;

		kept.push(line);
	}

	return kept.join("\n").trim();
}

function getPiCmd(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const exe = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exe)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function extractHtml(raw: string): string | null {
	let s = raw.trim();
	const fence = s.match(/```html?\s*\n([\s\S]*?)```/);
	if (fence) s = fence[1].trim();
	const di = s.indexOf("<!DOCTYPE");
	const hi = s.indexOf("<html");
	const start = di >= 0 ? di : hi;
	if (start < 0) return null;
	s = s.slice(start);
	const end = s.lastIndexOf("</html>");
	if (end >= 0) s = s.slice(0, end + 7);
	return s.includes("<html") ? s : null;
}

/** Run a single contender with the task prompt */
async function runContender(
	c: Contender, taskPrompt: string, cwd: string, signal?: AbortSignal,
): Promise<ContenderResult> {
	const start = Date.now();

	const MAX_SKILL_CHARS = 4000; // ~1000 tokens per skill — forces density
	const skillContent = c.skills.map((s) => {
		const raw = readSkillFile(s);
		let compressed = compressSkill(s, raw);
		// Hard cap: take first N chars, cut at last complete line
		if (compressed.length > MAX_SKILL_CHARS) {
			compressed = compressed.slice(0, MAX_SKILL_CHARS);
			const lastNewline = compressed.lastIndexOf("\n");
			if (lastNewline > MAX_SKILL_CHARS * 0.7) compressed = compressed.slice(0, lastNewline);
		}
		return `<skill name="${s}">\n${compressed}\n</skill>`;
	}).join("\n\n");

	const sysPrompt = [
		"You are a design engineer building something you're genuinely proud of.",
		"Forget every dashboard, card grid, or SaaS template. Build something that makes developers jealous.",
		"The layout itself should tell a story — urgent things feel tense, healthy things feel calm.",
		"Make something you'd screenshot and share.",
		"",
		"<design_principles>",
		skillContent,
		"</design_principles>",
		"",
		"Absorb the principles above as instinct, not as a checklist to apply.",
		"",
		"<taste_guardrails>",
		"RESTRAINT IS TASTE. Applying every principle at once produces slop, not craft.",
		"- Animations: 2-3 max. Subtle, purposeful. No gratuitous bounce, pulse, glow, or floating.",
		"- Colors: ONE accent color. Let neutrals do the work. No rainbow, no gradient stacking.",
		"- Typography: ONE distinctive font + ONE mono/system. No more.",
		"- Effects: no blur overlays, no glassmorphism unless it serves function.",
		"- Shadows: layered and soft, or none. Not on everything.",
		"- Layout: ONE bold structural idea. Don't combine 5 layout tricks.",
		"- Content: real data, utility copy. No marketing fluff, no 'Welcome back!' heroes.",
		"- The test: remove all decoration. Does the layout still work? Good.",
		"- The anti-test: looks like every other AI dashboard? Start over.",
		"- SVG craft: use inline SVG for data viz that CSS can't do — animated stroke-dashoffset rings, sparkline polylines with gradient fills, arc progress. Think Stripe-level. Pick 1-2 techniques, not all. Every SVG must encode real data.",
		"</taste_guardrails>",
		"",
		"OUTPUT (non-negotiable):",
		"- Output ONLY a single complete HTML page",
		"- Start with <!DOCTYPE html>, end with </html>",
		"- All CSS in <style>. Google Fonts via <link>.",
		"- Support prefers-color-scheme for light/dark",
		"- NO markdown, NO explanation — just HTML",
		"- Do NOT use tools. Output HTML directly.",
		"",
		"<network>",
		"If API endpoints are provided in the task, include real fetch() calls.",
		"Add a config object at the top of the script: const CONFIG = { apiBase: '...', refreshInterval: 30000 };",
		"Use async/await with try/catch. Show loading states. Auto-refresh on interval.",
		"If fetch fails, fall back to the static data embedded in the page — never show a broken/empty UI.",
		"</network>",
	].join("\n");

	const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-duel-"));
	const sysFile = path.join(tmp, "sys.md");
	await fs.promises.writeFile(sysFile, sysPrompt, "utf-8");

	const args = [
		"--print", "--no-session", "--no-tools",
		"--model", c.model,
		"--append-system-prompt", sysFile,
	];
	if (c.thinking) args.push("--thinking", c.thinking);
	args.push(taskPrompt);

	return new Promise<ContenderResult>((resolve) => {
		const inv = getPiCmd(args);
		const proc = spawn(inv.command, inv.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		let timedOut = false;
		proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
		if (signal) signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });

		// Per-contender timeout: SIGTERM first, then SIGKILL if needed
		let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
		const killTimer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGTERM");
			forceKillTimer = setTimeout(() => {
				try { proc.kill("SIGKILL"); } catch {}
			}, TIMEOUT_GRACE_MS);
		}, CONTENDER_TIMEOUT_MS);

		proc.on("close", (code) => {
			clearTimeout(killTimer);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			const duration = Date.now() - start;
			fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
			const html = extractHtml(stdout);
			if (html) {
				resolve({ contender: c, html, duration });
			} else {
				const reason = timedOut ? `Timeout (${CONTENDER_TIMEOUT_MS / 1000}s)` : `No HTML (exit ${code})`;
				const preview = (stdout || stderr || "No output").slice(0, 500);
				resolve({
					contender: c,
					html: `<!DOCTYPE html><html><head><style>body{margin:0;padding:40px;font-family:'SF Mono',monospace;background:#1a1a1a;color:#f87171}pre{white-space:pre-wrap;font-size:13px;line-height:1.6;color:#a1a1aa;margin-top:16px}</style></head><body><h2 style="font-size:18px">⚠ ${esc(c.label)}</h2><p style="color:#fbbf24;font-size:14px">${esc(reason)}</p><pre>${esc(preview)}</pre></body></html>`,
					error: reason,
					duration,
				});
			}
		});
	});
}

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildViewer(
	task: string, results: ContenderResult[],
	runId: string,
): string {
	const meta = results.map((r) => ({
		id: r.contender.id,
		label: r.contender.label,
		model: r.contender.model,
		skills: r.contender.skills,
		thinking: r.contender.thinking || "off",
		duration: r.duration,
		error: r.error || null,
		file: `${runId}-${r.contender.id}.html`,
	}));

	const cards = results.map((r, i) => {
		const file = `${runId}-${r.contender.id}.html`;
		return `<div class="card" data-idx="${i}" tabindex="0">
<div class="ch">
<div><h2>${esc(r.contender.label)}</h2>
<div class="mdl">${esc(r.contender.skills.length + " skills")} · ${r.contender.thinking}</div>
<div class="skills">${r.contender.skills.map(s => `<span class="stag">${esc(s)}</span>`).join("")}</div></div>
<span class="badge ${r.error ? "err" : "ok"}">${r.error ? "error" : (r.duration / 1000).toFixed(1) + "s"}</span>
</div>
<div class="preview"><iframe src="${file}" sandbox="allow-scripts allow-same-origin" loading="lazy"></iframe></div>
<div class="cf"><span>${r.contender.skills.length} skills</span><span class="hint">Click for full screen · ←→</span></div>
</div>`;
	}).join("\n");

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Duel Deck — ${esc(task.slice(0, 50))}</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0c0c0e;--sf:#151518;--sfh:#1c1c20;--bd:rgba(255,255,255,.07);--bdh:rgba(255,255,255,.14);--tx:#e4e4e7;--td:#71717a;--tm:#52525b;--ac:#a78bfa;--acd:rgba(167,139,250,.15);--gn:#4ade80;--gnd:rgba(74,222,128,.12);--rd:#f87171;--rdd:rgba(248,113,113,.12);--am:#fbbf24;--amd:rgba(251,191,36,.1);--f:'Space Grotesk',system-ui,sans-serif;--m:'JetBrains Mono',monospace;--r:12px}
@media(prefers-color-scheme:light){:root{--bg:#f4f4f5;--sf:#fff;--sfh:#fafafa;--bd:rgba(0,0,0,.08);--bdh:rgba(0,0,0,.15);--tx:#18181b;--td:#71717a;--tm:#a1a1aa;--ac:#7c3aed;--acd:rgba(124,58,237,.1);--gn:#16a34a;--gnd:rgba(22,163,74,.08);--rd:#dc2626;--rdd:rgba(220,38,38,.08);--am:#d97706;--amd:rgba(217,119,6,.08)}}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--f);background:var(--bg);color:var(--tx);min-height:100vh}
.hdr{padding:28px 36px 20px;border-bottom:1px solid var(--bd)}
.hdr h1{font-size:1.4rem;font-weight:700;letter-spacing:-.03em;margin-bottom:4px}
.hdr .tsk{font-size:.82rem;color:var(--td);line-height:1.5;max-width:800px;margin-top:8px}
.hdr .mt{display:flex;gap:14px;margin-top:10px;font-family:var(--m);font-size:.68rem;color:var(--tm)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(460px,1fr));gap:14px;padding:20px 36px 36px}
.card{background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);overflow:hidden;cursor:pointer;transition:border-color .2s,box-shadow .2s,transform .15s}
.card:hover{border-color:var(--bdh);box-shadow:0 8px 32px rgba(0,0,0,.15);transform:translateY(-2px)}
.card:active{transform:translateY(0) scale(.997)}
.ch{padding:14px 18px;border-bottom:1px solid var(--bd);display:flex;justify-content:space-between;align-items:start;gap:10px}
.ch h2{font-size:.85rem;font-weight:600}
.mdl{font-family:var(--m);font-size:.62rem;color:var(--tm);margin-top:3px}
.skills{display:flex;flex-wrap:wrap;gap:3px;margin-top:6px}
.stag{font-family:var(--m);font-size:.55rem;padding:2px 6px;background:var(--acd);color:var(--ac);border-radius:3px}
.badge{font-family:var(--m);font-size:.62rem;padding:3px 8px;border-radius:5px;white-space:nowrap;flex-shrink:0}
.badge.ok{background:var(--gnd);color:var(--gn)}
.badge.err{background:var(--rdd);color:var(--rd)}
.preview{height:420px;background:#111;overflow:hidden}
.preview iframe{width:100%;height:100%;border:none;pointer-events:none;background:#fff}
.cf{padding:8px 18px;border-top:1px solid var(--bd);display:flex;justify-content:space-between;font-size:.68rem;color:var(--tm)}
.hint{font-family:var(--m);font-size:.58rem;opacity:0;transition:opacity .15s}
.card:hover .hint{opacity:1}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:1000;display:none;flex-direction:column;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.overlay.on{display:flex}
.bar{padding:12px 24px;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;border-bottom:1px solid var(--bd);background:var(--sf)}
.bar h2{font-size:.9rem;font-weight:600}
.bar .info{font-family:var(--m);font-size:.6rem;color:var(--tm);margin-top:2px}
.bar .right{display:flex;gap:4px;align-items:center}
.btn{background:var(--sfh);border:1px solid var(--bd);color:var(--td);height:32px;min-width:32px;padding:0 10px;border-radius:7px;cursor:pointer;font-size:.8rem;display:flex;align-items:center;justify-content:center;transition:all .12s;font-family:var(--f)}
.btn:hover{color:var(--tx);border-color:var(--bdh)}
.btn.x:hover{background:var(--rdd);color:var(--rd)}
.btn.open{font-size:.65rem;font-family:var(--m)}
.iframe-wrap{flex:1;overflow:hidden;background:#fff}
.iframe-wrap iframe{width:100%;height:100%;border:none}
.counter{font-family:var(--m);font-size:.65rem;color:var(--tm);padding:0 8px}
@media(max-width:600px){.grid{grid-template-columns:1fr;padding:12px}.hdr{padding:16px 12px}}
</style>
</head>
<body>
<div class="hdr">
<h1>⚔️ Duel Deck</h1>
<div class="tsk">${esc(task)}</div>
<div class="mt"><span>${results.length} contenders</span><span>${results.filter(r => !r.error).length} succeeded</span><span>${new Date().toISOString().slice(0, 16).replace("T", " ")}</span></div>
</div>
<div class="grid">${cards}</div>
<div class="overlay" id="ov">
<div class="bar">
<div><h2 id="mt"></h2><div class="info" id="mi2"></div></div>
<div class="right">
<button class="btn open" id="ob" title="Open in new tab">Open ↗</button>
<button class="btn" onclick="nav(-1)" title="Previous ←">←</button>
<span class="counter" id="ct"></span>
<button class="btn" onclick="nav(1)" title="Next →">→</button>
<button class="btn x" onclick="close_()" title="Close Esc">✕</button>
</div>
</div>
<div class="iframe-wrap"><iframe id="mf" sandbox="allow-scripts allow-same-origin"></iframe></div>
</div>
<script>
var M=${JSON.stringify(meta)};var ci=-1;
document.querySelectorAll('.card').forEach(function(c){
c.addEventListener('click',function(){om(parseInt(c.dataset.idx))});
c.addEventListener('keydown',function(e){if(e.key==='Enter')om(parseInt(c.dataset.idx))});
});
function om(i){ci=i;var c=M[i];
document.getElementById('mt').textContent=c.label;
document.getElementById('mi2').textContent=c.skills.join(' + ')+' · '+(c.error?'Error':(c.duration/1000).toFixed(1)+'s');
document.getElementById('mf').src=c.file;
document.getElementById('ct').textContent=(i+1)+'/'+M.length;
document.getElementById('ob').onclick=function(){window.open(c.file,'_blank')};
document.getElementById('ov').classList.add('on');document.body.style.overflow='hidden'}
function close_(){document.getElementById('ov').classList.remove('on');document.body.style.overflow='';document.getElementById('mf').src='about:blank';ci=-1}
function nav(d){if(ci>=0)om((ci+d+M.length)%M.length)}
document.addEventListener('keydown',function(e){if(ci>=0){if(e.key==='Escape')close_();else if(e.key==='ArrowRight')nav(1);else if(e.key==='ArrowLeft')nav(-1)}});
document.getElementById('ov').addEventListener('click',function(e){if(e.target===document.getElementById('ov'))close_()});
</script>
</body>
</html>`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "duel_deck",
		label: "Duel Deck",
		description: "Run the same UI task through multiple model×skill combos in parallel. Each contender generates a complete HTML page. Results are presented in a custom comparison viewer with full-screen modal inspection. Default: 4 Kimi K2.5 variants with different design skill loadouts.",
		parameters: Type.Object({
			task: Type.String({ description: "The UI generation task — describe what to build, the context, content, and constraints" }),
			contenders: Type.Optional(Type.Array(Type.Object({
				id: Type.String({ description: "Short identifier" }),
				label: Type.String({ description: "Display label" }),
				model: Type.String({ description: "Model in provider/model format" }),
				thinking: Type.Optional(Type.String({ description: "Thinking level" })),
				skills: Type.Array(Type.String(), { description: "Skill names to load" }),
			}), { description: "Override default contenders" })),
		}),
		promptGuidelines: [
			"Use duel_deck when the user wants to compare how different models or skill loadouts approach the same UI task.",
			"The task should describe the UI to build with enough detail for standalone generation.",
			"Default contenders are 4 Kimi K2.5 Turbo variants with different design skill combos.",
			"Override contenders to use different models or skills.",
		],
		async execute(_toolCallId, params, signal, onUpdate) {
			const contenders = params.contenders ?? DEFAULT_CONTENDERS;
			const cwd = process.cwd();
			const dir = path.join(os.homedir(), ".agent", "duel-decks");
			await fs.promises.mkdir(dir, { recursive: true });
			const runId = Date.now().toString(36);

			const taskForContenders = params.task;

			onUpdate({
				content: [{ type: "text", text: `⚔️ Dispatching ${contenders.length} contenders... (${CONTENDER_TIMEOUT_MS / 1000}s timeout each)` }],
				details: { phase: "dispatch" },
			});

			// Phase 2: Run contenders in parallel
			const startTimes = new Map<string, number>();
			const limit = Math.min(4, contenders.length);
			const results: ContenderResult[] = new Array(contenders.length);
			let nextIdx = 0;
			let done = 0;

			function progress() {
				const now = Date.now();
				const lines = contenders.map((c, i) => {
					if (results[i]) {
						const d = (results[i].duration / 1000).toFixed(1);
						return results[i].error ? `  ❌ ${c.label} (${d}s)` : `  ✅ ${c.label} (${d}s)`;
					}
					const elapsed = startTimes.has(c.id) ? ((now - startTimes.get(c.id)!) / 1000).toFixed(0) : "—";
					return `  ⏳ ${c.label} (${elapsed}s)`;
				});
				onUpdate({
					content: [{
						type: "text",
						text: `⚔️ Phase 2: ${done}/${contenders.length} complete\n${lines.join("\n")}`,
					}],
					details: { phase: done === contenders.length ? "done" : "generating", done },
				});
			}

			progress();

			// Live timer: update elapsed times every 5s so user sees movement
			const progressInterval = setInterval(() => {
				if (done < contenders.length) progress();
			}, 5_000);

			const workers = new Array(limit).fill(null).map(async () => {
				while (true) {
					const idx = nextIdx++;
					if (idx >= contenders.length) return;
					const c = contenders[idx];
					startTimes.set(c.id, Date.now());
					progress();
					results[idx] = await runContender(c, taskForContenders, cwd, signal);
					done++;
					await fs.promises.writeFile(
						path.join(dir, `${runId}-${c.id}.html`), results[idx].html, "utf-8",
					);
					progress();
				}
			});
			await Promise.all(workers);
			clearInterval(progressInterval);

			// Save task brief
			await fs.promises.writeFile(
				path.join(dir, `${runId}-brief.md`), taskForContenders, "utf-8",
			);

			// Build and open viewer
			const viewerHtml = buildViewer(params.task, results, runId);
			const viewerPath = path.join(dir, `${runId}-viewer.html`);
			await fs.promises.writeFile(viewerPath, viewerHtml, "utf-8");

			try {
				execSync(process.platform === "darwin" ? `open "${viewerPath}"` : `xdg-open "${viewerPath}"`);
			} catch {}

			const ok = results.filter((r) => !r.error).length;
			const maxT = Math.max(...results.map((r) => r.duration));

			return {
				content: [{
					type: "text",
					text: [
						`## ⚔️ Duel Deck Complete`,
						"",
						`**Contenders:** ${ok}/${results.length} succeeded in ${(maxT / 1000).toFixed(1)}s`,
						"",
						...results.map((r) => {
							const s = r.error ? `❌` : `✅ ${(r.duration / 1000).toFixed(1)}s`;
							return `- **${r.contender.label}** (${r.contender.skills.length} skills): ${s}`;
						}),
						"",
						`Viewer: \`${viewerPath}\``,
						`Brief: \`${path.join(dir, runId + "-brief.md")}\``,
					].join("\n"),
				}],
				details: { runId, viewerPath, contenderTimeoutMs: CONTENDER_TIMEOUT_MS },
			};
		},
	});

	pi.registerCommand("duel", {
		description: "Run a duel deck — multiple model×skill combos generate UI ideas in parallel", 
		handler: async (args, ctx) => {
			if (!args?.trim()) {
				ctx.ui.notify("Usage: /duel <describe the UI to build>", "warn");
				return;
			}
			pi.sendUserMessage(`Use the duel_deck tool with this task: ${args}`, { deliverAs: "followUp" });
		},
	});
}
