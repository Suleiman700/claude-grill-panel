# grill-panel data format

Everything lives in the project at `docs/grill-panel/sessions/`. One grilling session = two files:

| File | Written by | Holds |
|---|---|---|
| `<id>.json` | Claude (Write / Edit tools) | the session: questions, options, recommendations, decisions |
| `<id>.answers.json` | the panel, through the server | what the user picked or typed in the panel |

Claude never writes `.answers.json`, and the server never writes `<id>.json`. That keeps the two from
overwriting each other.

Session ids: letters, digits, `.`, `_`, `-`, starting with a letter or digit, e.g. `2026-11-03-game-plan`.

## `<id>.json`

```json
{
	"id": "2026-11-03-game-plan",
	"title": "Game plan: co-op and sandbox",
	"topic": "One or two sentences: what is being decided.",
	"mode": "both",
	"status": "open",
	"created": "2026-11-03T10:00:00Z",
	"updated": "2026-11-03T12:30:00Z",
	"round": 2,
	"summary": "Optional markdown: the shared understanding so far.",
	"questions": [
		{
			"id": "Q1",
			"round": 1,
			"group": "Networking",
			"title": "Internet play",
			"body": "Markdown. **bold**, `code`, lists with - , blank line = new paragraph.",
			"options": [
				{ "id": "a", "label": "Epic Online Services", "description": "Free, hosted by Epic." },
				{ "id": "b", "label": "Own relay", "description": "Self-hosted." }
			],
			"recommended": "a",
			"recommended_text": "Epic Online Services: free and works on PC + Android.",
			"depends_on": [],
			"status": "waiting",
			"decision": null,
			"decided_at": null,
			"followups": ["Q1a"],
			"parent": null,
			"notes": "Optional: facts Claude found, in markdown.",
			"qa": [
				{ "q": "Does EOS work offline?", "a": "No: it needs a login, so LAN play stays on Q4.", "at": "2026-11-03T12:40:00Z" }
			]
		}
	]
}
```

### Question fields

| Field | Meaning |
|---|---|
| `id` | Unique in the session: `Q1`, `Q2`… for asked questions, `N1`… for not-yet-asked ones, `Q1a` for a follow-up of Q1. |
| `round` | Round it was asked in; `null` while `not_asked`. |
| `group` | Optional heading the panel groups by (e.g. "Police"). |
| `title`, `body` | The question. `body` is markdown, worded so "yes" accepts the recommendation. |
| `options` | Optional multiple choice: `id`, `label`, `description`. Leave empty for a yes/no question. |
| `recommended` | The option `id` Claude recommends, or `"yes"` for a yes/no question. |
| `recommended_text` | The recommendation in words (shown as ➡️). |
| `depends_on` | Question ids that must be decided first. A `not_asked` question becomes askable when all of these are `decided`. |
| `status` | `not_asked` (known, waiting on its prerequisites) · `waiting` (asked, no answer yet) · `answered` (user answered, Claude hasn't processed it) · `decided` · `deferred` (decided to decide later) · `dropped` (no longer relevant). |
| `decision` | Final decision text once `decided` or `deferred`. |
| `decided_at` | ISO time. |
| `followups` | Ids of questions that came out of this one. |
| `parent` | For a follow-up: the question it came from. |
| `notes` | Optional extra context or facts. |
| `qa` | Questions the user asked Claude about this question (in the answer `text`) and Claude's answers: `q`, `a` (markdown), `at`. The panel shows them in the side panel. |

Ids mentioned in `title`, `body`, `notes`, `recommended_text`, `decision`, option descriptions, `qa` and the
session `summary` (e.g. "follows up on Q1") are shown as links that open that question in the panel's side panel.

Session `mode`: how the user answers. `panel` (the HTML panel; chat shows only titles and the link), `chat`
(chat only, no server), or `both`. Asked once when a session starts.

Session `status`: `open` or `done` (the frontier is empty and the user confirmed the shared understanding).

## `<id>.answers.json`

Written by the server when the user answers in the panel. Keyed by question id:

```json
{
	"Q1": { "choice": "a", "text": "but only if it stays free", "submitted": true, "at": "2026-11-03T12:31:00Z" },
	"Q2": { "choice": "yes", "text": "", "submitted": false, "at": "2026-11-03T12:31:10Z" },
	"_round": { "choice": "submit", "text": "general comment on this round", "submitted": true, "at": "…" }
}
```

| Field | Meaning |
|---|---|
| `choice` | An option `id`, `"yes"` (accept the recommendation), `"no"`, `"other"` (see text), or `null`. |
| `text` | Free text: a custom answer, a condition, or a follow-up question for Claude. |
| `submitted` | `false` = saved but not sent (the panel lists it under **Not sent**); `true` = the user pressed **Send answers** or **Send to Claude**. |
| `_round` | A comment on the whole round, plus the time the round was sent. |

Claude only acts on `submitted: true` answers. After processing one, Claude updates the question in
`<id>.json` (status `decided` / `deferred` / follow-ups added). The answer entry stays as a record.

On a `decided` or `deferred` question, an answer newer than the question's `decided_at` came from the side panel: a
**change** if the choice differs from the decision, otherwise a question in `text`. Older entries are just the record of the answer that decided it, so
always set `decided_at` when deciding.
