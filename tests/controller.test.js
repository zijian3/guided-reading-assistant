const {test} = require("node:test");
const assert = require("node:assert/strict");
const {ReadingController, SessionStore, normalizeState} = require("../src/controller");
const {initialState} = require("../src/book");

const clone = v => JSON.parse(JSON.stringify(v));
function setup() {
  const saved = new Map(); const calls = []; let fail = false;
  const runtime = {runTurn:async request => {
    calls.push(request); request.onEvent({type:"started",threadId:`thread-${calls.length}`,turnId:"turn-1"});
    request.onEvent({type:"delta",text:"依据原文，先读这一节。"});
    return {status:"completed",text:"依据原文，先读这一节。"};
  }, shutdown:async () => {}, interrupt:async () => {}};
  const c = new ReadingController({store:{load:async id => clone(saved.get(id) || null),save:async (id,s) => {if(fail) throw new Error("disk full"); saved.set(id,clone(s));}},runtime,
    libraryIO:() => ({paths:["A/1.md","A/2.md","B/1.md"],readText:async p => `# ${p}\n${p} 的原文`})});
  const a = {id:"a",title:"A书",sources:["A"],notes:"记录/A",configPath:"书架/A.md",prompt:"A 的专属提示词"};
  const b = {...a,id:"b",title:"B书",sources:["B"],prompt:"B 的专属提示词"};
  return {c,a,b,saved,calls,runtime,setFail:v => fail = v};
}
test("streamed discussion keeps per-book state, prompts and model threads isolated", async () => {
  const {c,a,b,calls} = setup(); await c.selectBook(a); await c.run("discuss","我这样理解对吗");
  assert.equal(c.state.messages[1].text,"依据原文，先读这一节。"); assert.equal(c.state.records.length,0);
  const position = clone(c.state.position); await c.run("discuss","再解释一下");
  assert.equal(calls[1].threadId,"thread-1"); assert.deepEqual(c.state.position,position);
  await c.selectBook(b); assert.equal(c.state.messages.length,0); await c.run("guide");
  assert.equal(calls[2].threadId,""); assert.ok(!calls[2].baseInstructions.includes("A 的专属"));
  assert.ok(!calls[2].prompt.includes("A/1.md"));
  await c.selectBook(a); assert.equal(c.state.messages.length,4);
});
test("prompt changes and source edits invalidate previous model thread", async () => {
  const {c,a,calls} = setup(); await c.selectBook(a); await c.run("guide");
  await c.selectBook({...a,prompt:"改用苏格拉底式追问"}); await c.run("guide"); assert.equal(calls[1].threadId,"");
  c.libraryIO = () => ({paths:["A/1.md"],readText:async () => "# 修改\n新材料"});
  await c.selectBook(a); assert.equal(c.state.threadId,""); assert.equal(c.state.readingMap,"");
});
test("only explicit record saving adds understanding; note must succeed first", async () => {
  const {c,a} = setup(); await c.selectBook(a); await c.run("finish");
  const before = clone(c.state.position); assert.equal(c.state.records.length,0);
  await assert.rejects(c.saveRecord({understanding:"我的复述",writeNote:async () => {throw new Error("write failed");}}));
  assert.equal(c.state.records.length,0);
  await c.saveRecord({understanding:"我的复述",questions:"这个概念的边界？",writeNote:async () => "记录/一.md"});
  assert.equal(c.state.records[0].path,"记录/一.md"); assert.deepEqual(c.state.position,before);
});
test("concurrent sends and movement are rejected while a turn is pending; stop leaves visible history", async () => {
  const {c,a,runtime} = setup(); await c.selectBook(a); let finish;
  runtime.runTurn = r => new Promise(resolve => {r.onEvent({type:"started",threadId:"thread",turnId:"turn"}); finish=resolve;});
  runtime.shutdown = async () => finish({status:"interrupted",text:"一部分解释"});
  const pending = c.run("guide"); await new Promise(r => setImmediate(r));
  await assert.rejects(c.run("guide"),/请先停止/); await assert.rejects(c.setPosition(1),/请先停止/);
  await c.stop(); await pending;
  assert.equal(c.busy,false); assert.equal(c.state.messages[1].status,"interrupted"); assert.equal(c.state.threadId,"");
});
test("disk error prevents sending, and later draft saves are not stuck behind the failed save", async () => {
  const {c,a,calls,setFail,saved} = setup(); await c.selectBook(a); setFail(true); await assert.rejects(c.run("guide"),/disk full/);
  assert.equal(calls.length,0); assert.equal(c.busy,false); setFail(false); await c.setDraft("保留这个问题"); assert.equal(saved.get("a").draft,"保留这个问题");
});
test("selection refuses another book or a future unit without sending", async () => {
  const {c,a,calls} = setup(); await c.selectBook(a);
  await assert.rejects(c.run("selection","",{path:"B/1.md",text:"secret",startLine:1,endLine:2}),/选区需要/);
  assert.equal(calls.length,0);
});
test("interrupted sessions recover to visible incomplete messages with a new model thread", () => {
  const s = initialState(); s.threadId="old"; s.messages=[{role:"assistant",status:"pending",text:"一半"}];
  const recovered = normalizeState(s); assert.equal(recovered.threadId,""); assert.equal(recovered.messages[0].status,"interrupted");
  assert.throws(() => normalizeState({schema:9}));
});

function memoryAdapter() {
  const data = new Map();
  return {data, exists:async p => data.has(p), mkdir:async p => data.set(p,"dir"), read:async p => data.get(p), write:async (p,v) => data.set(p,v), remove:async p => data.delete(p), rename:async (a,b) => { if(!data.has(a)) throw new Error("missing"); data.set(b,data.get(a));data.delete(a); }};
}
test("session store keeps previous snapshot and recovers from an interrupted rename", async () => {
  const adapter = memoryAdapter(); const store = new SessionStore(adapter,"sessions");
  await store.save("a",{schema:1,draft:"before"}); await store.save("a",{schema:1,draft:"after"});
  assert.equal((await store.load("a")).draft,"after"); assert.equal(JSON.parse(adapter.data.get("sessions/a.json.bak")).draft,"before");
  adapter.data.delete("sessions/a.json"); assert.equal((await store.load("a")).draft,"before");
  adapter.data.set("sessions/a.json","broken"); await assert.rejects(store.load("a"),/原文件和/);
  assert.equal(adapter.data.get("sessions/a.json"),"broken");
});
