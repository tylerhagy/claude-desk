# claude-desk

A Claude Code mod for keeping track of many terminal sessions at once. It shows which sessions are waiting on you, where each one stands in plain words, and lets you jump between them.

## What it does

- **A pane that opens by itself and is the only thing it shows.** Nothing is added to the chat: no band above the prompt, no toasts, no status line text. `/desk` reopens it. Every session in a fixed order, each with its name, folder, state, a plain-language summary, and what it is blocked on. A **Go To** button focuses that session's Ghostty tab, and a section shows a `tab:` line with the tab's actual title only when it differs from the section's name (for example, one you renamed by hand). The session you are in is outlined.
- **A toggle at the top of the pane** switches between all sessions and just the chat you are in. In the single-chat view every open item shows, with no "+N more" button.
- **Open items.** Up to three open questions and action items per session, with expand, remove, and a button that drafts a prompt (not sent) in that session. A question only appears when Claude is genuinely waiting on you.
- **Tab titles.** A colored circle plus the session's name: a name you set with `/rename`, else a label of three words or fewer for the current work.
- **`/view <path>`** shows an image, markdown or code file in a pane. With no path it shows your newest Desktop screenshot.
- **`/whereami`** refreshes the summary now. **`/tabtitle on|off`** turns tab titles on or off.

## Requirements

- Claude Code with mods (plugins with a hooks module).
- macOS. Tab titles, **Go To**, and drafts into other sessions use Ghostty 1.3 or later and its AppleScript support. Image viewing uses `sips`. Without Ghostty the pane still works, but not those parts.
- A terminal at least 110 columns wide for the pane.

## Install

```
/plugin install desk --marketplace tylerhagy/claude-desk
```

Or load it from a folder for every session by adding its path to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

Sessions only report in once the mod is loaded in them, so restart open terminals (`claude --continue`) after installing.

## How it works

Each session writes a small status file to `~/.claude/desk/sessions/` and refreshes it every 15 seconds. Every session reads that folder to draw the band and pane. The summary, label and open items come from one small-model call (Haiku) over the recent conversation after each finished turn, made through your own session. Nothing leaves your machine except that call.

## Usage

The only thing that uses Claude usage is the summary: one small-model (Haiku) call after a finished turn, at most one per session every 20 seconds, sent only the messages added since the last summary plus the previous summary. A running tally of calls and tokens is kept in `~/.claude/desk/usage.json`.

## Status

An early version. The summary and open-item capture are model judgments and will be wrong sometimes.

## License

MIT
