# Attribution

Guided Reading Assistant, copyright 2026 Zijian and contributors, MIT.

The distributed plugin contains this project's own reading workflow, storage, interface, executable discovery, JSON-RPC transport and Codex App Server integration. It has no bundled runtime dependencies. esbuild and linkedom are development dependencies only.

The initial exploration was inspired by book-specific reading workflows, including Lacan Translation Helper. Its code is not included in this public distribution.

The Codex integration implements the public App Server protocol documented by OpenAI: https://learn.chatgpt.com/docs/app-server . Codex is installed separately by the user. This project is independent of OpenAI and Obsidian.
