const path = require("node:path");
const {spawn} = require("node:child_process");
const {CodexRpc, RpcError} = require("./codex-rpc");
const {discoverCodex, codexInvocation} = require("./codex-process");

const RESTRICTED_FEATURES = ["apps","plugins","multi_agent","standalone_web_search","browser_use","in_app_browser","computer_use","shell_tool"];
const failure = (code, message, cause) => Object.assign(new Error(message), {code, cause});

class CodexAppServerRuntime {
  constructor({vaultRoot, pluginVersion = "0.1.0", cliPath = "", requestTimeoutMs = 30000, turnTimeoutMs = 180000,
    ephemeralThreads = false, spawnProcess = spawn, discoverCli, environment = process.env} = {}) {
    if (!path.isAbsolute(vaultRoot || "")) throw new Error("Codex 连接需要本地库的绝对路径。");
    Object.assign(this, {pluginVersion, requestTimeoutMs, turnTimeoutMs, ephemeralThreads, spawnProcess, environment});
    this.vaultRoot = path.resolve(vaultRoot); this.configuredCliPath = cliPath; this.discoverCli = discoverCli;
    this.rpc = null; this.starting = null; this.active = null; this.occupied = false; this.serverNames = [];
    this.diagnostics = {initialized:false, authenticated:false, cliPath:"", lastErrorCode:null};
  }
  async ensureServer() {
    if (this.rpc && !this.rpc.closed && this.diagnostics.authenticated) return;
    if (!this.starting) this.starting = this.connect().finally(() => {this.starting = null;});
    return this.starting;
  }
  async connect() {
    try {
      const installation = this.discoverCli
        ? await this.discoverCli("codex", {configuredPath:this.configuredCliPath, environment:this.environment})
        : discoverCodex(this.configuredCliPath, this.environment);
      this.diagnostics.cliPath = installation.path;
      const argumentsForServer = ["app-server","--stdio","-c","mcp_servers={}","-c",'shell_environment_policy.inherit="none"'];
      for (const feature of RESTRICTED_FEATURES) argumentsForServer.push("--disable",feature);
      const invocation = codexInvocation(installation, argumentsForServer);
      const child = this.spawnProcess(invocation.command, invocation.args, {cwd:this.vaultRoot, env:invocation.environment, stdio:["pipe","pipe","pipe"], windowsHide:true, shell:false});
      const rpc = new CodexRpc(child, {timeout:this.requestTimeoutMs, notification:m => this.event(m), closed:error => {
        this.diagnostics.initialized = false; this.diagnostics.authenticated = false;
        this.finish(error);
      }});
      this.rpc = rpc;
      await rpc.request("initialize", {clientInfo:{name:"guided-reading-assistant",title:"Guided Reading Assistant",version:this.pluginVersion},capabilities:{experimentalApi:true}});
      rpc.notify("initialized"); this.diagnostics.initialized = true;
      const account = await rpc.request("account/read", {refreshToken:false});
      if (account?.requiresOpenaiAuth !== false && !account?.account) throw failure("CodexAuthRequired","Codex 尚未登录。请先完成官方 Codex 登录，再刷新 AI 连接。");
      this.diagnostics.authenticated = true;
      await this.readServerNames();
    } catch (error) {
      this.rpc?.close(error); this.diagnostics.lastErrorCode = error.code || "ConnectionFailed";
      throw error;
    }
  }
  async readServerNames() {
    const result = await this.rpc.request("config/read", {cwd:this.vaultRoot,includeLayers:false});
    if (!result?.config || typeof result.config !== "object") throw failure("AppServerIncompatible","Codex 未返回有效配置。请更新官方 Codex 后重试。");
    this.serverNames = Object.keys(result.config.mcp_servers || {});
  }
  configuration(researchEnabled) {
    return {features:Object.fromEntries(RESTRICTED_FEATURES.map(name => [name,false])),
      apps:{_default:{enabled:false,destructive_enabled:false,open_world_enabled:false}},
      mcp_servers:Object.fromEntries(this.serverNames.map(name => [name,{enabled:false}])),
      web_search:researchEnabled ? "live" : "disabled"};
  }
  async thread(threadId, baseInstructions, model, researchEnabled) {
    await this.readServerNames();
    const parameters = {approvalPolicy:"never",sandbox:"read-only",cwd:this.vaultRoot,baseInstructions:String(baseInstructions || ""),
      config:this.configuration(researchEnabled),runtimeWorkspaceRoots:[this.vaultRoot],...(model ? {model} : {})};
    let result;
    try {
      result = threadId
        ? await this.rpc.request("thread/resume", {...parameters,threadId})
        : await this.rpc.request("thread/start", {...parameters,dynamicTools:[],environments:[],selectedCapabilityRoots:[],...(this.ephemeralThreads ? {ephemeral:true} : {})});
    } catch (error) {
      if (threadId) throw failure("ThreadUnavailable","旧会话暂时无法恢复。可点击“新会话”继续。",error);
      throw error;
    }
    const sandbox = result?.sandbox;
    const roots = result?.runtimeWorkspaceRoots;
    if (!result?.thread?.id || result.approvalPolicy !== "never" || !(sandbox === "read-only" || sandbox?.type === "readOnly")
      || path.resolve(result.cwd || "") !== this.vaultRoot
      || (Array.isArray(roots) && roots.some(root => path.resolve(root) !== this.vaultRoot))) {
      throw failure("ReadOnlyBoundaryRejected","Codex 没有确认只读会话，因此没有发送书稿。");
    }
    try {
      const apps = await this.rpc.request("app/list", {threadId:result.thread.id,limit:100,forceRefetch:false});
      if ((apps?.data || []).some(app => app.isAccessible && app.isEnabled !== false)) throw failure("ExternalToolsAvailable","Codex 仍暴露了外部连接器，因此没有发送书稿。");
    } catch (error) { if (!(error instanceof RpcError && error.code === -32601)) throw error; }
    return result.thread.id;
  }
  async runTurn({threadId = "",baseInstructions = "",prompt,model = "",effort = "",researchEnabled = false,onEvent = () => {}} = {}) {
    if (this.occupied) throw failure("Busy","已有导读请求正在进行。");
    if (!String(prompt || "").trim()) throw failure("EmptyPrompt","没有可发送的导读请求。");
    this.occupied = true;
    try {
      await this.ensureServer();
      const id = await this.thread(threadId,baseInstructions,model,researchEnabled);
      let resolveTurn, rejectTurn;
      const completion = new Promise((resolve,reject) => {resolveTurn = resolve; rejectTurn = reject;});
      // Notifications can arrive before the turn/start response.
      completion.catch(() => {});
      const active = {threadId:id,turnId:"",text:"",onEvent,resolve:resolveTurn,reject:rejectTurn,done:false};
      this.active = active;
      active.timer = setTimeout(() => {
        const error = failure("TurnTimeout","本次导读超时，已停止连接。可以重新提问。");
        this.finish(error); this.rpc?.close(error);
      },this.turnTimeoutMs);
      try {
        const response = await this.rpc.request("turn/start", {threadId:id,input:[{type:"text",text:String(prompt)}],approvalPolicy:"never",cwd:this.vaultRoot,
          sandboxPolicy:{type:"readOnly",networkAccess:false},runtimeWorkspaceRoots:[this.vaultRoot],environments:[],...(model ? {model} : {}),...(effort ? {effort} : {})});
        if (!response?.turn?.id) throw failure("AppServerIncompatible","Codex 未返回有效的回合标识。");
        active.turnId = response.turn.id;
        onEvent({type:"started",threadId:id,turnId:active.turnId});
      } catch (error) { this.finish(error); }
      return await completion;
    } finally { this.occupied = false; this.active = null; }
  }
  event(message) {
    const {method,params = {}} = message;
    if (method === "mcpServer/startupStatus/updated" || method === "client/requestRejected") {
      const error = failure("ExternalToolsAvailable","Codex 请求了导读范围之外的能力，连接已停止。");
      this.finish(error); this.rpc?.close(error); return;
    }
    const turn = this.active;
    if (!turn || turn.done || params.threadId !== turn.threadId) return;
    const turnId = params.turnId || params.turn?.id;
    if (turn.turnId && turnId && turn.turnId !== turnId) return;
    if (!turn.turnId && turnId) turn.turnId = turnId;
    if (method === "item/agentMessage/delta") turn.text += String(params.delta || "");
    else if (method === "item/completed" && params.item?.type === "agentMessage") turn.text = String(params.item.text || turn.text);
    else if (method === "error" && params.willRetry === false) { this.finish(failure("TurnFailed","Codex 未能完成本次导读，可以重新提问。")); return; }
    else if (method === "turn/completed") {
      const status = params.turn?.status;
      if (status === "failed") this.finish(failure("TurnFailed","Codex 未能完成本次导读，可以重新提问。"));
      else if (status === "completed" && !turn.text.trim()) this.finish(failure("EmptyResponse","Codex 没有返回可显示的回答，可以重试。"));
      else this.finish(null,status || "interrupted");
      return;
    } else return;
    if (Buffer.byteLength(turn.text,"utf8") > 10 * 1024 * 1024) {
      const error = failure("OutputLimit","导读回答超过大小限制，连接已停止。"); this.finish(error); this.rpc?.close(error); return;
    }
    turn.onEvent({type:"delta",text:turn.text,threadId:turn.threadId,turnId:turn.turnId});
  }
  finish(error, status = "completed") {
    const turn = this.active;
    if (!turn || turn.done) return;
    turn.done = true; clearTimeout(turn.timer);
    if (error) {
      this.diagnostics.lastErrorCode = error.code || "TurnFailed";
      turn.onEvent({type:"failed",text:turn.text,threadId:turn.threadId,turnId:turn.turnId}); turn.reject(error);
    } else {
      const result = {status,text:turn.text,threadId:turn.threadId,turnId:turn.turnId};
      turn.onEvent({type:"completed",...result}); turn.resolve(result);
    }
  }
  async interrupt(target = {}) {
    const turn = this.active;
    if (!turn || !turn.turnId || turn.done) return false;
    await this.rpc.request("turn/interrupt", {threadId:target.threadId || turn.threadId,turnId:target.turnId || turn.turnId}); return true;
  }
  async shutdown() {
    const error = failure("TurnInterrupted","本次导读已停止。");
    if (this.active && !this.active.done && this.active.turnId) {
      void this.rpc?.request("turn/interrupt",{threadId:this.active.threadId,turnId:this.active.turnId}).catch(() => {});
    }
    this.finish(error); this.rpc?.close(error); this.rpc = null;
    this.diagnostics.initialized = false; this.diagnostics.authenticated = false;
  }
  getDiagnostics() { return {...this.diagnostics,activeTurnCount:this.active && !this.active.done ? 1 : 0}; }
  async listModels() {
    await this.ensureServer(); const result = []; const visited = new Set(); let cursor;
    do {
      const page = await this.rpc.request("model/list", {limit:100,includeHidden:false,...(cursor ? {cursor} : {})});
      if (!Array.isArray(page?.data)) throw failure("AppServerIncompatible","Codex 模型列表格式不正确。");
      for (const model of page.data) {
        if (model.hidden || !(model.model || model.id)) continue;
        result.push({model:model.model || model.id,displayName:model.displayName || model.model || model.id,isDefault:model.isDefault === true,
          defaultReasoningEffort:model.defaultReasoningEffort || "",supportedReasoningEfforts:(model.supportedReasoningEfforts || []).map(e => ({value:e.reasoningEffort || e.value,description:e.description || ""})).filter(e => e.value)});
      }
      cursor = page.nextCursor;
      if (cursor && visited.has(cursor)) throw failure("AppServerIncompatible","Codex 返回了重复的模型列表分页。");
      if (cursor) visited.add(cursor);
    } while (cursor);
    return result;
  }
}

module.exports = {CodexAppServerRuntime};
