import { spawn } from 'node:child_process';
import { WebSocket } from '/data/data/com.termux/files/home/preview-bridge/node_modules/ws/wrapper.mjs';
const BIN = '/data/data/com.termux/files/home/preview-bridge/dist/index.js';
const ENV = { ...process.env, PREVIEW_BRIDGE_HTTP_PORT: '5352', PREVIEW_BRIDGE_RELAY_PORT: '5353' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function start(label) {
  const c = spawn('node', ['--no-warnings', BIN], { env: ENV, stdio: ['pipe','pipe','pipe'] });
  c.stderr.on('data', d => process.stderr.write(`[${label}] ${d}`));
  let buf = ''; const waiters = new Map();
  c.stdout.on('data', d => {
    buf += d;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) { if (!l.trim()) continue; const m = JSON.parse(l);
      if (waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } }
  });
  let id = 0;
  const rpc = (method, params) => new Promise(res => {
    const myId = ++id; waiters.set(myId, res);
    c.stdin.write(JSON.stringify({ jsonrpc:'2.0', id:myId, method, params }) + '\n');
  });
  return { proc: c, rpc, notify: (m,p) => c.stdin.write(JSON.stringify({jsonrpc:'2.0',method:m,params:p})+'\n') };
}
async function handshake(s) {
  await s.rpc('initialize', {protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'proof',version:'0'}});
  s.notify('notifications/initialized', {});
}
const call = async (s, name, args={}) => JSON.parse((await s.rpc('tools/call',{name,arguments:args})).result.content[0].text);

let pass = 0, fail = 0;
const check = (name, ok, detail='') => { ok ? (pass++, console.log(`  PASS  ${name}`)) : (fail++, console.log(`  FAIL  ${name}  ${detail}`)); };

const leader = start('LEADER'); await handshake(leader); await sleep(600);
const li = await call(leader, 'get_session_info');
check('leader elects itself', li.role === 'leader', JSON.stringify(li));

// Inject a distinctive event through the LEADER's WebSocket relay only.
const MARK = `proof-${Date.now()}`;
const ws = new WebSocket('ws://127.0.0.1:5353');
await new Promise(r => ws.on('open', r));
ws.send(JSON.stringify({ type:'hello', mode:'top-level', previewUrl:'http://example.test/proof' }));
ws.send(JSON.stringify({ type:'event', event:{ source:'iframe', level:'error', kind:'runtime-error',
  component:'proof', message: MARK, data:{ message: MARK, file:'proof.js', line: 42 } } }));
await sleep(400);

const follower = start('FOLLOWER'); await handshake(follower); await sleep(600);
const fi = await call(follower, 'get_session_info');
check('follower does not die on EADDRINUSE', !!fi && !fi.error, JSON.stringify(fi));
check('follower reports leader identity + own via', fi.role === 'leader' && fi.via?.role === 'follower', JSON.stringify(fi));
check('follower sees the leader-only WS client', fi.connectionsOpen === 1 && fi.previewUrl === 'http://example.test/proof', JSON.stringify(fi));

const log = await call(follower, 'get_event_log', { limit: 50 });
check('follower reads the LEADER-only event', (log.events??[]).some(e => e.message === MARK),
  `got ${(log.events??[]).map(e=>e.message).join(' | ')}`);
const errs = await call(follower, 'get_runtime_errors', {});
check('follower reads runtime errors from leader', (errs.errors??[]).some(e => e.message === MARK && e.line === 42), JSON.stringify(errs));
const st = await call(follower, 'query_preview_state', { kind: 'route' });
check('follower proxies a live state query (page has no responder → honest failure)',
  st.ok === false && /timeout/.test(st.error ?? ''), JSON.stringify(st));

// Promotion: kill the leader, the follower must take the ports.
console.log('  ... killing leader, waiting for promotion');
leader.proc.kill('SIGKILL'); ws.close();
await sleep(9000);
const after = await call(follower, 'get_session_info');
check('follower promotes itself to leader', after.role === 'leader' && after.via === undefined, JSON.stringify(after));

follower.proc.kill('SIGTERM');
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
