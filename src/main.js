const {Plugin, ItemView, Modal, Setting, PluginSettingTab, Notice, MarkdownRenderer, Component, parseYaml, stringifyYaml, TFile} = require("obsidian");
const {randomUUID} = require("crypto");
const {CodexAppServerRuntime} = require("./codex-runtime");
const {ReadingController, SessionStore, LABELS} = require("./controller");
const {PRESETS, vaultPath, inFolder, cleanName, parseBook, serializeBook, locateUnit, positionOf} = require("./book");

const VIEW = "guided-reading-assistant-view";
const DEFAULTS = {libraryRoot:"读书助手/书架", cliPath:"", model:"", effort:"", selectedBook:""};

async function folders(vault, path) {
  let current = "";
  for (const part of path.split("/")) {
    current = current ? `${current}/${part}` : part;
    if (!vault.getAbstractFileByPath(current)) await vault.createFolder(current);
  }
}
function button(parent, label, action, disabled = false, primary = false) {
  const el = parent.createEl("button", {text:label, cls:primary ? "mod-cta" : ""}); el.disabled = disabled;
  el.addEventListener("click", () => { Promise.resolve().then(action).catch(error => new Notice(error.message)); }); return el;
}

class GuidedReadingPlugin extends Plugin {
  async onload() {
    this.settings = {...DEFAULTS, ...await this.loadData()}; this.catalog = []; this.configErrors = []; this.connectionStatus = "";
    if (!this.app.vault.adapter.getBasePath) { new Notice("读书导读助手目前仅支持桌面本地库。"); return; }
    this.runtime = new CodexAppServerRuntime({vaultRoot:this.app.vault.adapter.getBasePath(), pluginVersion:this.manifest.version, cliPath:this.settings.cliPath});
    this.controller = new ReadingController({
      runtime:this.runtime,
      store:new SessionStore(this.app.vault.adapter, `${this.manifest.dir}/sessions`),
      libraryIO:() => ({paths:this.app.vault.getMarkdownFiles().map(f => f.path), readText:p => this.app.vault.cachedRead(this.app.vault.getAbstractFileByPath(p))}),
      modelOptions:() => ({model:this.settings.model, effort:this.settings.effort}),
      onError:message => new Notice(String(message)),
    });
    this.registerView(VIEW, leaf => new ReadingView(leaf, this));
    this.addRibbonIcon("book-open", "打开读书导读助手", () => this.open());
    this.addCommand({id:"open", name:"打开书架与导读（读书导读助手）", callback:() => this.open()});
    this.addCommand({id:"add-book", name:"添加一本书", callback:() => new BookModal(this).open()});
    this.addCommand({id:"refresh-connection", name:"刷新 AI 连接", callback:() => this.reconnect().then(models => new Notice(`已连接 Codex，可用模型 ${models.length} 个。`)).catch(e => new Notice(e.message))});
    this.addCommand({id:"analyze-selection", name:"导读当前选区", editorCallback:(editor, view) => this.fromSelection(editor, view).catch(e => new Notice(e.message))});
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => {
      if (editor.getSelection()) menu.addItem(item => item.setTitle("读书助手：分析选区").setIcon("book-open").onClick(() => this.fromSelection(editor, view).catch(e => new Notice(e.message))));
    }));
    this.addSettingTab(new ReadingSettings(this.app, this));
  }
  async onunload() { await this.runtime?.shutdown(); await this.controller?.queue; }
  async saveSettings() { await this.saveData(this.settings); }
  async scanBooks() {
    const root = vaultPath(this.settings.libraryRoot); const books = []; const ids = new Map(); this.configErrors = [];
    for (const file of this.app.vault.getMarkdownFiles().filter(f => inFolder(f.path, root))) {
      try {
        const text = await this.app.vault.cachedRead(file);
        const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if (!frontmatter || parseYaml(frontmatter[1])?.type !== "guided-reading-book") continue;
        const book = parseBook(text, file.path, parseYaml);
        if (ids.has(book.id)) { this.configErrors.push(`书籍 id 重复：${file.path} 与 ${ids.get(book.id)}`); continue; }
        ids.set(book.id, file.path); books.push(book);
      } catch (error) { this.configErrors.push(`${file.path}：${error.message}`); }
    }
    return books.sort((a,b) => a.title.localeCompare(b.title, "zh-CN", {numeric:true}));
  }
  async choose(book) {
    await this.controller.selectBook(book); this.settings.selectedBook = book.id; await this.saveSettings();
  }
  async refreshActive() {
    const file = this.app.vault.getAbstractFileByPath(this.controller.book.configPath);
    if (!(file instanceof TFile)) throw new Error("找不到书籍配置，请刷新书架。");
    await this.controller.selectBook(parseBook(await this.app.vault.read(file), file.path, parseYaml));
  }
  async run(action, text, selection) { await this.refreshActive(); return this.controller.run(action, text, selection); }
  async open() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false); await leaf.setViewState({type:VIEW, active:true}); }
    await this.app.workspace.revealLeaf(leaf); return leaf.view;
  }
  async fromSelection(editor, view) {
    if (!editor.getSelection() || !view.file) throw new Error("请先在书稿中选中一段文字。");
    this.controller.assertIdle();
    const selection = {text:editor.getSelection(), path:view.file.path, startLine:editor.getCursor("from").line + 1, endLine:editor.getCursor("to").line + 1};
    // Ending at column zero does not include that last line.
    if (editor.getCursor("to").ch === 0 && selection.endLine > selection.startLine) selection.endLine--;
    const books = (await this.scanBooks()).filter(b => b.sources.some(s => inFolder(selection.path, s)) && !inFolder(selection.path, b.notes));
    const book = books.find(b => b.id === this.controller.book?.id) || (books.length === 1 ? books[0] : null);
    if (!book) throw new Error(books.length ? "这段正文属于多本书，请先在书架选择一本。" : "请先把这份正文添加为一本书的资料。");
    await this.choose(book);
    const index = this.controller.library.units.findIndex(u => u.path === selection.path && u.startLine <= selection.startLine && u.endLine >= selection.endLine);
    if (index < 0) throw new Error("请把选区缩小到同一阅读单元内。");
    await this.controller.setPosition(index); await this.open(); await this.run("selection", "", selection);
  }
  async writeRecord(record) {
    const book = this.controller.book; const unit = this.controller.library.units[locateUnit(this.controller.library, record.position)];
    await folders(this.app.vault, book.notes);
    const stamp = record.at.replace(/[:.]/g, "-");
    const path = `${book.notes}/${stamp}-${record.id.slice(0, 6)}.md`;
    const text = `---\n${stringifyYaml({type:"guided-reading-record", book_id:book.id, created:record.at, assessment:record.assessment}).trim()}\n---\n\n# ${book.title} · 阅读记录\n\n正文：[[${unit.path.replace(/\.md$/, "")}]]，第 ${unit.startLine}–${unit.endLine} 行，${unit.title}\n\n## 我的理解\n\n${record.understanding || "（暂未填写）"}\n\n## 尚存疑问\n\n${record.questions || "（暂未填写）"}\n\n自评：${record.assessment}\n\n> 本记录由读者主动保存；自评不等于已经通过理解验证。\n`;
    await this.app.vault.create(path, text); return path;
  }
  async reconnect() {
    this.controller.assertIdle(); this.controller.busy = true; this.connectionStatus = "正在刷新 AI 连接…"; this.controller.emit();
    try {
      await this.runtime.shutdown(); this.runtime.configuredCliPath = this.settings.cliPath;
      this.catalog = await this.runtime.listModels();
      this.connectionStatus = `Codex 已连接 · ${this.catalog.length} 个可用模型`;
      return this.catalog;
    } catch (error) { this.connectionStatus = `连接未完成：${error.message}`; throw error; }
    finally { this.controller.busy = false; this.controller.emit(); }
  }
}

