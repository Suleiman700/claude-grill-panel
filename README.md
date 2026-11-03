# grill-panel

A Claude Code skill: a "grilling" interview (Claude maps your plan as a tree of decisions and asks the open
ones round by round) with a **local HTML panel** to answer in, and every session saved to disk.

- Questions, options, recommendations, follow-ups and decisions are stored per project in
  `docs/grill-panel/sessions/`.
- The panel saves answers as you type, so a refresh never loses anything. If the server is down, answers wait in
  the browser and sync when it's back.
- Several sessions per project; resume any of them later.
- **Send answers** in the panel wakes Claude up (a small waiter process exits), so there's no copy-pasting.
  **Copy answers** is there too, for answering in chat instead.
- Live: when Claude adds a round, the open panel updates by itself.

## Install

Copy this folder to your Claude skills folder:

```
# Windows (Git Bash)
cp -r /d/GitHub/grill-panel ~/.claude/skills/grill-panel
```

Then run `/grill-panel <what you want to plan>` in Claude Code. After changing the repo, copy it again.

## Requirements

Node.js 18 or newer. No npm packages: the server uses Node's built-in modules only.

## Files

| Path | What |
|---|---|
| `SKILL.md` | The skill: how Claude runs the interview and keeps the session files. |
| `reference/schema.md` | The session and answers file format. |
| `server/server.mjs` | Local server (127.0.0.1 only): serves the panel, lists sessions, saves answers, pushes live updates. |
| `server/wait.mjs` | Exits when the user sends answers for a session; Claude runs it in the background. |
| `panel/` | The panel (plain HTML, CSS, JS; no build step). |

## Running the server by hand

```
node server/server.mjs --dir <project>/docs/grill-panel [--port 4777]
```

Open `http://localhost:4777/`.

## Security

- The server listens on 127.0.0.1 only.
- Session and question ids are checked against a strict pattern, so requests can't reach files outside the data
  folder.
- It only ever writes `<id>.answers.json`. Request bodies are capped at 1 MB.
- The panel escapes all session text before showing it.
