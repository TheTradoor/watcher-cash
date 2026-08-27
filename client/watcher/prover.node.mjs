import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = path.resolve(MODULE_DIRECTORY, '..', '..');
const EXPECTED = Object.freeze({
  deposit: { publicInputs: 96 },
  withdraw: { publicInputs: 320 },
});

function jsonWithBigInts(value) {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2);
}

function normalizeCommand(command) {
  if (command === undefined) return ['go', 'run', './cmd/watcher-prover'];
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string')) {
    throw new TypeError('command must be a non-empty string array');
  }
  return command;
}

async function execute(command, args, { cwd, timeoutMs }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`local prover timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8');
      const errors = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(
          new Error(
            `local prover failed (${signal ?? `exit ${code}`}): ${errors || output || 'no output'}`,
          ),
        );
        return;
      }
      resolve({ stdout: output, stderr: errors });
    });
  });
}

function circuitFiles(bundleDirectory, circuit) {
  return {
    provingKey: path.join(bundleDirectory, `${circuit}.pk`),
    verifyingKey: path.join(bundleDirectory, `${circuit}.vk`),
  };
}

export async function proveWatcherLocally({
  circuit,
  witness,
  bundleDirectory,
  command,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  timeoutMs = 10 * 60 * 1_000,
}) {
  if (!(circuit in EXPECTED)) throw new RangeError('circuit must be deposit or withdraw');
  if (!bundleDirectory) throw new TypeError('bundleDirectory is required');
  if (!witness || typeof witness !== 'object') throw new TypeError('witness must be an object');

  const normalizedCommand = normalizeCommand(command);
  const circuitDirectory = path.join(repositoryRoot, 'circuits', 'withdraw');
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), `watcher-${circuit}-proof-`));
  const witnessPath = path.join(temporaryDirectory, 'witness.json');
  const outputDirectory = path.join(temporaryDirectory, 'output');
  const files = circuitFiles(path.resolve(bundleDirectory), circuit);

  try {
    await writeFile(witnessPath, `${jsonWithBigInts(witness)}\n`, { mode: 0o600 });
    await execute(
      normalizedCommand,
      [
        '--circuit',
        circuit,
        '--pk',
        files.provingKey,
        '--vk',
        files.verifyingKey,
        '--witness',
        witnessPath,
        '--out',
        outputDirectory,
      ],
      { cwd: circuitDirectory, timeoutMs },
    );

    const [proofBuffer, publicInputsBuffer, manifestBuffer] = await Promise.all([
      readFile(path.join(outputDirectory, 'proof.bin')),
      readFile(path.join(outputDirectory, 'public-inputs.bin')),
      readFile(path.join(outputDirectory, 'manifest.json')),
    ]);
    if (proofBuffer.length !== 256) {
      throw new Error(`local prover emitted ${proofBuffer.length} proof bytes instead of 256`);
    }
    if (publicInputsBuffer.length !== EXPECTED[circuit].publicInputs) {
      throw new Error(
        `local prover emitted ${publicInputsBuffer.length} public-input bytes instead of ${EXPECTED[circuit].publicInputs}`,
      );
    }
    const manifest = JSON.parse(manifestBuffer.toString('utf8'));
    if (manifest.circuit !== circuit) throw new Error('local prover manifest circuit mismatch');

    return Object.freeze({
      proof: new Uint8Array(proofBuffer),
      publicInputs: new Uint8Array(publicInputsBuffer),
      manifest,
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export function proveDepositLocally(options) {
  return proveWatcherLocally({ ...options, circuit: 'deposit' });
}

export function proveWithdrawLocally(options) {
  return proveWatcherLocally({ ...options, circuit: 'withdraw' });
}
