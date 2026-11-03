#!/usr/bin/env node
// grill-panel server: serves the HTML panel and the session files of one
// project. Node built-in modules only (no npm install).
//
//   node server.mjs --dir <project>/docs/grill-panel [--port 4777]
//
// Files in --dir:
//   sessions/<id>.json          written by Claude: questions, options, decisions
//   sessions/<id>.answers.json  written by this server: what the user picked / typed
// The two never overlap, so Claude and the panel can't overwrite each other.
//
// Binds to 127.0.0.1 only. Session ids are checked against SAFE_ID, so no
// request can reach a file outside --dir.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL = path.join(HERE, "..", "panel");
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_BODY = 1024 * 1024;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const DIR = path.resolve(arg("dir", path.join(process.cwd(), "docs", "grill-panel")));
const SESSIONS = path.join(DIR, "sessions");
let port = Number(arg("port", "4777"));
fs.mkdirSync(SESSIONS, { recursive: true });

// --- helpers -------------------------------------------------------------------

function send(res, code, body, type = "application/json; charset=utf-8") {
	res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
	res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

// Write to a temp file and rename, so a reader never sees half a file.
function writeJson(file, data) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, "\t") + "\n");
	fs.renameSync(tmp, file);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_BODY) {
				reject(new Error("body too large"));
				req.destroy();
			} else chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function sessionFile(id) {
	return path.join(SESSIONS, `${id}.json`);
}

function answersFile(id) {
	return path.join(SESSIONS, `${id}.answers.json`);
}

function listSessions() {
	const out = [];
	for (const f of fs.readdirSync(SESSIONS)) {
		if (!f.endsWith(".json") || f.endsWith(".answers.json")) continue;
		const id = f.slice(0, -5);
		if (!SAFE_ID.test(id)) continue;
		const s = readJson(path.join(SESSIONS, f), null);
		if (!s) continue;
		const qs = Array.isArray(s.questions) ? s.questions : [];
		const count = (st) => qs.filter((q) => q.status === st).length;
		out.push({
			id,
			title: s.title || id,
			status: s.status || "open",
			updated: s.updated || null,
			counts: { waiting: count("waiting"), not_asked: count("not_asked"), decided: count("decided"), total: qs.length },
		});
	}
	out.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
	return out;
}

// --- live updates (Server-Sent Events) ------------------------------------------

const clients = new Set();
let pending = null;
function broadcast(file) {
	clearTimeout(pending);
	pending = setTimeout(() => {
		const msg = `data: ${JSON.stringify({ file, at: Date.now() })}\n\n`;
		for (const c of clients) c.write(msg);
	}, 120);
}
fs.watch(SESSIONS, (_ev, file) => {
	if (file && file.endsWith(".json")) broadcast(file);
});

// --- routes ----------------------------------------------------------------------

async function handle(req, res) {
	const url = new URL(req.url, "http://localhost");
	const parts = url.pathname.split("/").filter(Boolean);

	if (parts[0] !== "api") {
		const name = parts.length ? parts.join("/") : "index.html";
		const file = path.join(PANEL, path.normalize(name));
		if (!file.startsWith(PANEL) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: "not found" });
		return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || "application/octet-stream");
	}

	if (parts[1] === "ping") return send(res, 200, { ok: true, dir: DIR });

	if (parts[1] === "events") {
		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
		res.write(": connected\n\n");
		clients.add(res);
		req.on("close", () => clients.delete(res));
		return;
	}

	if (parts[1] === "sessions" && parts.length === 2 && req.method === "GET") return send(res, 200, listSessions());

	if (parts[1] === "sessions" && parts.length >= 3) {
		const id = parts[2];
		if (!SAFE_ID.test(id)) return send(res, 400, { error: "bad session id" });
		if (!fs.existsSync(sessionFile(id))) return send(res, 404, { error: "no such session" });

		if (parts.length === 3 && req.method === "GET") {
			return send(res, 200, { session: readJson(sessionFile(id), null), answers: readJson(answersFile(id), {}) });
		}

		// POST /api/sessions/<id>/answers  body: { "<question id>": { choice, text } | null, ... }
		// Merges into the answers file; null removes an answer.
		if (parts[3] === "answers" && req.method === "POST") {
			let patch;
			try {
				patch = JSON.parse(await readBody(req));
			} catch {
				return send(res, 400, { error: "bad json" });
			}
			if (!patch || typeof patch !== "object" || Array.isArray(patch)) return send(res, 400, { error: "expected an object" });
			const answers = readJson(answersFile(id), {});
			for (const [qid, a] of Object.entries(patch)) {
				if (!SAFE_ID.test(qid) && qid !== "_round") continue;
				if (a === null) delete answers[qid];
				else if (typeof a === "object") {
					answers[qid] = {
						choice: typeof a.choice === "string" ? a.choice.slice(0, 200) : null,
						text: typeof a.text === "string" ? a.text.slice(0, 20000) : "",
						submitted: a.submitted === true,
						at: new Date().toISOString(),
					};
				}
			}
			writeJson(answersFile(id), answers);
			return send(res, 200, { ok: true });
		}
	}

	return send(res, 404, { error: "not found" });
}

// --- start (an already-running server for this dir is reused) ----------------------

function probe(p) {
	return new Promise((resolve) => {
		const req = http.get({ host: "127.0.0.1", port: p, path: "/api/ping", timeout: 800 }, (r) => {
			let body = "";
			r.on("data", (c) => (body += c));
			r.on("end", () => {
				try {
					resolve(JSON.parse(body));
				} catch {
					resolve({ foreign: true });
				}
			});
		});
		req.on("error", () => resolve(null));
		req.on("timeout", () => {
			req.destroy();
			resolve({ foreign: true });
		});
	});
}

let started = false;
for (let tries = 0; tries < 20 && !started; tries++, port++) {
	const other = await probe(port);
	if (other && other.dir && path.resolve(other.dir) === DIR) {
		console.log(`grill-panel already running: http://localhost:${port}/`);
		process.exit(0);
	}
	if (other) continue; // something else on this port
	const server = http.createServer((req, res) => handle(req, res).catch((e) => send(res, 500, { error: String(e.message || e) })));
	const ok = await new Promise((resolve) => {
		server.once("error", () => resolve(false));
		server.listen(port, "127.0.0.1", () => resolve(true));
	});
	if (ok) {
		console.log(`grill-panel: http://localhost:${port}/  (data: ${DIR})`);
		started = true;
	}
}
if (!started) {
	console.error("grill-panel: no free port found (tried 20 from --port)");
	process.exit(1);
}
