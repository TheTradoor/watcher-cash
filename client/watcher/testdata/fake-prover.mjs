import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  values.set(process.argv[index], process.argv[index + 1]);
}
const circuit = values.get('--circuit');
const witnessPath = values.get('--witness');
const output = values.get('--out');
if (!['deposit', 'withdraw'].includes(circuit) || !witnessPath || !output) process.exit(2);

const witness = JSON.parse(await readFile(witnessPath, 'utf8'));
if (witness.ownerBigInt !== '123456789') process.exit(3);
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'proof.bin'), Buffer.alloc(256, circuit === 'deposit' ? 1 : 2));
await writeFile(
  path.join(output, 'public-inputs.bin'),
  Buffer.alloc(circuit === 'deposit' ? 96 : 320, circuit === 'deposit' ? 3 : 4),
);
await writeFile(
  path.join(output, 'manifest.json'),
  `${JSON.stringify({ circuit, proof_bytes: 256 })}\n`,
);
