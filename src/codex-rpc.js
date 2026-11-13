const {StringDecoder} = require("node:string_decoder");

class RpcError extends Error {
  constructor(message, code, data) { super(message); this.name = "RpcError"; this.code = code; this.data = data; }
}

// App Server's stdio transport uses one JSON-RPC object per UTF-8 line.
class CodexRpc {
  constructor(child, {timeout = 30000, maxBytes = 10 * 1024 * 1024, notification = () => {}, closed = () => {}} = {}) {
    Object.assign(this, {child, timeout, maxBytes, notification});
    this.onClosed = closed; this.pending = new Map(); this.sequence = 0; this.buffer = ""; this.decoder = new StringDecoder("utf8"); this.closed = false;
    child.stdout.on("data", bytes => this.receive(this.decoder.write(bytes)));
    child.on("error", error => this.close(new RpcError(error.message, "ProcessError")));
    child.on("exit", () => this.close(new RpcError("Codex 进程已退出。", "ProcessExited")));
    child.stdin.on("error", () => this.close(new RpcError("无法写入 Codex 连接。", "InputClosed")));
    // Drain stderr without displaying local configuration or authentication data.
    child.stderr?.on("data", () => {});
  }
  send(value) {
    if (this.closed) throw new RpcError("Codex 连接已关闭。", "ConnectionClosed");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  request(method, params = {}) {
    if (this.closed) return Promise.reject(new RpcError("Codex 连接已关闭。", "ConnectionClosed"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new RpcError(`Codex 请求超时：${method}`, "RequestTimeout"));
      }, this.timeout);
      this.pending.set(id, {resolve, reject, timer});
      try { this.send({id, method, params}); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params = {}) { this.send({method, params}); }
  receive(fragment) {
    if (this.closed) return;
    this.buffer += fragment;
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxBytes) { this.close(new RpcError("Codex 响应超过连接大小限制。", "OutputLimit")); return; }
    let newline;
    while (!this.closed && (newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("Invalid RPC object");
        if (typeof message.method === "string") {
          if (message.id != null) {
            // The guide never grants interactive tool approval or returns credentials.
            this.send({id:message.id, error:{code:-32601, message:"Interactive client requests are unavailable in this reading client."}});
            this.notification({method:"client/requestRejected", params:{method:message.method}});
          } else this.notification(message);
        } else if (message.id != null) {
          const pending = this.pending.get(message.id); if (!pending) continue;
          this.pending.delete(message.id); clearTimeout(pending.timer);
          if (message.error) pending.reject(new RpcError(String(message.error.message || "Codex 请求失败。"), message.error.code, message.error.data));
          else pending.resolve(message.result);
        }
      } catch (error) { this.close(new RpcError(`Codex 通信格式错误：${error.message}`, "ProtocolError")); }
    }
  }
  close(reason = new RpcError("Codex 连接已关闭。", "ConnectionClosed")) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(reason); }
    this.pending.clear(); this.buffer = "";
    this.onClosed(reason);
    try { this.child.kill(); } catch { /* The process may already have exited. */ }
  }
}

module.exports = {CodexRpc, RpcError};
