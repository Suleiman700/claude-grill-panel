// grill-panel: shows a grilling session's questions, options and decisions,
// and saves the user's answers through the local server (server/server.mjs).
// Answers are saved as you type (drafts), so a refresh never loses them; if
// the server is unreachable they wait in localStorage and are sent when it's
// back. "Send answers" marks them submitted, which is what Claude acts on.

const $ = (sel) => document.querySelector(sel);

const state = {
	sessions: [],
	id: null,
	session: null,
	answers: {}, // from the server
	drafts: {}, // qid -> { choice, text, submitted, dirty, at }
	filter: "open",
	search: "",
	live: false,
	drawer: [], // question ids opened in the side panel; the last one is shown
};

const FILTERS = [
	["open", "To answer", (q) => q.status === "waiting" || q.status === "answered"],
	["unsent", "Not sent", (q) => UNSENT.has(answerState(q))],
	["not_asked", "Not asked yet", (q) => q.status === "not_asked"],
	["decided", "Decided", (q) => ["decided", "deferred", "dropped"].includes(q.status)],
	["all", "All", () => true],
];

// Where a question stands for the user: an icon plus a word, so the state never
// depends on colour alone (the colour class only reinforces it).
const MARKS = {
	open: ["○", "not answered", "m-open"],
	draft: ["✎", "saved, not sent", "m-draft"],
	missing: ["!", "needs text", "m-missing"],
	sent: ["✓", "answered", "m-done"],
	change_sent: ["✓", "change sent", "m-done"],
	decided: ["✓", "decided", "m-done"],
	deferred: ["–", "deferred", "m-muted"],
	dropped: ["✕", "dropped", "m-muted"],
	not_asked: ["◌", "not asked", "m-muted"],
};
const UNSENT = new Set(["draft", "missing"]);
const LEGEND = ["sent", "draft", "missing", "open"];

// --- storage (all wrapped: private windows can throw) ---------------------------

function store(key, value) {
	try {
		if (value === undefined) localStorage.removeItem(key);
		else localStorage.setItem(key, JSON.stringify(value));
	} catch {}
}
function load(key, fallback) {
	try {
		const v = localStorage.getItem(key);
		return v === null ? fallback : JSON.parse(v);
	} catch {
		return fallback;
	}
}

// --- markdown (small subset, escaped first) ----------------------------------------

function esc(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function inline(s) {
	return esc(s)
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
		.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function md(text) {
	const lines = String(text ?? "").replace(/\r/g, "").split("\n");
	let html = "";
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			i++;
			continue;
		}
		if (/^\s*\|/.test(line)) {
			const rows = [];
			while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
			const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
			const body = rows.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
			html += "<table>" + body.map((r, ri) => "<tr>" + cells(r).map((c) => (ri === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join("") + "</tr>").join("") + "</table>";
			continue;
		}
		const bullet = /^\s*[-*]\s+/;
		const num = /^\s*\d+[.)]\s+/;
		if (bullet.test(line) || num.test(line)) {
			const ordered = num.test(line);
			const re = ordered ? num : bullet;
			const items = [];
			while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ""));
			html += (ordered ? "<ol>" : "<ul>") + items.map((t) => `<li>${inline(t)}</li>`).join("") + (ordered ? "</ol>" : "</ul>");
			continue;
		}
		const para = [];
		while (i < lines.length && lines[i].trim() && !bullet.test(lines[i]) && !num.test(lines[i]) && !/^\s*\|/.test(lines[i])) para.push(lines[i++]);
		html += `<p>${para.map(inline).join("<br>")}</p>`;
	}
	return html;
}

// Question ids in rendered text (Q1, Q1a, N2) become buttons that open that question
// in the side panel. Only ids that exist in the session; tags and link text are left alone.
function linkRefs(html, self) {
	const ids = new Set(questions().map((q) => q.id));
	let inLink = 0;
	return html.replace(/(<[^>]*>)|([^<]+)/g, (_m, tag, text) => {
		if (tag) {
			if (/^<a[\s>]/i.test(tag)) inLink++;
			else if (/^<\/a>/i.test(tag)) inLink--;
			return tag;
		}
		if (inLink) return text;
		return text.replace(/\b[A-Za-z]\d+[a-z]*\b/g, (id) => (ids.has(id) && id !== self ? refBtn(id) : id));
	});
}
function refBtn(id) {
	return `<button type="button" class="qref" data-ref="${esc(id)}" title="Open ${esc(id)}">${esc(id)}</button>`;
}
function rich(text, self) {
	return linkRefs(inline(text), self);
}
function richMd(text, self) {
	return linkRefs(md(text), self);
}

