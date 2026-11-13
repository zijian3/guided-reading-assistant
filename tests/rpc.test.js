const {test} = require("node:test");
const assert = require("node:assert/strict");
const {EventEmitter} = require("node:events");
const {PassThrough} = require("node:stream");
const {CodexRpc} = require("../src/codex-rpc");

function transport(options = {}) {
  const process = new EventEmitter();
  process.stdin = new PassThrough(); process.stdout = new PassThrough(); process.stderr = new PassThrough();
  process.kill = () => {process.killed = true; process.emit("exit",0);};
  const rpc = new CodexRpc(process,options);
  return {process,rpc};
}
test("JSON-RPC preserves split UTF-8 Chinese text and resolves out-of-order replies", async () => {
  const events = []; const {rpc,process} = transport({notification:event => events.push(event)});
  try {
    const one = rpc.request("one"); const two = rpc.request("two");
    const bytes = Buffer.from(JSON.stringify({method:"message",params:{text:"读书理解"}})+"\n");
    for (const byte of bytes) process.stdout.write(Buffer.from([byte]));
    process.stdout.write('{"id":2,"result":"second"}\n{"id":1,"result":"first"}\n');
    assert.deepEqual(await Promise.all([one,two]),["first","second"]);
    assert.equal(events[0].params.text,"读书理解");
  } finally {rpc.close();}
});
test("invalid protocol and oversized output close the process and reject pending requests", async () => {
  for (const [output,options,code] of [["not JSON\n",{},"ProtocolError"],["x".repeat(100),{maxBytes:20},"OutputLimit"]]) {
    const {rpc,process} = transport(options); const pending = rpc.request("pending");
    process.stdout.write(output); await assert.rejects(pending,error => error.code === code);
    assert.equal(process.killed,true); assert.equal(rpc.pending.size,0);
  }
});
test("server requests are rejected instead of granting approval or returning credentials", async () => {
  const events = []; const {rpc,process} = transport({notification:event => events.push(event)}); let written="";
  process.stdin.on("data",value => written += value.toString());
  process.stdout.write('{"id":"approve-1","method":"item/commandExecution/requestApproval","params":{}}\n');
  assert.equal(JSON.parse(written).error.code,-32601); assert.equal(events[0].method,"client/requestRejected"); rpc.close();
});
test("request timeout releases the pending entry without leaking a timer", async () => {
  const {rpc} = transport({timeout:15});
  try {await assert.rejects(rpc.request("slow"),error => error.code === "RequestTimeout");assert.equal(rpc.pending.size,0);}
  finally {rpc.close();}
});