class ReadingView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.books = []; this.showAll = false; this.renderVersion = 0; this.messageVersion = 0; }
  getViewType() { return VIEW; }
  getDisplayText() { return "读书导读助手"; }
  getIcon() { return "book-open"; }
  async onOpen() {
    this.contentEl.addClass("gra-view");
    this.unsubscribe = this.plugin.controller.subscribe(kind => {
      if (kind === "stream") {
        if (!this.streamTimer) this.streamTimer = setTimeout(() => { this.streamTimer = null; this.renderMessages(); }, 160);
      } else this.render();
    });
    await this.refresh();
  }
  async onClose() { this.unsubscribe?.(); clearTimeout(this.streamTimer); clearTimeout(this.draftTimer); await this.flushDraft(); this.chatComponent?.unload(); this.renderVersion++; }
  async refresh() {
    this.plugin.controller.assertIdle(); this.books = await this.plugin.scanBooks();
    const selected = this.books.find(b => b.id === (this.plugin.controller.book?.id || this.plugin.settings.selectedBook));
    if (selected) { try { await this.plugin.choose(selected); } catch(e) { new Notice(e.message); } }
    this.render();
  }
  async flushDraft() {
    if (this.input && this.plugin.controller.state && this.inputBook === this.plugin.controller.book?.id && !this.plugin.controller.busy) {
      await this.plugin.controller.setDraft(this.input.value);
    }
  }
  render() {
    clearTimeout(this.streamTimer); this.streamTimer = null;
    const c = this.plugin.controller; const el = this.contentEl; el.empty(); this.renderVersion++;
    const top = el.createDiv({cls:"gra-top"}); top.createEl("h3", {text:"读书导读助手"});
    const tools = top.createDiv({cls:"gra-row"});
    button(tools, "＋ 添加书籍", () => new BookModal(this.plugin, null, () => this.refresh()).open(), c.busy);
    button(tools, "刷新书架", () => this.refresh(), c.busy);
    button(tools, "刷新 AI 连接", () => this.plugin.reconnect(), c.busy);
    button(tools, "设置", () => { this.app.setting.open(); this.app.setting.openTabById(this.plugin.manifest.id); });
    if (this.plugin.connectionStatus) el.createDiv({text:this.plugin.connectionStatus, cls:"gra-muted"});
    if (this.plugin.configErrors.length) el.createDiv({text:this.plugin.configErrors.join("\n"), cls:"gra-error"});
    if (!this.books.length) {
      el.createEl("p", {text:"添加 Markdown 书稿文件或章节目录，为这本书配置导读方式。正文仍在原位置，提示词和阅读记录分别保存。"});
      el.createEl("p", {text:"第一步：添加书籍。第二步：建立阅读路线。第三步：跟随导读阅读、复述和追问。", cls:"gra-muted"}); return;
    }
    const select = el.createEl("select", {cls:"gra-book-select", attr:{"aria-label":"选择书籍"}});
    select.createEl("option", {text:"选择一本书", value:""});
    for (const b of this.books) select.createEl("option", {text:b.title, value:b.id});
    select.value = c.book?.id || ""; select.disabled = c.busy;
    select.addEventListener("change", async () => { try { await this.flushDraft(); const b = this.books.find(b => b.id === select.value); if (b) await this.plugin.choose(b); } catch(e) { new Notice(e.message); } });
    if (!c.book || !c.library) return;
    const book = c.book; const index = locateUnit(c.library, c.state.position); const unit = c.library.units[index];
    const info = el.createDiv({cls:"gra-book-info"}); info.createSpan({text:book.strictSpoilers ? "严格防剧透 · 外部检索关闭" : book.external ? "外部资料按需检索" : "依据本书资料导读"});
    button(info, "编辑本书提示词", () => this.app.workspace.getLeaf(false).openFile(this.app.vault.getAbstractFileByPath(book.configPath)), c.busy);
    button(info, "书籍配置", () => new BookModal(this.plugin, book, () => this.refresh()).open(), c.busy);
    const position = el.createDiv({cls:"gra-position"});
    position.createEl("h4", {text:`当前阅读 ${index + 1} / ${c.library.units.length}`});
    position.createDiv({text:unit.title, cls:"gra-unit-title"});
    position.createDiv({text:`${unit.path} · 第 ${unit.startLine}–${unit.endLine} 行`, cls:"gra-muted gra-path"});
    const nav = position.createDiv({cls:"gra-row"});
    button(nav, "上一单元", () => c.setPosition(index - 1), c.busy || index === 0);
    button(nav, "打开正文", () => this.app.workspace.getLeaf(false).openFile(this.app.vault.getAbstractFileByPath(unit.path), {eState:{line:unit.startLine - 1}}));
    button(nav, "下一单元", () => c.setPosition(index + 1), c.busy || index === c.library.units.length - 1);
    const jump = position.createEl("select", {attr:{"aria-label":"切换阅读单元"}}); jump.disabled = c.busy;
    const frontier = locateUnit(c.library, c.state.furthest);
    c.library.units.forEach((u,i) => jump.createEl("option", {text:`${i + 1}. ${book.strictSpoilers && i > frontier ? "未开放单元（选择后开放）" : u.title}`, value:String(i)}));
    jump.value = String(index); jump.addEventListener("change", () => c.setPosition(Number(jump.value)).catch(e => new Notice(e.message)));
    const excerpt = position.createEl("details", {cls:"gra-excerpt"}); excerpt.createEl("summary", {text:"展开当前正文"});
    excerpt.createEl("pre", {text:unit.text.slice(0, 22000)});
    position.createDiv({text:`理解记录 ${c.state.records.length} 条 · 阅读位置由你切换，理解由你保存。`, cls:"gra-muted"});
    const actions = el.createDiv({cls:"gra-actions"});
    for (const action of ["map","guide","review","finish"]) button(actions, LABELS[action], () => this.send(action), c.busy, action === "guide");
    const secondary = el.createDiv({cls:"gra-row"});
    button(secondary, "保存阅读记录", () => new RecordModal(this.plugin).open(), c.busy);
    button(secondary, "新会话", () => c.newConversation().then(() => new Notice("下一次提问将开启新会话；本地记录保留。")), c.busy);
    if (c.state.readingMap && !book.strictSpoilers) {
      const map = el.createEl("details", {cls:"gra-map"}); map.createEl("summary", {text:"查看已建立的阅读路线"});
      const mapEl = map.createDiv(); void MarkdownRenderer.render(this.app, c.state.readingMap, mapEl, book.configPath, this);
    }
    if (c.error) el.createDiv({text:c.error, cls:"gra-error"});
    this.chatEl = el.createDiv({cls:"gra-chat", attr:{"aria-label":"本书导读对话", "aria-live":"polite"}});
    this.composer = el.createDiv({cls:"gra-composer"});
    this.input = this.composer.createEl("textarea", {attr:{placeholder:"写下你的复述、疑问，或希望调整的阅读方向…", "aria-label":"问题或复述", rows:"4"}});
    this.input.value = c.state.draft; this.input.disabled = c.busy; this.inputBook = book.id;
    this.input.addEventListener("input", () => { c.state.draft = this.input.value; clearTimeout(this.draftTimer); this.draftTimer = setTimeout(() => this.flushDraft().catch(e => new Notice(e.message)), 500); });
    this.input.addEventListener("keydown", event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void this.send("discuss").catch(e => new Notice(e.message)); } });
    const send = this.composer.createDiv({cls:"gra-row"});
    button(send, c.busy ? "正在导读…" : "发送 · Ctrl+Enter", () => this.send("discuss"), c.busy, true);
    if (c.busy) button(send, "停止", () => c.stop());
    this.renderMessages();
  }
  async send(action) {
    const text = this.input?.value || ""; clearTimeout(this.draftTimer); await this.flushDraft();
    await this.plugin.run(action, text); this.input?.focus();
  }
  async renderMessages() {
    if (!this.chatEl) return;
    const target = this.chatEl; const version = ++this.messageVersion;
    const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
    this.chatComponent?.unload(); this.chatComponent = new Component(); this.chatComponent.load();
    const component = this.chatComponent; target.empty();
    const c = this.plugin.controller; const visible = this.showAll ? c.state.messages : c.state.messages.slice(-40);
    if (!visible.length) target.createEl("p", {text:"先建立阅读路线，或直接开始当前单元的导读。读完后用自己的话复述，也可以随时追问。", cls:"gra-muted"});
    if (visible.length < c.state.messages.length) button(target, "显示更早对话", () => { this.showAll = true; this.renderMessages(); });
    for (const m of visible) {
      if (version !== this.messageVersion) return;
      const message = target.createDiv({cls:`gra-message gra-${m.role}`});
      message.createDiv({text:m.role === "user" ? "你" : m.status === "pending" ? "导读者 · 正在思考／回答" : "导读者", cls:"gra-message-label"});
      const body = message.createDiv();
      if (m.role === "user") body.createDiv({text:m.text, cls:"gra-user-text"});
      else if (m.text) await MarkdownRenderer.render(this.app, m.text, body, c.book.configPath, component);
      if (m.error) message.createDiv({text:m.error, cls:"gra-error"});
    }
    if (nearBottom && version === this.messageVersion) target.scrollTop = target.scrollHeight;
  }
}

