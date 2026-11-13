const { randomUUID } = require("crypto");
const { initialState, loadLibrary, locateUnit, movePosition, positionOf, buildTurn, digest } = require("./book");

const LABELS = {map:"建立阅读路线",guide:"开始／继续导读",discuss:"讨论",selection:"分析选区",review:"回顾疑问",finish:"结束本次阅读"};

class ReadingController {
  constructor({store, runtime, libraryIO, modelOptions = () => ({}), onError = () => {}}) {
    Object.assign(this, {store, runtime, libraryIO, modelOptions, onError});
    this.book = null; this.library = null; this.state = null; this.busy = false;
    this.listeners = new Set(); this.queue = Promise.resolve(); this.active = null; this.error = "";
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind = "change") { for (const fn of this.listeners) fn(kind); }
  assertIdle() { if (this.busy) throw new Error("请先停止或等待本次回答完成。"); }
  persist() {
    const id = this.book.id; const snapshot = JSON.parse(JSON.stringify(this.state));
    const pending = this.queue.then(() => this.store.save(id, snapshot));
    this.queue = pending.catch(error => { this.error = `保存失败：${error.message}。请保留当前窗口并重试。`; this.onError(this.error); this.emit("error"); });
    return pending;
  }
  async selectBook(book) {
    this.assertIdle(); this.busy = true;
    try {
    await this.queue;
    const library = await loadLibrary(book, this.libraryIO());
    const saved = await this.store.load(book.id);
    const state = normalizeState(saved);
    // Reordering/edits invalidate thread history, especially for spoiler boundaries.
    if (state.sourceFingerprint && state.sourceFingerprint !== library.fingerprint) {
      state.threadId = ""; state.furthest = null;
      state.readingMap = "";
    }
    state.sourceFingerprint = library.fingerprint;
    const index = locateUnit(library, state.position);
    state.position = positionOf(library.units[index]);
    if (!state.furthest) state.furthest = state.position;
    this.book = book; this.library = library; this.state = state; this.error = "";
    await this.persist();
    } finally { this.busy = false; this.emit(); }
  }
  async setPosition(index) {
    this.assertIdle(); movePosition(this.state, this.library, index);
    await this.persist(); this.emit();
  }
  async setDraft(text) { this.state.draft = text; await this.persist(); }
  async newConversation() {
    this.assertIdle(); this.state.threadId = ""; await this.persist(); this.emit();
  }
  async run(action, question = "", selection = null) {
    this.assertIdle();
    if (!this.book) throw new Error("请先选择一本书。");
    if (action === "discuss" && !question.trim()) throw new Error("先写下问题或你的复述。");
    if (action === "selection") {
      if (!selection?.text?.trim()) throw new Error("请先在书稿中选择一段文字。");
      const current = this.library.units[locateUnit(this.library, this.state.position)];
      if (selection.path !== current.path || selection.startLine < current.startLine || selection.endLine > current.endLine) {
        throw new Error("选区需要位于当前阅读单元。先在助手中切换到这段正文。");
      }
    }
    this.busy = true; this.error = "";
    const request = buildTurn(this.book, this.library, this.state, action, question, {selection: selection?.text || ""});
    const options = this.modelOptions();
    const hash = digest(request.instructionHash + this.library.fingerprint + JSON.stringify(options));
    if (this.state.instructionHash !== hash) this.state.threadId = "";
    this.state.instructionHash = hash;
    const user = {id:randomUUID(), role:"user", text:question || LABELS[action], action, at:new Date().toISOString(), status:"complete", position:this.state.position};
    const reply = {id:randomUUID(), role:"assistant", text:"", action, at:user.at, status:"pending", position:this.state.position};
    if (selection) user.text += `\n\n> ${selection.text.replace(/\n/g, "\n> ")}`;
    this.state.messages.push(user, reply); this.state.draft = "";
    this.active = {cancelled:false, threadId:"", turnId:""}; const active = this.active;
    this.emit();
    try {
      await this.persist();
      if (active.cancelled) throw new Error("本次导读已停止。");
      const result = await this.runtime.runTurn({
        ...request, ...options, threadId:this.state.threadId,
        onEvent:event => {
          if (event.threadId) { active.threadId = event.threadId; this.state.threadId = event.threadId; }
          if (event.turnId) active.turnId = event.turnId;
          if (typeof event.text === "string") reply.text = event.text;
          if (event.type === "started" && active.cancelled) void this.runtime.interrupt(active).catch(this.onError);
          this.emit("stream");
        },
      });
      reply.text = result.text; reply.status = active.cancelled || result.status === "interrupted" ? "interrupted" : "complete";
      if (action === "map" && reply.status === "complete") this.state.readingMap = reply.text;
    } catch (error) {
      reply.status = active.cancelled ? "interrupted" : "failed";
      reply.error = active.cancelled ? "已停止，可继续提问。" : `${error.message}${error.code === "ThreadUnavailable" ? " 请点“新会话”后重试。" : ""}`;
      this.error = reply.error;
    } finally {
      // Interrupted context may contain unfinished reasoning; start a clean turn.
      if (reply.status !== "complete") this.state.threadId = "";
      try { await this.persist(); } finally { this.busy = false; this.active = null; this.emit(); }
    }
    return reply;
  }
  async stop() {
    if (!this.active) return;
    this.active.cancelled = true;
    if (this.active.turnId) {
      // shutdown also covers a lost interrupt ACK, and is restartable.
      await this.runtime.shutdown();
    }
    this.emit();
  }
  async saveRecord({understanding, questions = "", assessment = "仍在理解", writeNote}) {
    this.assertIdle();
    if (!String(understanding).trim() && !String(questions).trim()) throw new Error("请至少写下自己的理解或疑问。");
    const record = {id:randomUUID(), at:new Date().toISOString(), position:{...this.state.position}, understanding:String(understanding).trim(), questions:String(questions).trim(), assessment};
    record.path = await writeNote(record);
    this.state.records.push(record); await this.persist(); this.emit(); return record;
  }
}

