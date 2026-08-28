from pathlib import Path

path = Path("app/watcher-protocol-page.jsx")
source = path.read_text()

replacements = [
    (
        "import { createWatcherBrowserProverV1 } from '../client/watcher/ui-prover.mjs';",
        "import { getBrowserProverV1 } from '../client/watcher/browser-prover.mjs';",
        "browser prover import",
    ),
    (
        "fetch(`${BASE_PATH}/watcher-prover-v1/browser-manifest.json`, { cache: 'no-store' })",
        "fetch(`${BASE_PATH}/watcher-prover/assets/manifest.json`, { cache: 'no-store' })",
        "browser asset manifest",
    ),
    (
        """  const ensureProver = useCallback(async () => {
    if (!proverRef.current) {
      proverRef.current = createWatcherBrowserProverV1({
        workerUrl: `${BASE_PATH}/watcher-prover-worker.js`,
        assetBase: `${BASE_PATH}/watcher-prover-v1`,
      });
    }
    setProverStatus('loading');
    const result = await proverRef.current.ready();
    setBundleDigest(result?.bundleDigest || '');
    setProverStatus('ready');
    return proverRef.current;
  }, []);""",
        """  const ensureProver = useCallback(async () => {
    if (!proverRef.current) {
      proverRef.current = getBrowserProverV1({
        basePath: `${BASE_PATH}/watcher-prover`,
      });
    }
    setProverStatus('loading');
    const result = await proverRef.current.initialize();
    setBundleDigest(result?.bundleDigest || '');
    setProverStatus('ready');
    return proverRef.current;
  }, []);""",
        "browser prover initialization",
    ),
]

for old, new, label in replacements:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    source = source.replace(old, new, 1)

path.write_text(source)
print("Watcher UI now uses the permanent browser prover stack.")
