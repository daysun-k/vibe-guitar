// VGT-13 spike: `npm run phone` starts the local relay for the phone-as-music-stand probe.
// Publisher (extension page) on 127.0.0.1 only; phone page on the LAN address; nothing is written to disk.
import { buildViewer, loadRelay, parseArgs } from './phone-lib.mjs';

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(2);
}
if (opts.help) {
  console.log('usage: npm run phone -- [--host <lan ipv4>] [--port 47822] [--pub-port 47821] [--extension-id <id>]');
  process.exit(0);
}

const { startRelay, encodeQr, qrToTerminal } = await loadRelay();
const viewer = await buildViewer();
const stamp = () => new Date().toTimeString().slice(0, 8);
let relay;
try {
  relay = await startRelay({ ...opts, ...viewer, log: (line) => console.log(`[${stamp()}] ${line}`) });
} catch (e) {
  console.error(`relay failed to start: ${e.message ?? e}`);
  if (e.code === 'EADDRINUSE') console.error('a port is busy: is another `npm run phone` still running? (or pass --port / --pub-port)');
  process.exit(1);
}

console.log('');
console.log(qrToTerminal(encodeQr(relay.viewerUrl)));
console.log('');
console.log(`휴대폰(같은 Wi-Fi)에서 열 주소: ${relay.viewerUrl}`);
console.log(`확장 시험 페이지가 접속할 주소: ${relay.publisherUrl} (이 Mac 안에서만 열림)`);
console.log('토큰은 이번 실행에서만 유효하고 어디에도 저장하지 않습니다. 끝내려면 Ctrl+C.');
console.log('');

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  console.log('\nstopping relay…');
  const force = setTimeout(() => process.exit(0), 2000);
  await relay.close();
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