class BookModal extends Modal {
  constructor(plugin, book = null, after = () => {}) { super(plugin.app); Object.assign(this, {plugin,book,after}); }
  onOpen() {
    const el = this.contentEl; el.addClass("gra-modal"); el.createEl("h2", {text:this.book ? "书籍配置" : "添加一本书"});
    el.createEl("p", {text:"正文支持 Vault 内的 Markdown 文件或章节目录。多条路径按填写顺序阅读；目录内部按文件名自然排序。", cls:"gra-muted"});
    let title = this.book?.title || ""; let source = this.book?.sources.join("\n") || "";
    let prompt = this.book?.prompt || PRESETS.general.prompt; let strict = this.book?.strictSpoilers || false; let external = this.book?.external || false;
    const id = this.book?.id || randomUUID(); let notes = this.book?.notes || "";
    new Setting(el).setName("书名").addText(t => t.setValue(title).onChange(v => title = v));
    const sourceSetting = new Setting(el).setName("正文路径").setDesc("每行一个相对路径，例如：书库/某本书 或 书库/某本书.md");
    sourceSetting.addTextArea(t => { t.setValue(source).setPlaceholder("粘贴文件或文件夹的 Vault 相对路径").onChange(v => source = v); t.inputEl.rows = 3; });
    new Setting(el).setName("提示词模板").addDropdown(d => { for (const [key, value] of Object.entries(PRESETS)) d.addOption(key, value.name); d.onChange(v => { prompt = PRESETS[v].prompt; promptInput.setValue(prompt); }); });
    let promptInput;
    new Setting(el).setName("本书导读提示词").setDesc("配置保存为 Markdown，可以随时直接编辑。修改后下一次提问会采用新提示词。").addTextArea(t => { promptInput = t; t.setValue(prompt).onChange(v => prompt = v); t.inputEl.rows = 10; });
    new Setting(el).setName("严格防剧透").setDesc("只提供已开放范围，禁用外部检索。模型仍可能有记忆，不能保证绝对无剧透。").addToggle(t => t.setValue(strict).onChange(v => strict = v));
    new Setting(el).setName("允许按需查外部资料").setDesc("默认关闭。打开后，仅当你明确要求时检索；严格防剧透会覆盖此设置。").addToggle(t => t.setValue(external).onChange(v => external = v));
    new Setting(el).setName("理解记录目录").setDesc("留空会为本书建立独立目录。").addText(t => t.setValue(notes).onChange(v => notes = v));
    const errorEl = el.createDiv({cls:"gra-error"});
    const save = button(el, "保存书籍", async () => {
      save.disabled = true; errorEl.empty();
      try {
        this.plugin.controller.assertIdle(); if (!title.trim()) throw new Error("请填写书名。");
        const sources = source.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(vaultPath);
        if (!sources.length) throw new Error("请填写至少一条正文路径。");
        for (const path of sources) { const f = this.app.vault.getAbstractFileByPath(path); if (!f || (f instanceof TFile && f.extension !== "md")) throw new Error(`正文不存在或不是 Markdown：${path}`); }
        const root = vaultPath(this.plugin.settings.libraryRoot); await folders(this.app.vault, root);
        const configPath = this.book?.configPath || `${root}/${cleanName(title)}-${id.slice(0, 6)}.md`;
        const text = serializeBook({id, title, sources, notes:notes.trim() || `读书助手/阅读记录/${cleanName(title)}-${id.slice(0, 6)}`, prompt, strictSpoilers:strict, external}, stringifyYaml);
        const file = this.app.vault.getAbstractFileByPath(configPath);
        if (file) await this.app.vault.process(file, () => text); else await this.app.vault.create(configPath, text);
        await this.plugin.choose(parseBook(text, configPath, parseYaml)); await this.after(); this.close(); await this.plugin.open();
      } catch(error) { errorEl.setText(error.message); save.disabled = false; }
    }, false, true);
  }
}

class RecordModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() {
    this.contentEl.createEl("h2", {text:"用自己的话保存理解"});
    this.contentEl.createEl("p", {text:"这里保存你的理解和疑问；AI 的回顾留在对话中。保存后阅读位置不会自动前进。", cls:"gra-muted"});
    let understanding = "", questions = "", assessment = "仍在理解";
    new Setting(this.contentEl).setName("我的理解／复述").addTextArea(t => { t.onChange(v => understanding = v); t.inputEl.rows = 7; });
    new Setting(this.contentEl).setName("尚存疑问").addTextArea(t => { t.onChange(v => questions = v); t.inputEl.rows = 4; });
    new Setting(this.contentEl).setName("自评").addDropdown(d => { for (const value of ["仍在理解","能用自己的话复述","能用案例解释","已尝试应用"]) d.addOption(value, value); d.onChange(v => assessment = v); });
    const save = button(this.contentEl, "保存为阅读笔记", async () => {
      save.disabled = true;
      try { await this.plugin.controller.saveRecord({understanding, questions, assessment, writeNote:r => this.plugin.writeRecord(r)}); this.close(); new Notice("已保存你的阅读记录。"); }
      catch(error) { save.disabled = false; new Notice(error.message); }
    }, false, true);
  }
}

class ReadingSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const el = this.containerEl; el.empty(); const p = this.plugin;
    el.createEl("p", {text:"使用本机已登录的 Codex。只有你发起导读时才会发送本书提示词、相关正文、阅读记录和对话。"});
    new Setting(el).setName("书籍配置目录").addText(t => t.setValue(p.settings.libraryRoot).onChange(async v => { try { vaultPath(v); p.settings.libraryRoot = v; await p.saveSettings(); } catch {} }));
    new Setting(el).setName("Codex 可执行文件").setDesc("留空自动检测；也可填写 codex.exe 的完整路径。更改后点击检测连接。").addText(t => t.setValue(p.settings.cliPath).onChange(async v => { p.settings.cliPath = v.trim(); await p.saveSettings(); }));
    const status = el.createDiv({cls:"gra-muted"});
    new Setting(el).setName("检测连接并读取模型").setDesc("读取登录状态和账号实际可用模型，不发起阅读请求。").addButton(b => b.setButtonText("检测连接").onClick(async () => {
      b.setDisabled(true); status.setText("正在连接本机 Codex…");
      try { await p.reconnect(); this.display(); this.containerEl.createEl("p", {text:`连接成功，发现 ${p.catalog.length} 个可用模型。`}); }
      catch(e) { status.setText(e.message); b.setDisabled(false); }
    }));
    if (p.catalog.length) {
      new Setting(el).setName("导读模型").addDropdown(d => {
        d.addOption("", "使用 Codex 默认模型"); p.catalog.forEach(m => d.addOption(m.model, m.displayName));
        if (p.settings.model && !p.catalog.some(m => m.model === p.settings.model)) d.addOption(p.settings.model, `${p.settings.model}（未在当前列表中）`);
        d.setValue(p.settings.model).onChange(async v => { p.settings.model = v; p.settings.effort = ""; await p.saveSettings(); this.display(); });
      });
      const selected = p.catalog.find(m => m.model === p.settings.model) || p.catalog.find(m => m.isDefault);
      new Setting(el).setName("思考强度").addDropdown(d => {
        d.addOption("", "模型默认"); selected?.supportedReasoningEfforts.forEach(e => d.addOption(e.value, e.value));
        d.setValue(p.settings.effort).onChange(async v => { p.settings.effort = v; await p.saveSettings(); });
      });
    } else el.createEl("p", {text:`模型：${p.settings.model || "Codex 默认"}。检测连接后可选择实际可用模型。`, cls:"gra-muted"});
  }
}

module.exports = GuidedReadingPlugin;
