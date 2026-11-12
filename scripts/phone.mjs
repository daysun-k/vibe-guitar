// VGT-13: `npm run phone` starts the local relay for the phone music stand (휴대폰 악보대).
// Side panel on 127.0.0.1 only; phone page on this Mac's home-network address; nothing is written to disk.
import { DEFAULT_IDLE_MINUTES, buildViewer, distPath, loadRelay, parseArgs, portInUse } from './phone-lib.mjs';

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(2);
}
if (opts.help) {
  console.log('usage: npm run phone -- [--host <lan ipv4>] [--port 47822] [--idle-minutes 10] [--extension-id <id> | --any-extension]');
  console.log(`  --idle-minutes  stop by itself when no side panel has been connected this long (default ${DEFAULT_IDLE_MINUTES}, minimum 1)`);
  console.log('  --extension-id  the id chrome://extensions shows for Vibe Guitar (default: the id of this repo\'s dist folder)');
  console.log('  --any-extension accept any Chrome extension on this Mac as the publisher (not recommended)');
  process.exit(0);
}

const R = await loadRelay();
// One concrete private IPv4 only: "0", "0.0.0.0", "::", hostnames or loopback would expose or hide the phone page.
const hostProblem = opts.host === undefined ? null : R.viewerHostProblem(opts.host);
if (hostProblem) {
  console.error(hostProblem);
  process.exit(2);
}
// Refuse a second relay instead of failing halfway: the first one keeps working in its own window.
const pubPortWanted = opts.pubPort ?? R.DEFAULT_PUBLISHER_PORT;
const lanWanted = opts.host ?? R.pickLanAddress();
const viewerPortWanted = opts.port ?? R.DEFAULT_VIEWER_PORT;
const busy = [
  pubPortWanted && (await portInUse('127.0.0.1', pubPortWanted)) ? `127.0.0.1:${pubPortWanted}` : null,
  lanWanted && viewerPortWanted && (await portInUse(lanWanted, viewerPortWanted)) ? `${lanWanted}:${viewerPortWanted}` : null,
].filter(Boolean);
if (busy.length) {
  console.error(`휴대폰 악보대 중계기가 이미 켜져 있는 것 같습니다 (사용 중인 주소: ${busy.join(', ')}).`);
  console.error('먼저 켠 창을 그대로 쓰거나, 그 창에서 Ctrl+C로 끈 뒤 다시 실행해 주세요. 이 창은 아무것도 시작하지 않았습니다.');
  process.exit(3);
}
const idleMinutes = opts.idleMinutes ?? DEFAULT_IDLE_MINUTES;
const viewer = await buildViewer();
const dist = await distPath();
const extensionId = opts.anyExtension ? undefined : (opts.extensionId ?? R.unpackedExtensionId(dist));
const stamp = () => new Date().toTimeString().slice(0, 8);
let relay;
try {
  relay = await R.startRelay({
    host: opts.host,
    port: opts.port,
    pubPort: opts.pubPort,
    extensionId,
    idleStopMs: idleMinutes * 60_000,
    onIdleStop: () => {
      console.log(`\n패널이 ${idleMinutes}분 동안 연결되지 않아 중계기를 껐습니다. 다시 쓰려면 다시 실행해 주세요.`);
      process.exit(0);
    },
    ...viewer,
    log: (line) => console.log(`[${stamp()}] ${line}`),
  });
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
console.log('토큰은 이번 실행에서만 유효하고 어디에도 저장하지 않습니다.');
console.log(`패널이 ${idleMinutes}분 동안 연결되지 않으면 저절로 꺼집니다 (휴대폰만 연결된 경우 포함).`);
console.log('이 창을 닫거나 Ctrl+C를 누르면 꺼집니다.');
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
process.on('SIGHUP', stop); // the Terminal window was closed