function normalizeState(saved) {
  if (saved != null && (typeof saved !== "object" || Array.isArray(saved) || saved.schema !== 1)) throw new Error("阅读记录版本不兼容，已保留原文件。");
  const state = {...initialState(), ...(saved || {})};
  for (const key of ["messages", "records"]) if (!Array.isArray(state[key])) throw new Error("阅读记录损坏，已保留原文件。");
  for (const key of ["threadId", "instructionHash", "draft", "readingMap"]) if (typeof state[key] !== "string") throw new Error("阅读记录格式不正确，已保留原文件。");
  let interrupted = false;
  state.messages = state.messages.map(m => m.status === "pending" ? (interrupted = true, {...m, status:"interrupted", error:"上次回答未完成，可以重新提问。"}) : m);
  if (interrupted) state.threadId = "";
  return state;
}

// JSON is replaced only after a complete temporary write. Keep the previous
// snapshot for recovery, and never silently replace an unreadable session.
class SessionStore {
  constructor(adapter, root) { this.adapter = adapter; this.root = root; }
  path(id) { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("无效书籍 id。"); return `${this.root}/${id}.json`; }
  async load(id) {
    const path = this.path(id);
    if (!await this.adapter.exists(path)) {
      if (await this.adapter.exists(path + ".bak")) return JSON.parse(await this.adapter.read(path + ".bak"));
      return null;
    }
    try { return JSON.parse(await this.adapter.read(path)); }
    catch { throw new Error(`无法读取会话 ${path}。原文件和 .bak 备份已保留，请先恢复备份。`); }
  }
  async save(id, value) {
    const path = this.path(id); const tmp = path + ".tmp"; const bak = path + ".bak";
    if (!await this.adapter.exists(this.root)) await this.adapter.mkdir(this.root);
    await this.adapter.write(tmp, JSON.stringify(value, null, 2));
    if (await this.adapter.exists(path)) {
      if (await this.adapter.exists(bak)) await this.adapter.remove(bak);
      await this.adapter.rename(path, bak);
    }
    await this.adapter.rename(tmp, path);
  }
}

module.exports = {ReadingController, SessionStore, normalizeState, LABELS};
