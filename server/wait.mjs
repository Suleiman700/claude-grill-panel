#!/usr/bin/env node
// Waits until the user presses "Send answers" in the panel for a session,
// then prints what they sent and exits. Claude runs this in the background,
// so it is woken up the moment answers arrive instead of polling.
//
//   node wait.mjs --dir <project>/docs/grill-panel --session <id> [--timeout <seconds>]
//
// "Sent" = the answers file's `_round` entry is submitted with a newer time
// than when this started. Exit code 0 = answers arrived, 2 = timed out.

import fs from "node:fs";
import path from "node:path";

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const dir = path.resolve(arg("dir", path.join(process.cwd(), "docs", "grill-panel")));
const id = arg("session", "");
const timeout = Number(arg("timeout", "0"));
if (!SAFE_ID.test(id)) {
	console.error("wait.mjs: --session <id> is required (letters, digits, . _ -)");
	process.exit(1);
}
const file = path.join(dir, "sessions", `${id}.answers.json`);

function read() {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

// The newest answer time at start: everything up to it was already seen.
// (Not just `_round.at`: answers sent in the same request can be a millisecond later.)
const since = Object.values(read()).reduce((m, a) => (a && String(a.at) > m ? String(a.at) : m), "");
const started = Date.now();
console.log(`waiting for answers to "${id}" (sent after ${since || "start"})`);

const timer = setInterval(() => {
	const answers = read();
	const round = answers._round;
	if (round?.submitted && String(round.at) > since) {
		clearInterval(timer);
		// Only what was sent after this started (earlier rounds were already processed).
		const sent = Object.fromEntries(Object.entries(answers).filter(([, a]) => a && a.submitted && String(a.at) > since));
		console.log("ANSWERS SENT");
		console.log(JSON.stringify(sent, null, 2));
		process.exit(0);
	}
	if (timeout > 0 && Date.now() - started > timeout * 1000) {
		clearInterval(timer);
		console.log("TIMED OUT: no answers sent");
		process.exit(2);
	}
}, 1000);
