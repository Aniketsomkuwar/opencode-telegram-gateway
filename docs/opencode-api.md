# OpenCode API reference (verified)

Verified against a running OpenCode 2.1.2 service on 2026-10-22.

Discovery:

- Credentials: `~/.config/opencode/service.json` holds `password` (user is always `opencode`).
- Base URL: `GET /api/info` returns `{ version, pid, urls, paths, capabilities }`. Use `urls[0]`.
- Auth: `Authorization: Basic base64("opencode:" + password)`.
- Spec: `GET /openapi.json` (119 paths). `/v2/openapi.json` also resolves but `/openapi.json` is the one with paths.

Every read endpoint returns `{ data: ... }` (some also return `location`). This document only lists routes the gateway uses or may use. Do not invent routes; if a capability is missing, implement a documented fallback.

## Service

| Method | Path | Notes |
|---|---|---|
| GET | `/api/info` | `{ version, pid, urls[], capabilities }` |
| GET | `/api/config` | Effective config (may contain paths, not secrets) |

## Sessions

| Method | Path | Body / query | Notes |
|---|---|---|---|
| GET | `/api/session` | `limit`, `order`, `search`, `parentID`, `archived` | `{ data: Session.Info[] }`, newest first by default |
| POST | `/api/session` | `{ title?, agent?, model?, location?: { directory } , parentID? }` | `{ data: Session.Info }` |
| GET | `/api/session/{id}` | | `{ data: Session.Info }` |
| PATCH | `/api/session/{id}` | partial session | rename and similar |
| DELETE | `/api/session/{id}` | | delete session |
| GET | `/api/session/active` | | `{ data: { [sessionID]: true } }` (object keyed by id) |
| POST | `/api/session/{id}/prompt` | `{ text, files?: [{uri,name?}], delivery?: "steer"\|"queue", metadata? }` | `{ data: Session.Inbox.User }`. `delivery: "queue"` lets OpenCode queue server-side; the gateway keeps its own queue for position feedback |
| POST | `/api/session/{id}/interrupt` | | abort current turn |
| GET | `/api/session/{id}/message` | `limit`, `order=asc\|desc`, `type`, `cursor` | `{ data: Message.Info[], cursor: { previous, next } }` |
| GET | `/api/session/{id}/message/{messageID}` | | single message |
| POST | `/api/session/{id}/model` | `{ model: { id, providerID, variant? } }` | switch model |
| POST | `/api/session/{id}/agent` | `{ agent: string }` | switch agent |
| POST | `/api/session/{id}/compact` | `{ }` | compact context |
| GET | `/api/session/{id}/diff` | | `{ data: FileDiff.Info[] }` with `file`, `patch`, `additions`, `deletions`, `status` |
| POST | `/api/session/{id}/revert/stage` | `{ messageID, files?: boolean }` | stage an undo |
| POST | `/api/session/{id}/revert/commit` | | apply the staged undo |
| DELETE | `/api/session/{id}/revert` | | clear staged undo |
| POST | `/api/session/{id}/command` | `{ name, text }` | run an OpenCode slash command |
| POST | `/api/session/{id}/fork` | | fork a session |
| POST | `/api/session/{id}/background` | | background delivery |

Message types (`type` field): `user`, `assistant`, `idle`, `compaction`, `system`, `synthetic`, `shell`, `skill`, `agent-switched`, `model-switched`, `location-switched`.

- `assistant.content[]` holds parts: `text`, `tool`, `reasoning`.
- `tool.state.status` is `streaming | running | completed | error`.
- `idle` carries `outcome: succeeded | failed | interrupted` and optional `error`.

The gateway detects completion by counting `idle` messages before the prompt and waiting for one more.

## Permissions

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/session/{id}/permission` | | pending requests for the session |
| GET | `/api/permission/request` | | all pending requests |
| GET | `/api/permission/saved` | | saved "always" rules |
| POST | `/api/session/{id}/permission/{requestID}/reply` | `{ decision: "once"\|"always"\|"reject", message? }` | the request id used by the bridge is the permission `id` from the list |

A request is `{ id, sessionID, action, resources[], save?, metadata?, message? }`. `action` is a string such as `bash` or `edit`; `resources` are command strings or file paths.

## Models and agents

| Method | Path | Notes |
|---|---|---|
| GET | `/api/model` | `{ location, data: Model.Info[] }`; `Model.Info` has `id`, `modelID`, `providerID`, `name`, `variants[]`, `cost[]`, `status` |
| GET | `/api/model/default` | default model |
| GET | `/api/agent` | `{ location, data: Agent.Info[] }`; `id`, `name`, `mode` (`primary`/`subagent`/`all`), `hidden` |
| GET | `/api/provider` | providers |

Switching a model needs `{ id, providerID }` exactly as returned by `/api/model`, not the display name.

## Files, VCS, shell

| Method | Path | Notes |
|---|---|---|
| GET | `/api/fs/list`, `/api/fs/find`, `/api/fs/read/*` | read-only file access |
| POST | `/api/experimental/fs/write` | experimental write |
| GET | `/api/vcs/status`, `/api/vcs/diff`, `/api/vcs/branch` | git state |
| POST | `/api/pty`, `GET/PUT/DELETE /api/pty/{id}` | terminals |
| GET | `/api/shell/{id}/output` | shell output |

## Event stream (SSE)

`GET /api/event` returns `text/event-stream` with frames of `{ id, event, data }`, where `data` is a JSON string (`V2EventEncoded`). This is a real event stream, contrary to the earlier assumption in `AUDIT.md`.

Status: the gateway does not consume it yet. Polling `GET /api/session/{id}/message` and `/api/session/active` remains the confirmed transport. Phase 5 can switch progress and completion detection to SSE; the event names must be recorded from a live capture first.

## Capabilities that do not exist

- No `/redo` endpoint. Redo is implemented as "re-run the last user prompt".
- No todo endpoint. `/todo` reads the most recent `todo` tool part from the session messages; if none exists it says so.
- No cost endpoint per turn. Cost comes from `Session.Info.cost` and `Session.Info.tokens`.