// --- server --------------------------------------------------------------------------

async function api(path, opts) {
	const r = await fetch(path, opts);
	if (!r.ok) throw new Error(`${r.status}`);
	return r.json();
}

async function loadSessions() {
	state.sessions = await api("/api/sessions");
	renderSessions();
}

async function loadSession(id) {
	const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
	state.session = data.session;
	state.answers = data.answers || {};
	mergeDrafts();
	render();
}

// Server answers fill the drafts, except where the user has unsaved edits.
// Offline edits from localStorage win if they're newer than the server's.
function mergeDrafts() {
	const local = load(`grill:${state.id}:drafts`, {});
	const next = {};
	for (const [qid, a] of Object.entries(state.answers)) next[qid] = { ...a, dirty: false };
	for (const [qid, d] of Object.entries(local)) {
		const server = state.answers[qid];
		if (!server || String(d.at) > String(server.at)) next[qid] = { ...d, dirty: true };
	}
	for (const [qid, d] of Object.entries(state.drafts)) if (d.dirty) next[qid] = d;
	state.drafts = next;
	if (Object.values(next).some((d) => d.dirty)) scheduleSave();
}

let saveTimer = null;
function scheduleSave(delay = 500) {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(saveDrafts, delay);
}

async function saveDrafts() {
	const dirty = Object.entries(state.drafts).filter(([, d]) => d.dirty);
	if (!dirty.length || !state.id) return;
	const patch = {};
	for (const [qid, d] of dirty) patch[qid] = { choice: d.choice ?? null, text: d.text ?? "", submitted: !!d.submitted };
	const localKey = `grill:${state.id}:drafts`;
	try {
		await api(`/api/sessions/${encodeURIComponent(state.id)}/answers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
		for (const [qid, d] of dirty) if (state.drafts[qid] === d) d.dirty = false; // unchanged while saving
		// Drop only what was sent: anything typed during the request stays queued.
		const local = load(localKey, {});
		for (const [qid, d] of dirty) if (local[qid] && local[qid].at === d.at) delete local[qid];
		store(localKey, Object.keys(local).length ? local : undefined);
		markSaved("Saved, not sent yet");
	} catch {
		const local = load(localKey, {});
		for (const [qid, d] of dirty) local[qid] = { ...d, at: new Date().toISOString() };
		store(localKey, local);
		markSaved("Offline: kept in this browser, will sync");
		scheduleSave(3000);
	}
}

function markSaved(text) {
	document.querySelectorAll(".saved[data-pending]").forEach((el) => {
		el.textContent = text;
		el.removeAttribute("data-pending");
	});
}

// --- live updates ----------------------------------------------------------------------

function connect() {
	const es = new EventSource("/api/events");
	es.onopen = () => setLive(true);
	es.onerror = () => setLive(false);
	es.onmessage = async (ev) => {
		const { file } = JSON.parse(ev.data);
		loadSessions().catch(() => {});
		if (state.id && file && file.startsWith(state.id + ".")) loadSession(state.id).catch(() => {});
	};
}

function setLive(on) {
	if (state.live === on) return;
	state.live = on;
	const el = $("#conn");
	el.textContent = on ? "live" : "offline: answers kept here";
	el.className = "conn " + (on ? "live" : "off");
	if (on) {
		loadSessions().catch(() => {});
		if (state.id) loadSession(state.id).catch(() => {});
	}
}

// --- rendering ---------------------------------------------------------------------------

function renderSessions() {
	const ul = $("#sessions");
	ul.innerHTML = "";
	if (!state.sessions.length) {
		ul.innerHTML = '<li class="muted" style="padding:0 8px">No sessions yet. Claude creates one when grilling starts.</li>';
		return;
	}
	for (const s of state.sessions) {
		const li = document.createElement("li");
		const b = document.createElement("button");
		b.className = s.id === state.id ? "active" : "";
		b.innerHTML = `<span class="s-title">${esc(s.title)}</span><span class="s-meta">${s.status === "done" ? "done · " : ""}${s.counts.waiting} to answer · ${s.counts.decided} decided · ${s.counts.not_asked} not asked</span>`;
		b.onclick = () => openSession(s.id);
		li.appendChild(b);
		ul.appendChild(li);
	}
	if (!state.id) {
		const last = load("grill:last", null);
		openSession(state.sessions.some((s) => s.id === last) ? last : state.sessions[0].id);
	}
}

function openSession(id) {
	if (state.id === id && state.session) return;
	state.id = id;
	state.session = null;
	state.drafts = {};
	state.drawer = [];
	renderDrawer();
	store("grill:last", id);
	const url = new URL(location.href);
	url.searchParams.set("session", id);
	history.replaceState(null, "", url);
	$("#sidebar").classList.remove("open");
	renderSessions();
	loadSession(id).catch(() => toast("Couldn't load that session"));
}

function naturalId(a, b) {
	return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
}

function questions() {
	return Array.isArray(state.session?.questions) ? state.session.questions : [];
}

function decidedIds() {
	return new Set(questions().filter((q) => q.status === "decided" || q.status === "deferred").map((q) => q.id));
}

function render() {
	const s = state.session;
	if (!s) return;
	// Keep the caret where it was if a re-render happens while typing.
	const active = document.activeElement;
	const focusKey = active?.dataset?.key;
	const sel = focusKey && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;

	document.title = `${s.title || "Session"} · Grill Panel`;
	$("#title").textContent = s.title || s.id;
	$("#topic").textContent = s.topic || "";
	const summary = $("#summary");
	summary.hidden = !s.summary;
	summary.innerHTML = s.summary ? `<h2>Shared understanding so far</h2><div class="body">${richMd(s.summary)}</div>` : "";

	const qs = questions();
	const filters = $("#filters");
	filters.innerHTML = "";
	for (const [key, label, test] of FILTERS) {
		const b = document.createElement("button");
		b.className = key === state.filter ? "active" : "";
		b.innerHTML = `${esc(label)}<span class="n">${qs.filter(test).length}</span>`;
		b.onclick = () => {
			state.filter = key;
			store("grill:filter", key);
			render();
		};
		filters.appendChild(b);
	}

	const test = FILTERS.find((f) => f[0] === state.filter)[2];
	const term = state.search.trim().toLowerCase();
	const visible = qs.filter(test).filter((q) => !term || `${q.id} ${q.title} ${q.body} ${q.group} ${q.decision}`.toLowerCase().includes(term));

	const content = $("#content");
	content.innerHTML = "";
	$("#empty").hidden = visible.length > 0;

	// Sections in a fixed order; follow-ups sit under their parent.
	const sections = [
		["To answer", (q) => q.status === "waiting" || q.status === "answered"],
		["Not asked yet", (q) => q.status === "not_asked"],
		["Decided", (q) => q.status === "decided"],
		["Deferred", (q) => q.status === "deferred"],
		["Dropped", (q) => q.status === "dropped"],
	];
	const shown = new Set();
	for (const [title, inSection] of sections) {
		const list = visible.filter(inSection).sort(naturalId);
		if (!list.length) continue;
		const sec = document.createElement("section");
		sec.className = "section";
		sec.innerHTML = `<h2>${esc(title)} <span class="n">${list.length}</span></h2>`;
		let group = null;
		const roots = list.filter((q) => !q.parent || !list.some((p) => p.id === q.parent));
		for (const q of roots) {
			if ((q.group || "") !== group) {
				group = q.group || "";
				if (group) sec.insertAdjacentHTML("beforeend", `<h3 class="group-title">${esc(group)}</h3>`);
			}
			sec.appendChild(card(q));
			shown.add(q.id);
			for (const f of list.filter((c) => c.parent === q.id)) {
				sec.appendChild(card(f, true));
				shown.add(f.id);
			}
		}
		content.appendChild(sec);
	}

	if (state.filter === "open" && visible.length) content.appendChild(roundNote());
	const unsent = qs.filter((q) => UNSENT.has(answerState(q))).length;
	$("#send").textContent = unsent ? `Send answers (${unsent})` : "Send answers";
	renderDrawer();

	if (focusKey) {
		const el = document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
		if (el) {
			el.focus();
			if (sel && "setSelectionRange" in el) el.setSelectionRange(sel[0], sel[1]);
		}
	}
}

function card(q, isFollowup = false) {
	const el = document.createElement("article");
	el.className = `card ${q.status}${isFollowup ? " followup" : ""}`;
	let badge = mark(answerState(q));
	if (q.status === "not_asked" && (q.depends_on || []).length && q.depends_on.every((id) => decidedIds().has(id))) badge += '<span class="badge ready">ready to ask</span>';

	let html = `<div class="card-head"><button type="button" class="qid" data-ref="${esc(q.id)}" title="Open ${esc(q.id)} in the side panel">${esc(q.id)}</button><h3>${rich(q.title || "", q.id)}</h3>${badge}</div>`;
	html += questionDetails(q, false);
	el.innerHTML = html;

	if (q.status === "waiting" || q.status === "answered") el.appendChild(answerControls(q));
	else if (q.status === "not_asked") el.appendChild(commentBox(q));
	else if (isSettled(q)) el.insertAdjacentHTML("beforeend", `<div class="card-actions"><button type="button" class="btn small" data-ref="${esc(q.id)}">Change or ask Claude</button></div>`);
	return el;
}

// Body, notes, options, recommendation, decision and links: shared by the card and the side panel.
function questionDetails(q, full) {
	let html = "";
	if (q.body) html += `<div class="body">${richMd(q.body, q.id)}</div>`;
	if (q.notes) html += `<div class="body muted">${richMd(q.notes, q.id)}</div>`;
	const editable = q.status === "waiting" || q.status === "answered" || (full && isSettled(q));
	if (q.options?.length && !editable) {
		html += `<div class="body"><ul>${q.options.map((o) => `<li><strong>${esc(o.label)}</strong>${o.description ? ` – ${rich(o.description, q.id)}` : ""}${o.id === q.recommended ? " ★" : ""}</li>`).join("")}</ul></div>`;
	}
	if (q.recommended_text && q.status !== "decided") html += `<div class="rec">➡️ ${rich(q.recommended_text, q.id)}</div>`;
	if (q.decision) html += `<div class="decision"><strong>${q.status === "deferred" ? "Deferred" : "Decided"}:</strong> ${rich(q.decision, q.id)}</div>`;
	const links = [];
	if (q.parent) links.push(["Follow-up of", [q.parent]]);
	if (q.depends_on?.length) links.push(["Depends on", q.depends_on]);
	if (full) {
		if (q.followups?.length) links.push(["Follow-ups", q.followups]);
		const needed = questions().filter((x) => (x.depends_on || []).includes(q.id)).map((x) => x.id);
		if (needed.length) links.push(["Needed by", needed]);
	}
	for (const [label, ids] of links) html += `<div class="deps">${label}: ${ids.map((id) => (questions().some((x) => x.id === id) ? refBtn(id) : esc(id))).join(" ")}</div>`;
	return html;
}

function isSettled(q) {
	return q.status === "decided" || q.status === "deferred";
}

// A decided question's answer entry is a change request only if it is newer than
// the decision (older entries are the record of the answer that decided it).
function pendingChange(q) {
	const d = state.drafts[q.id];
	if (!hasAnswer(d)) return null;
	return !d.submitted || d.dirty || String(d.at) > String(q.decided_at || "") ? d : null;
}

function hasAnswer(d) {
	return !!d && !!(d.choice || (d.text || "").trim());
}

// "Something else" means nothing without the text that says what.
function needsText(d) {
	return !!d && d.choice === "other" && !(d.text || "").trim();
}

function isSent(d) {
	return d.submitted && !d.dirty;
}

// One of the MARKS keys.
function answerState(q) {
	const d = state.drafts[q.id];
	if (q.status === "waiting" || q.status === "answered") {
		if (!hasAnswer(d)) return "open";
		return needsText(d) ? "missing" : isSent(d) ? "sent" : "draft";
	}
	if (isSettled(q)) {
		const c = pendingChange(q);
		if (!c) return q.status;
		return needsText(c) ? "missing" : isSent(c) ? "change_sent" : "draft";
	}
	if (q.status === "not_asked" && hasAnswer(d) && !isSent(d)) return "draft";
	return MARKS[q.status] ? q.status : "open";
}

function mark(key) {
	const [icon, word, cls] = MARKS[key];
	return `<span class="mark ${cls}"><span class="mark-icon" aria-hidden="true">${icon}</span>${word}</span>`;
}

function setDraft(qid, change) {
	const prev = state.drafts[qid] || { choice: null, text: "" };
	state.drafts[qid] = { ...prev, ...change, submitted: false, dirty: true, at: new Date().toISOString() };
	// Also kept in the browser at once: a refresh before the save goes out loses nothing.
	const localKey = `grill:${state.id}:drafts`;
	const local = load(localKey, {});
	local[qid] = state.drafts[qid];
	store(localKey, local);
	document.querySelectorAll(`.saved[data-q="${CSS.escape(qid)}"]`).forEach((s) => {
		s.textContent = "Saving…";
		s.setAttribute("data-pending", "");
	});
	scheduleSave();
}

// `prefix` keeps the side panel's copy of the controls apart from the card's
// (radio groups and the focus key that survives a re-render).
function answerControls(q, prefix = "") {
	const wrap = document.createElement("div");
	wrap.className = "answer";
	const d = state.drafts[q.id] || {};

	if (q.options?.length) {
		const choices = document.createElement("div");
		choices.className = "choices";
		for (const o of [...q.options, { id: "other", label: "Something else", description: "Explain in the box below." }]) {
			const label = document.createElement("label");
			label.className = "choice" + (d.choice === o.id ? " checked" : "");
			label.innerHTML = `<input type="radio" name="${prefix}c-${esc(q.id)}" value="${esc(o.id)}" ${d.choice === o.id ? "checked" : ""}><span><span class="c-label">${esc(o.label)}${o.id === q.recommended ? '<span class="star">★ recommended</span>' : ""}</span>${o.description ? `<span class="c-desc">${rich(o.description, q.id)}</span>` : ""}</span>`;
			label.querySelector("input").onchange = () => {
				setDraft(q.id, { choice: o.id });
				render();
			};
			choices.appendChild(label);
		}
		wrap.appendChild(choices);
	} else {
		const yn = document.createElement("div");
		yn.className = "yesno";
		for (const [val, text] of [["yes", "Yes (accept ➡️)"], ["no", "No"], ["other", "Something else"]]) {
			const b = document.createElement("button");
			b.type = "button";
			b.textContent = text;
			b.className = d.choice === val ? "on" : "";
			b.onclick = () => {
				setDraft(q.id, { choice: d.choice === val ? null : val });
				render();
			};
			yn.appendChild(b);
		}
		wrap.appendChild(yn);
	}

	const ta = document.createElement("textarea");
	ta.value = d.text || "";
	ta.dataset.key = `${prefix}t-${q.id}`;
	const need = document.createElement("div");
	need.className = "need";
	need.innerHTML = '<span class="mark-icon" aria-hidden="true">!</span>Required: you picked "Something else", so write your answer here.';
	need.id = `${prefix}need-${q.id}`;
	const check = () => {
		const on = needsText(state.drafts[q.id]);
		const other = state.drafts[q.id]?.choice === "other";
		ta.placeholder = other ? "Your answer (required for Something else)" : "Conditions, your own answer, or a follow-up question for Claude (optional)";
		ta.required = other;
		ta.classList.toggle("required", on);
		ta.setAttribute("aria-invalid", String(on));
		on ? ta.setAttribute("aria-describedby", need.id) : ta.removeAttribute("aria-describedby");
		need.hidden = !on;
	};
	ta.oninput = () => {
		const before = answerState(q);
		setDraft(q.id, { text: ta.value });
		// Re-render only when the question's mark changes (e.g. "needs text" -> "saved, not sent").
		if (answerState(q) !== before) render();
		else check();
	};
	wrap.appendChild(ta);
	wrap.appendChild(need);
	check();
	wrap.appendChild(savedLine(q.id, d));
	return wrap;
}

function savedLine(qid, d) {
	const saved = document.createElement("div");
	saved.className = "saved";
	saved.dataset.q = qid;
	saved.textContent = d.at ? (isSent(d) ? `Sent ${time(d.at)}` : `Saved ${time(d.at)}, not sent yet`) : "";
	return saved;
}

// Not-asked questions: a box to answer early or comment. (Decided ones are changed in the side panel.)
function commentBox(q, prefix = "") {
	const wrap = document.createElement("details");
	wrap.className = "answer";
	const d = state.drafts[q.id] || {};
	wrap.open = !!d.text || !!prefix;
	wrap.innerHTML = '<summary class="muted">Answer early or comment</summary>';
	const ta = document.createElement("textarea");
	ta.placeholder = "Your answer or thoughts, if you already know";
	ta.value = d.text || "";
	ta.dataset.key = `${prefix}t-${q.id}`;
	ta.oninput = () => {
		const before = answerState(q);
		setDraft(q.id, { choice: "early", text: ta.value });
		if (answerState(q) !== before) render();
	};
	wrap.appendChild(ta);
	wrap.appendChild(savedLine(q.id, d));
	return wrap;
}

function roundNote() {
	const box = document.createElement("div");
	box.className = "round-note";
	const d = state.drafts._round || {};
	box.innerHTML = "<h3>Anything else for this round?</h3>";
	const ta = document.createElement("textarea");
	ta.placeholder = "General comments, new ideas, questions Claude missed…";
	ta.value = d.text || "";
	ta.dataset.key = "t-_round";
	ta.oninput = () => setDraft("_round", { choice: "comment", text: ta.value });
	box.appendChild(ta);
	return box;
}

// --- side panel: one question in full, opened by clicking its id anywhere -------------------

// From inside the side panel a click stacks (so Back returns); from the page it starts fresh.
function openRef(id, stack) {
	if (!questions().some((q) => q.id === id)) return;
	state.drawer = stack ? [...state.drawer, id] : [id];
	renderDrawer();
}

function closeDrawer() {
	state.drawer = [];
	renderDrawer();
}

function renderDrawer() {
	const box = $("#drawer");
	const q = questions().find((x) => x.id === state.drawer[state.drawer.length - 1]);
	box.hidden = !q;
	document.body.classList.toggle("drawer-open", !!q);
	if (!q) {
		delete box.dataset.q;
		return;
	}
	box.style.top = `${$(".top").offsetHeight}px`;
	const scroll = box.dataset.q === q.id ? box.scrollTop : 0;
	box.dataset.q = q.id;

	const back = state.drawer[state.drawer.length - 2];
	let html = '<div class="drawer-head">';
	if (back) html += `<button type="button" class="x-btn" data-act="back" title="Back to ${esc(back)}" aria-label="Back to ${esc(back)}">←</button>`;
	html += `<span class="qid">${esc(q.id)}</span>${mark(answerState(q))}`;
	html += '<button type="button" class="x-btn" data-act="close" title="Close (Esc)" aria-label="Close">×</button></div>';
	if (q.group) html += `<div class="group-title">${esc(q.group)}</div>`;
	html += `<h3 class="drawer-title">${rich(q.title || "", q.id)}</h3>`;
	html += questionDetails(q, true);

	const qa = Array.isArray(q.qa) ? q.qa : [];
	if (qa.length) {
		html += "<h4>Your questions and Claude's answers</h4>";
		for (const x of qa) html += `<div class="qa"><div class="qa-q"><strong>You:</strong> ${rich(x.q || "", q.id)}</div><div class="body">${richMd(x.a || "", q.id)}</div></div>`;
	}
	box.innerHTML = html;

	if (q.status === "waiting" || q.status === "answered") {
		box.insertAdjacentHTML("beforeend", "<h4>Your answer</h4>");
		box.appendChild(answerControls(q, "d-"));
	} else if (isSettled(q)) {
		box.insertAdjacentHTML("beforeend", '<h4>Change the answer or ask Claude</h4><p class="hint">Pick a different option to change the decision; Claude re-opens it and checks the questions that depend on it. A question typed in the box gets an answer above.</p>');
		box.appendChild(answerControls(q, "d-"));
	} else if (q.status === "not_asked") {
		box.appendChild(commentBox(q, "d-"));
	} else {
		box.scrollTop = scroll;
		return; // dropped: nothing to answer
	}

	const foot = document.createElement("div");
	foot.className = "drawer-foot";
	foot.innerHTML = '<button type="button" class="btn">Save</button><button type="button" class="btn primary">Send to Claude</button>';
	const [save, send] = foot.querySelectorAll("button");
	save.onclick = saveNow;
	send.onclick = () => sendAnswers(true);
	box.appendChild(foot);
	box.scrollTop = scroll;
}

function time(iso) {
	try {
		return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	} catch {
		return "";
	}
}

function toast(text) {
	const t = $("#toast");
	t.textContent = text;
	t.hidden = false;
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => (t.hidden = true), 3200);
}

// --- send / copy -----------------------------------------------------------------------------

function answeredDrafts() {
	const ids = new Set(questions().map((q) => q.id));
	return Object.entries(state.drafts).filter(([qid, d]) => ids.has(qid) && hasAnswer(d));
}

// Save now instead of waiting for the typing pause. Nothing goes to Claude:
// saved answers wait under "Not sent" until Send.
async function saveNow() {
	clearTimeout(saveTimer);
	await saveDrafts();
	render();
	const n = questions().filter((q) => UNSENT.has(answerState(q))).length;
	toast(state.live ? `Saved. ${n} not sent to Claude yet.` : "Saved in this browser; it syncs when the server is back");
}

// From the side panel (`quiet`), a change or a question is sent on its own,
// without the reminder about open questions that have no answer yet.
async function sendAnswers(quiet = false) {
	if (!state.session) return;
	const missing = questions().filter((q) => answerState(q) === "missing");
	if (missing.length) {
		openRef(missing[0].id, false);
		return toast(`Write your answer for "Something else" first: ${missing.map((q) => q.id).join(", ")}`);
	}
	const list = answeredDrafts().filter(([, d]) => !isSent(d));
	const round = state.drafts._round;
	if (!list.length && !(round && (round.text || "").trim())) return toast("Nothing new to send");
	const open = questions().filter((q) => q.status === "waiting").length;
	const answeredOpen = list.filter(([qid]) => questions().find((q) => q.id === qid && q.status === "waiting")).length;
	if (!quiet && answeredOpen < open && !confirm(`${open - answeredOpen} of ${open} open questions have no answer. Send anyway?`)) return;
	const now = new Date().toISOString();
	for (const [qid] of list) state.drafts[qid] = { ...state.drafts[qid], submitted: true, dirty: true, at: now };
	state.drafts._round = { ...(round || {}), choice: "submit", submitted: true, dirty: true, at: now };
	await saveDrafts();
	render();
	toast(state.live ? "Sent. Claude picks it up now." : "Saved here; it will be sent when the server is back");
}

async function copyAnswers() {
	const qs = new Map(questions().map((q) => [q.id, q]));
	const lines = answeredDrafts()
		.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
		.map(([qid, d]) => {
			const q = qs.get(qid);
			const opt = q?.options?.find((o) => o.id === d.choice);
			const pick = opt ? opt.label : d.choice || "";
			return `${qid}${q && isSettled(q) && pendingChange(q) ? " (change)" : ""}: ${pick}${d.text ? ` - ${d.text.trim()}` : ""}`;
		});
	if (state.drafts._round?.text) lines.push(`Comment: ${state.drafts._round.text.trim()}`);
	const text = lines.join("\n") || "(no answers yet)";
	try {
		await navigator.clipboard.writeText(text);
		toast("Answers copied");
	} catch {
		prompt("Copy your answers:", text);
	}
}

// --- start ----------------------------------------------------------------------------------

$("#send").onclick = () => sendAnswers();
$("#legend").innerHTML = LEGEND.map(mark).join("");
document.addEventListener("click", (e) => {
	const act = e.target.closest("[data-act]");
	if (act?.dataset.act === "close") return closeDrawer();
	if (act?.dataset.act === "back") {
		state.drawer.pop();
		return renderDrawer();
	}
	const ref = e.target.closest("[data-ref]");
	if (ref) openRef(ref.dataset.ref, !!ref.closest("#drawer"));
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && state.drawer.length) closeDrawer();
});
$("#copy").onclick = copyAnswers;
$("#menu").onclick = () => $("#sidebar").classList.toggle("open");
$("#search").oninput = (e) => {
	state.search = e.target.value;
	render();
};
state.filter = load("grill:filter", "open");
const wanted = new URL(location.href).searchParams.get("session");
if (wanted) store("grill:last", wanted);
window.addEventListener("beforeunload", () => saveDrafts());
loadSessions()
	.then(() => setLive(true))
	.catch(() => {
		setLive(false);
		$("#content").innerHTML = '<p class="empty">The grill-panel server isn\'t running. Ask Claude to start it, then refresh.</p>';
	});
connect();
