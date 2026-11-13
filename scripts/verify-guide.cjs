const assert = require("node:assert/strict");
const path = require("node:path");
const {CodexAppServerRuntime} = require("../src/codex-runtime");
const {ReadingController} = require("../src/controller");
const runtime = new CodexAppServerRuntime({vaultRoot:path.resolve(__dirname, ".."), cliPath:process.argv[2] || "", turnTimeoutMs:90000});
const snapshots = new Map();
const controller = new ReadingController({runtime,store:{load:async id => snapshots.get(id),save:async (id,s) => snapshots.set(id,structuredClone(s))},
  libraryIO:() => ({paths:["测试书/01.md","测试书/02.md"],readText:async p => p.endsWith("01.md")
    ? "# 观察与判断\n观察是记录可以核对的现象。判断是对现象作出解释。同一现象可以有多种解释，应提出能区分解释的验证方式。比如门口排队是观察，排队必定因为服务慢是判断。"
    : "# 小实验\n每次只改变一个因素，观察结果。改变多个因素时，很难判断哪个因素造成结果。"})});
(async () => {
  try {
    await controller.selectBook({id:"synthetic-guide-check",title:"观察与实验（合成测试书稿）",sources:["测试书"],notes:"测试记录",configPath:"测试配置.md",prompt:"用中文引导阅读。每次回答控制在 150 字以内。先给一个简短阅读任务和一个问题；复述后给出具体纠偏。",external:false,strictSpoilers:false});
    const position = structuredClone(controller.state.position);
    const first = await controller.run("guide"); assert.equal(first.status,"complete");
    const thread = controller.state.threadId;
    const second = await controller.run("discuss","我理解为：看到门口排队，就能确定服务速度很慢。这个复述对吗？");
    assert.equal(second.status,"complete"); assert.equal(controller.state.threadId,thread);
    assert.deepEqual(controller.state.position,position); assert.equal(controller.state.records.length,0);
    console.log(JSON.stringify({guide:first.text,followup:second.text,conversationResumed:true,positionUnchanged:true,noAutomaticUnderstanding:true}));
  } catch(e) { console.error(e.code || "VerificationFailed",e.message,e.cause?.message || ""); process.exitCode=1; }
  finally {await runtime.shutdown();}
})();
