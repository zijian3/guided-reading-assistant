const path = require("node:path");
const {CodexAppServerRuntime} = require("../src/codex-runtime");
const runtime = new CodexAppServerRuntime({vaultRoot:path.resolve(__dirname, ".."), cliPath:process.argv.slice(2).find(arg => !arg.startsWith("--")) || "", ephemeralThreads:true, turnTimeoutMs:120000});
(async () => {
  try {
    const models = await runtime.listModels();
    console.log(JSON.stringify({connected:true, models:models.map(m => ({model:m.model, default:m.isDefault, efforts:m.supportedReasoningEfforts.map(e => e.value)}))}));
    if (process.argv.includes("--turn")) {
      const result = await runtime.runTurn({researchEnabled:false, baseInstructions:"你是只读读书助手。不要使用工具。", prompt:"这是连接验证。只回复：导读连接正常。"});
      console.log(JSON.stringify({status:result.status, text:result.text}));
    }
  } catch (e) { console.error(e.code, e.message, e.cause?.message || ""); process.exitCode = 1; }
  finally { await runtime.shutdown(); }
})();
