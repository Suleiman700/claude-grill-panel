---
name: grill-panel
description: Grill the user relentlessly about a plan, decision, or idea, keeping every session's questions, options and decisions in docs/grill-panel/ with a live local HTML panel to answer in (saved as they type, survives refreshes, resumable later). Use when the user asks for grill-panel, or wants a grilling session with a panel, saved questions, or follow-ups across sessions.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it. Everything is also stored on disk, so the user can answer in a browser panel, refresh freely, and come back to the session days later.

## The tree and rounds

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Word each question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one. Record those later questions too (status `not_asked`, with `depends_on`), so nothing is silently assumed and the user can see what's coming.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent with a fresh context window to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

## Storage and the panel

`<skill dir>` below is this skill's base directory (shown when the skill loads). `<data>` is `docs/grill-panel/` in the project you're working in.

- Session files: `<data>/sessions/<id>.json`. You write these with the Write / Edit tools, as valid JSON. The format is in `<skill dir>/reference/schema.md`; read it before writing the first session.
- Answers: `<data>/sessions/<id>.answers.json`, written only by the panel's server. **Never write this file.** Read it to see what the user answered.
- Session ids look like `2026-11-03-game-plan` (date + short slug).

### 1. Start the server

Run in the background (it keeps running across turns; it reuses an already-running server for the same folder):

```
node "<skill dir>/server/server.mjs" --dir "<data>"
```

Its first output line has the URL (`http://localhost:4777/` by default; it tries the next ports if that one is taken). It binds to 127.0.0.1 only and uses no npm packages.

### 2. Pick or create the session

List `<data>/sessions/*.json`. If one is about the same topic and still `open`, resume it: read it and its answers file fully, and continue from its frontier. Otherwise create a new one with `title`, `topic`, `status: "open"`, `created`, `updated`, `round: 0`, `questions: []`.

### 3. Each round

1. Write the round into the session file: each frontier question with `status: "waiting"`, `round`, `title`, `body`, `options` (if multiple choice), `recommended`, `recommended_text`, `depends_on`, `group`. Add or update `not_asked` questions for the branches you can already see. Bump `round` and `updated`.
2. Post the round in chat in this format, ending with the panel link `http://localhost:<port>/?session=<id>`:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body>

➡️ <your recommended answer>
```

3. Start the waiter in the background, unless one is already running for this session:

```
node "<skill dir>/server/wait.mjs" --dir "<data>" --session <id>
```

It exits when the user presses **Send answers** in the panel and prints what they sent, which wakes you up. Then end your turn.

### 4. Processing answers

Answers arrive from the panel (the waiter exits with `ANSWERS SENT`) or in chat. Treat both the same:

| Answer | What to do in the session file |
|---|---|
| `choice: "yes"` | `status: "decided"`, `decision` = the recommendation (plus any condition in `text`). |
| an option id | `decided`, `decision` = that option's label (plus `text`). |
| `"no"` / `"other"` with clear text | `decided` with the user's answer as the decision. |
| unclear, or `text` asks a question | Keep it `waiting`, or add a follow-up question (`id` like `Q3a`, `parent: "Q3"`, list it in the parent's `followups`) for the next round. Answer their question in chat. |
| `"change"` on a decided question | Re-open: back to `waiting` with a follow-up describing what changes. |
| `"early"` on a `not_asked` question | Treat as an answer once its prerequisites allow; otherwise keep it as a note. |
| `_round` text | New ideas or concerns: add them as new questions (now or `not_asked`). |
| "decide later" | `status: "deferred"`, `decision` says when or what triggers it. |

Set `decided_at`, update `summary` (the shared understanding so far, in short markdown) and `updated`. Answers given in chat go straight into the session file as decisions (you can't write the answers file). Then recompute the frontier and run the next round.

### 5. Finishing

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Write the final `summary`, post it in chat, and ask the user to confirm. Only after they confirm, set `status: "done"`. Do not act on the plan until the user confirms you have reached a shared understanding.
