const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const readableFile = candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } };

function discoverCodex(configuredPath = "", environment = process.env) {
  const home = environment.USERPROFILE || environment.HOME || os.homedir();
  const explicit = String(configuredPath).trim().replace(/^"(.*)"$/, "$1").replace(/^~(?=[/\\])/, home);
  const candidates = [];
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error("请填写 Codex 可执行文件的绝对路径。");
    candidates.push(explicit);
  } else {
    const envPath = Object.entries(environment).find(([key]) => key.toLowerCase() === "path")?.[1] || "";
    const directories = envPath.split(path.delimiter).map(p => p.replace(/^"|"$/g, "")).filter(p => path.isAbsolute(p));
    directories.push(path.join(home,".local","bin"), path.join(home,".npm-global","bin"));
    if (process.platform === "win32") {
      directories.push(path.join(environment.APPDATA || path.join(home,"AppData","Roaming"),"npm"));
      const desktop = path.join(environment.LOCALAPPDATA || path.join(home,"AppData","Local"),"OpenAI","Codex","bin");
      try { for (const entry of fs.readdirSync(desktop).sort().reverse()) directories.push(path.join(desktop,entry)); } catch { /* Desktop app is optional. */ }
    } else directories.push("/usr/local/bin","/opt/homebrew/bin","/usr/bin");
    for (const directory of new Set(directories)) {
      candidates.push(path.join(directory,process.platform === "win32" ? "codex.exe" : "codex"));
      candidates.push(path.join(directory,"node_modules","@openai","codex","bin","codex.js"));
      candidates.push(path.resolve(directory,"..","lib","node_modules","@openai","codex","bin","codex.js"));
    }
  }
  for (let candidate of candidates) {
    if (/\.cmd$/i.test(candidate)) candidate = path.join(path.dirname(candidate),"node_modules","@openai","codex","bin","codex.js");
    if (readableFile(candidate)) return {path:candidate, environment};
  }
  throw new Error("未找到 Codex。请先安装官方 Codex CLI，或在插件设置中填写 codex.exe / codex.js 的完整路径。");
}

function codexInvocation(installation, args) {
  const environment = {...(installation.environment || process.env)};
  if (/\.(?:c?js|mjs)$/i.test(installation.path)) {
    // Obsidian's Electron executable can run the official Node.js entry point.
    if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = "1";
    return {command:process.execPath, args:[installation.path, ...args], environment};
  }
  return {command:installation.path, args, environment};
}

module.exports = {discoverCodex, codexInvocation};
