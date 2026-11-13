# Guided Reading Assistant

Read Markdown books with an AI guide that maintains a reading plan, invites your own retelling, answers follow-up questions, and keeps your understanding notes separate from reading position.

[中文说明](README.zh-CN.md)

## Features

- Independent reading prompts, discussions, positions, plans, and records for each book.
- A provisional book-wide reading map based on headings, excerpts, and saved reading records.
- Short reading tasks, open questions, follow-up discussions, and correction grounded in the supplied text.
- Explicit reader-controlled position changes and understanding records. An AI answer never marks material as understood.
- Selected-passage discussion, review of saved questions, and optional web research per book.
- A spoiler-conscious mode that restricts supplied material to the opened reading range. Model memory can still reveal spoilers.
- Plain Markdown book configurations and understanding notes that remain useful without this plugin.

The current interface is in Chinese. Desktop only. Markdown sources only; PDF, EPUB, and OCR are not supported.

## Requirements

Install and sign in to the official [Codex CLI](https://developers.openai.com/codex/cli/) separately. This plugin launches the locally installed CLI and implements its [App Server protocol](https://learn.chatgpt.com/docs/app-server).

Model availability, quotas, and charges depend on your Codex account and configured provider. The plugin itself is free and does not sell access. No API key is stored by the plugin.

## Installation

While the community-directory submission is pending, download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/zijian3/guided-reading-assistant/releases/latest). Put these three files in `<your-vault>/.obsidian/plugins/guided-reading-assistant/`, restart Obsidian, and enable **Guided Reading Assistant** under **Settings → Community plugins**.

Once listed, search for **Guided Reading Assistant** in the community plugin browser and install it there.

## Getting started

1. Open the command palette (`Ctrl+P` on Windows/Linux, `Cmd+P` on macOS). Run **Guided Reading Assistant: 打开书架与导读** or select the book icon in the ribbon.
2. Select **刷新 AI 连接** (refresh AI connection). Model and reasoning choices are available in the plugin settings after connecting.
3. Select **添加书籍** (add a book). Enter a name and Vault-relative Markdown file or chapter-folder paths, one per line. The listed source order is preserved; files inside a folder use natural filename ordering.
4. Choose and customize a reading-prompt preset. Select **建立阅读路线** (build reading plan), then **开始／继续导读** (start/continue).
5. Read the source text, retell it in your own words, and ask questions. `Ctrl+Enter` or `Cmd+Enter` sends a message.
6. Use **保存阅读记录** to save your understanding, open questions, and self-assessment to Markdown. Move to the next unit yourself when ready.

For a focused passage, select text inside one reading unit and use the editor context menu or **导读当前选区** command.

## Book configuration and storage

The default configuration folder is `读书助手/书架`. A book is a Markdown file with this frontmatter followed by its custom reading prompt:

```markdown
---
type: guided-reading-book
id: my-book
title: My book
source:
  - Books/My book
notes: Reading notes/My book
reading_order: source
external_sources: off
spoiler_policy: unrestricted
---

# 导读提示词

Explain one main problem at a time. Ask me to retell the passage before
correcting misunderstandings. Distinguish the author's claims from your interpretation.
```

Use `external_sources: on-demand` to allow explicitly requested web research. `spoiler_policy: strict` overrides research and hides unopened text and headings from the supplied context.

Understanding notes go to the configured `notes` folder. Reading position, draft, conversations, plan, and record index go to `.obsidian/plugins/guided-reading-assistant/sessions/<book-id>.json`, with the preceding snapshot in `.bak`. Include these files in your own backups if needed. They may be excluded by a Vault's existing sync or Git rules. Codex model-thread restoration also depends on the local Codex history; **新会话** starts a fresh thread while retaining local records.

## Privacy and external access

This plugin has no analytics, advertising, or plugin-operated backend.

- Only an explicit reading action sends the book prompt, relevant source excerpts, file paths/line references, recent discussion, and saved understanding records to the model service configured in your local Codex installation. Refreshing the connection reads account/model availability without sending book content.
- Web research is off by default. When enabled for a book, the model is instructed to search only when you explicitly request external sources. Searches use Codex's configured search service.
- The plugin searches outside the Vault for the Codex executable using PATH and common installation directories. It starts that executable as a hidden background process. Codex itself uses its own external account/configuration/history storage. The plugin does not read or copy credentials, install Codex, or update itself or dependencies.
- Model sessions disable shell, connector, plugin, browser, and additional-agent features, request a read-only sandbox and never grant approval. The local CLI can still maintain its own session and configuration files.
- AI text may be wrong. Book plans use limited excerpts; the plugin does not claim to inspect every chapter in one request. Spoiler restrictions cannot erase a model's prior knowledge.

For the OpenAI service, see the [OpenAI privacy policy](https://openai.com/policies/privacy-policy/). Other configured providers have their own policies and terms.

## Development

Requires Node.js 20+.

```sh
npm ci
npm run check
npm run install:plugin -- "/absolute/path/to/vault"
```

The installer copies build assets; it does not enable the plugin. The connection smoke test is `node scripts/smoke.cjs`; adding `--turn` sends one synthetic verification request. `node scripts/verify-guide.cjs` exercises a synthetic guided-reading and follow-up interaction without user books.

Source code is MIT licensed. The JSON-RPC client, executable discovery, and Codex integration are independently implemented for this project. No code from another Obsidian plugin is included. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
