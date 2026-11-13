const {test} = require("node:test");
const assert = require("node:assert/strict");
const {vaultPath, selectSources, splitUnits, loadLibrary, initialState, movePosition, buildTurn, parseBook, serializeBook} = require("../src/book");

const book = {id:"book-one", title:"测试书", configPath:"书架/一.md", sources:["书稿"], notes:"笔记", prompt:"用反例引导理解", external:false, strictSpoilers:false};
const makeLibrary = async () => loadLibrary(book, {paths:["书稿/01.md","书稿/02.md"], readText:async p => p.endsWith("01.md") ? "---\ntitle: 开始\n---\n# 问题\n这是原文依据。\n\n## 概念\n先区分概念。" : "# 后文秘密\n结局：角色离开。"});

test("relative book paths reject traversal, hidden data and absolute paths", () => {
  for (const value of ["../x", "C:/x", "/x", "a/../x", ".obsidian", "a/.git", "a//b"]) assert.throws(() => vaultPath(value));
  assert.equal(vaultPath("书稿\\第一章.md"), "书稿/第一章.md");
});
test("sources respect listed order, natural chapter sort and exclude notes/config", () => {
  const paths = ["书稿/10.md","书稿/2.md","书稿2/1.md","书稿/a.pdf","笔记/01.md","书架/一.md"];
  assert.deepEqual(selectSources({...book, sources:["书稿2","书稿","书稿/2.md"]}, paths), ["书稿2/1.md","书稿/2.md","书稿/10.md"]);
});
test("fenced headings do not split units; source line references survive frontmatter", () => {
  const units = splitUnits("---\nx: 1\n---\n# A\n```md\n# fake\n```\n## B\n正文", "a.md");
  assert.equal(units.length, 2); assert.equal(units[0].startLine, 4); assert.equal(units[1].startLine, 8);
  assert.ok(units[0].text.includes("# fake"));
});
test("identical units have distinct stable ids; long prose preserves all content", () => {
  const text = "# A\n重复\n# A\n重复";
  const units = splitUnits(text,"a.md"); assert.notEqual(units[0].id, units[1].id);
  assert.deepEqual(splitUnits(text,"a.md"), units);
  const long = splitUnits("# A\n" + "长".repeat(6500) + "\n\n结尾", "a.md");
  assert.equal(long.length, 2); assert.ok(long[1].text.includes("结尾"));
});
test("strict mode excludes future content and prior unrestricted conversations", async () => {
  const library = await makeLibrary(); const state = initialState(); movePosition(state,library,0);
  state.readingMap = "结局：角色离开"; state.messages.push({status:"complete",text:"后文秘密"});
  const turn = buildTurn({...book, strictSpoilers:true, external:true},library,state,"map");
  assert.ok(!turn.prompt.includes("后文秘密")); assert.ok(!turn.prompt.includes("角色离开"));
  assert.equal(turn.researchEnabled, false);
  const parsed = parseBook(serializeBook({...book,strictSpoilers:true,external:true}, JSON.stringify),book.configPath,JSON.parse);
  assert.equal(parsed.external,false);
});
test("roadmap includes actual cross-chapter excerpts and discloses limited evidence", async () => {
  const library = await makeLibrary(); const turn = buildTurn(book,library,initialState(),"map");
  assert.ok(turn.prompt.includes("角色离开")); assert.ok(turn.prompt.includes("不能据此声称已核读全书正文"));
  assert.ok(turn.baseInstructions.includes(book.prompt)); assert.equal(turn.researchEnabled,false);
});
test("explicit movement updates location, never understanding", async () => {
  const library = await makeLibrary(); const state = initialState(); state.threadId = "old";
  movePosition(state,library,2); assert.equal(state.position.path,"书稿/02.md"); assert.equal(state.threadId,""); assert.equal(state.records.length,0);
  movePosition(state,library,0); assert.equal(state.furthest.path,"书稿/02.md");
});
test("config roundtrip keeps each book's custom prompt and metadata", () => {
  const result = parseBook(serializeBook({...book, notes:"读书助手/记录", external:true}, JSON.stringify),book.configPath,JSON.parse);
  assert.equal(result.prompt,book.prompt); assert.equal(result.external,true); assert.deepEqual(result.sources,book.sources);
});
