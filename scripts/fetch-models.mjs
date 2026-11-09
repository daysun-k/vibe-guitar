// Downloads the recognition models listed in scripts/models.manifest.json into models/
// (gitignored) and verifies each file's size and sha256. Re-running skips verified files.
// The extension never downloads anything at runtime: scripts/build.mjs copies the
// "packaged" files from models/ into dist/models/.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'models');
const manifest = JSON.parse(await readFile(path.join(root, 'scripts/models.manifest.json'), 'utf8'));

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function existingOk(file, entry) {
  try {
    const buf = await readFile(file);
    return buf.length === entry.bytes && (entry.sha256 === 'TBD' || sha256(buf) === entry.sha256);
  } catch {
    return false;
  }
}

await mkdir(outDir, { recursive: true });
let failed = 0;
for (const entry of manifest.files) {
  const file = path.join(outDir, entry.file);
  if (await existingOk(file, entry)) {
    console.log(`ok (cached)  ${entry.file}`);
    continue;
  }
  process.stdout.write(`download     ${entry.file} (${(entry.bytes / 1e6).toFixed(2)} MB) … `);
  try {
    const res = await fetch(entry.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = sha256(buf);
    if (buf.length !== entry.bytes) throw new Error(`size ${buf.length} != ${entry.bytes}`);
    if (entry.sha256 !== 'TBD' && hash !== entry.sha256) throw new Error(`sha256 ${hash} != ${entry.sha256}`);
    const tmp = `${file}.part`;
    await writeFile(tmp, buf);
    await rename(tmp, file);
    console.log(`ok sha256=${hash}`);
  } catch (e) {
    failed++;
    await rm(`${file}.part`, { force: true });
    console.log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const licenses = manifest.files
  .map((f) => `- ${f.file} (${(f.bytes / 1e6).toFixed(2)} MB${f.packaged ? ', packaged' : ', not packaged'}): ${f.model}\n  source: ${f.url}\n  license: ${f.license}`)
  .join('\n');
await writeFile(path.join(outDir, 'MODELS.txt'), `Vibe Guitar recognition models (personal use)\n\n${licenses}\n`);

if (failed) {
  console.error(`${failed} file(s) failed`);
  process.exit(1);
}
console.log(`models ready in ${path.relative(root, outDir)}/`);
