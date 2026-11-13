const {test} = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {EventEmitter} = require("node:events");
const {PassThrough} = require("node:stream");
const {CodexAppServerRuntime} = require("../src/codex-runtime");

class FakeServer extends EventEmitter {
  constructor() {
    super(); this.stdin=new PassThrough(); this.stdout=new PassThrough(); this.stderr=new PassThrough(); this.requests=[]; this.policy="never";
    let buffer="";
    this.stdin.on("data", chunk => {
      buffer+=chunk.toString(); let end;
      while ((end=buffer.indexOf("\n"))>=0) {const line=buffer.slice(0,end); buffer=buffer.slice(end+1); if(line) this.handle(JSON.parse(line));}
    });
  }
  send(value) {this.stdout.write(JSON.stringify(value)+"\n");}
  reply(request,result) {this.send({id:request.id,result});}
  handle(r) {
    this.requests.push(r); if(r.id==null)return;
    switch(r.method) {
      case "initialize": return this.reply(r,{userAgent:"test/1",platformOs:process.platform});
      case "account/read": return this.reply(r,{requiresOpenaiAuth:true,account:{type:"chatgpt"}});
      case "config/read": return this.reply(r,{config:{mcp_servers:{private_tool:{enabled:true,command:"no"}}}});
      case "app/list": return this.reply(r,{data:[]});
      case "thread/start": case "thread/resume": return this.reply(r,{thread:{id:r.params.threadId || "test-thread"},approvalPolicy:this.policy,sandbox:{type:"readOnly"},cwd:r.params.cwd,runtimeWorkspaceRoots:[r.params.cwd]});
      case "turn/start": {
        // Exercise the race where streaming events precede the start response.
        this.send({method:"item/agentMessage/delta",params:{threadId:"test-thread",turnId:"turn",delta:"先读原文"}});
        this.reply(r,{turn:{id:"turn"}});
        setImmediate(() => this.send({method:"turn/completed",params:{threadId:"test-thread",turn:{id:"turn",status:"completed"}}})); return;
      }
      default: return this.reply(r,{});
    }
  }
  kill() {this.emit("exit",0,null);}
}
function setup() {
  const server=new FakeServer();
  const runtime=new CodexAppServerRuntime({vaultRoot:path.resolve(__dirname),spawnProcess:() => server,
    discoverCli:async () => ({path:process.execPath,environment:process.env}),requestTimeoutMs:1000,turnTimeoutMs:1000});
  return {runtime,server};
}
test("Codex protocol preserves early stream events and enforces tools and read-only thread boundaries", async () => {
  const {runtime,server}=setup(); const events=[];
  try {
    const result=await runtime.runTurn({baseInstructions:"导读提示词",prompt:"阅读",researchEnabled:false,onEvent:e => events.push(e)});
    assert.equal(result.text,"先读原文"); assert.ok(events.some(e => e.type==="delta"));
    const start=server.requests.find(r => r.method==="thread/start").params;
    assert.equal(start.sandbox,"read-only"); assert.equal(start.approvalPolicy,"never");
    assert.equal(start.config.features.shell_tool,false); assert.equal(start.config.web_search,"disabled");
    assert.equal(start.config.mcp_servers.private_tool.enabled,false);
    assert.equal(server.requests.find(r => r.method==="initialize").params.clientInfo.name,"guided-reading-assistant");
    await runtime.runTurn({threadId:result.threadId,prompt:"追问",researchEnabled:true});
    const resume=server.requests.find(r => r.method==="thread/resume").params;
    assert.equal(resume.config.features.shell_tool,false); assert.equal(resume.config.web_search,"live");
  } finally {await runtime.shutdown();}
});
test("a server that fails to confirm read-only policy cannot receive book text", async () => {
  const {runtime,server}=setup(); server.policy="on-request";
  try {await assert.rejects(runtime.runTurn({prompt:"不应发送的正文"}),e => e.code==="ReadOnlyBoundaryRejected"); assert.ok(!server.requests.some(r => r.method==="turn/start"));}
  finally {await runtime.shutdown();}
});
