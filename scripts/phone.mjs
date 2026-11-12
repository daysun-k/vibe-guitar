// VGT-13: `npm run phone` starts the local relay for the phone music stand (휴대폰 악보대).
// Side panel on 127.0.0.1 only; phone page on this Mac's home-network address; nothing is written to disk.
import { buildViewer, distPath, loadRelay, parseArgs } from './phone-lib.mjs';

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(2);
}
if (opts.help) {
  console.log('usage: npm run phone -- [--host <lan ipv4>] [--port 47822] [--extension-id <id> | --any-extension]');
  console.log('  --extension-id  the id chrome://extensions shows for Vibe Guitar (default: the id of this repo\'s dist folder)');
  console.log('  --any-extension accept any Chrome extension on this Mac as the publisher (not recommended)');
  process.exit(0);
}

const R = await loadRelay();
const viewer = await buildViewer();
const dist = await distPath();
const extensionId = opts.anyExtension ? undefined : (opts.extensionId ?? R.unpackedExtensionId(dist));
const stamp = () => new Date().toTimeString().slice(0, 8);
let relay;
try {
  relay = await R.startRelay({ host: opts.host, port: opts.port, pubPort: opts.pubPort, extensionId, ...viewer, log: (line) => console.log(`[${stamp()}] ${line}`) });
} catch (e) {
  console.error(`relay failed to start: ${e.message ?? e}`);
  if (e.code === 'EADDRINUSE') console.error('a port is busy: is another `npm run phone` still running? (or pass --port)');
  process.exit(1);
}

console.log('');
console.log(R.qrToTerminal(R.encodeQr(relay.viewerUrl)));
console.log('');
console.log(`휴대폰(같은 Wi-Fi)에서 열 주소: ${relay.viewerUrl}`);
console.log(`패널이 접속할 주소: ${relay.publisherUrl} (이 Mac 안에서만 열림)`);
console.log(
  extensionId
    ? `받는 확장: ${extensionId} (${opts.extensionId ? '--extension-id' : `${dist} 폴더를 "압축해제된 확장 프로그램"으로 불러온 경우`})`
    : '받는 확장: 이 Mac의 모든 Chrome 확장 (--any-extension)',
);
console.log('패널 › 연주 설정 › 휴대폰 악보대를 켜면 코드와 재생 위치를 휴대폰으로 보냅니다. 소리와 가사는 보내지 않습니다.');
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
