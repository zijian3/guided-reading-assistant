const {test} = require("node:test");
const assert = require("node:assert/strict");
const {readFileSync} = require("node:fs");
const {createRequire} = require("node:module");
const vm = require("node:vm");
const path = require("node:path");
const {parseHTML} = require("linkedom");
const {serializeBook, initialState, loadLibrary, positionOf} = require("../src/book");
const {ReadingController} = require("../src/controller");

function setup() {
  const {window,document} = parseHTML("<html><body></body></html>");
  const proto=window.HTMLElement.prototype;
  proto.createEl=function(tag,options={}) {
    const el=document.createElement(tag); if(options.text) el.textContent=options.text;
    if(options.cls) el.className=options.cls;
    if(options.value!=null) el.setAttribute("value",options.value);
    for(const [key,value] of Object.entries(options.attr || {})) el.setAttribute(key,value);
    this.appendChild(el); return el;
  };
  proto.createDiv=function(o) {return this.createEl("div",typeof o === "string" ? {cls:o} : o);};
  proto.createSpan=function(o) {return this.createEl("span",o);};
  proto.empty=function() {this.replaceChildren();}; proto.setText=function(text) {this.textContent=text;};
  proto.addClass=function(name) {this.classList.add(name);};
  // linkedom models select.value as readonly; browsers and Obsidian allow writes.
  Object.defineProperty(window.HTMLSelectElement.prototype,"value",{configurable:true,get(){return this._value || this.querySelector("option")?.getAttribute("value") || "";},set(v){this._value=String(v);}});
  const notices=[];
  class Component {load(){} unload(){}}
  class Plugin extends Component {
    constructor() {super();this.app={};this.manifest={id:"guided-reading-assistant",version:"0.1.0",dir:".obsidian/plugins/guided-reading-assistant"};}
    async loadData(){return null;} async saveData(){} registerView(id,factory){this.factory=factory;}
    addRibbonIcon(){} addCommand(){} registerEvent(){} addSettingTab(){}
  }
  class ItemView extends Component {constructor(leaf){super();this.app=leaf.app;this.contentEl=document.createElement("div");}}
  class Modal {} class Setting {} class PluginSettingTab {} class TFile {constructor(path){this.path=path;this.extension="md";}}
  const obsidian={Plugin,ItemView,Modal,Setting,PluginSettingTab,TFile,Notice:class {constructor(s){notices.push(s);}},Component,
    parseYaml:JSON.parse,stringifyYaml:JSON.stringify,MarkdownRenderer:{render:async (_app,text,el) => {el.textContent=text;}}};
  const filename=path.resolve(__dirname,"../src/main.js"); const actualRequire=createRequire(filename); const module={exports:{}};
  vm.runInNewContext(readFileSync(filename,"utf8"), {require:name => name==="obsidian" ? obsidian : actualRequire(name),module,exports:module.exports,setTimeout,clearTimeout,console});
  return {Plugin:module.exports,document,window,notices,TFile};
}
const tick=() => new Promise(resolve => setImmediate(resolve));

test("Obsidian view offers book-level guide, renders responses, restores draft and saves no automatic understanding", async () => {
  const {Plugin,document,window,TFile}=setup(); const p=new Plugin(); const body=new TFile("正文/01.md");
  p.app={vault:{adapter:{getBasePath:() => process.cwd()},getMarkdownFiles:() => [body],cachedRead:async () => "# 第一节\n原书观点。"},workspace:{on:() => ({})}};
  await p.onload();
  const book={id:"test",title:"通用测试书",sources:["正文"],notes:"记录",configPath:"书架/配置.md",prompt:"先问再讲"};
  const saved=new Map(); p.controller=new ReadingController({runtime:{runTurn:async r => {r.onEvent({type:"started",threadId:"id",turnId:"turn"});r.onEvent({type:"delta",text:"先观察原文中的问题。"});return {status:"completed",text:"先观察原文中的问题。"};}},
    store:{load:async id => saved.get(id),save:async (id,v) => saved.set(id,structuredClone(v))},libraryIO:() => ({paths:[body.path],readText:async () => "# 第一节\n原书观点。"})});
  await p.controller.selectBook(book); await p.controller.setDraft("我这样理解对吗");
  p.refreshActive=async () => {}; p.configErrors=[];
  const view=p.factory({app:p.app}); view.books=[book]; view.render(); document.body.appendChild(view.contentEl);
  assert.ok(view.contentEl.textContent.includes("建立阅读路线")); assert.ok(view.contentEl.textContent.includes("保存阅读记录"));
  assert.ok(view.contentEl.textContent.includes("刷新 AI 连接"));
  assert.equal(view.input.value,"我这样理解对吗");
  assert.ok(view.contentEl.querySelector(".gra-chat").textContent.includes("先建立阅读路线"));
  await view.send("discuss"); view.render(); await view.renderMessages();
  assert.ok(view.chatEl.textContent.includes("先观察原文中的问题。")); assert.equal(p.controller.state.records.length,0);
  assert.equal(p.controller.state.position.path,body.path); assert.equal(p.controller.state.messages.length,2);
  const before=structuredClone(p.controller.state.position);
  view.input.value="下次继续这个疑问"; view.input.dispatchEvent(new window.Event("input")); await view.flushDraft(); clearTimeout(view.draftTimer);
  assert.equal(saved.get("test").draft,"下次继续这个疑问"); assert.deepEqual(p.controller.state.position,before);
  await view.onClose();
});

test("refresh connection restarts Codex, reads models and releases controls on success or failure", async () => {
  const {Plugin}=setup(); const p=new Plugin();
  p.settings={cliPath:"C:/codex.exe"}; let closed=0; let emitted=0;
  p.controller={busy:false,assertIdle(){if(this.busy)throw new Error("busy");},emit(){emitted++;}};
  p.runtime={shutdown:async () => {closed++;},listModels:async () => [{model:"available-model"}]};
  assert.equal((await p.reconnect())[0].model,"available-model"); assert.equal(closed,1); assert.equal(p.runtime.configuredCliPath,"C:/codex.exe");
  assert.equal(p.controller.busy,false); assert.match(p.connectionStatus,/已连接/); assert.equal(emitted,2);
  p.runtime.listModels=async () => {throw new Error("offline");};
  await assert.rejects(p.reconnect(),/offline/); assert.equal(p.controller.busy,false); assert.match(p.connectionStatus,/offline/);
});

test("book scanner lists valid configurations and reports duplicate ids without mixing sessions", async () => {
  const {Plugin,TFile}=setup(); const p=new Plugin(); p.settings={libraryRoot:"书架"};
  const files=[new TFile("书架/一.md"),new TFile("书架/二.md"),new TFile("其他/三.md")];
  const text=serializeBook({id:"same",title:"一本书",sources:["正文"],notes:"记录"},JSON.stringify);
  p.app={vault:{getMarkdownFiles:() => files,cachedRead:async () => text}};
  const books=await p.scanBooks();
  assert.equal(books.length,1); assert.equal(p.configErrors.length,1); assert.match(p.configErrors[0],/id 重复/);
});
