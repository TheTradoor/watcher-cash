import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const packagePath = 'package.json';
const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
packageJson.dependencies ||= {};
delete packageJson.dependencies.privacycash;
delete packageJson.dependencies['@lightprotocol/hasher.rs'];
if (typeof packageJson.scripts?.postinstall === 'string'
  && packageJson.scripts.postinstall.includes('@lightprotocol/hasher.rs')) {
  delete packageJson.scripts.postinstall;
}
writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

if (existsSync('src/watcher-sdk')) {
  rmSync('src/watcher-sdk', { recursive: true, force: true });
}

const auditPath = 'LICENSE_AUDIT.md';
if (existsSync(auditPath)) {
  let audit = readFileSync(auditPath, 'utf8');
  const marker = '## Runtime dependency removal';
  if (!audit.includes(marker)) {
    audit += `\n\n${marker}\n\nThe live Watcher Protocol browser application no longer imports or ships the \\`privacycash\\` package or the legacy Light Protocol browser hasher runtime. The active UI uses Watcher-owned client codecs, circuits, proof adapters, and Solana instructions. Historical migration notes remain documentation only.\n`;
    writeFileSync(auditPath, audit);
  }
}
