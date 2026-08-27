from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def patch(path: str, replacements: list[tuple[str, str]]) -> None:
    target = ROOT / path
    source = target.read_text()
    for old, new in replacements:
        count = source.count(old)
        if count != 1:
            raise SystemExit(f"{path}: expected one match for {old!r}, found {count}")
        source = source.replace(old, new, 1)
    target.write_text(source)


patch(
    "client/watcher/index.test.mjs",
    [
        (
            "  assert.equal(result.publicInputs.length, 320);",
            "  assert.equal(result.publicInputs.length, 416);",
        ),
        (
            "  assert.equal(result.witness.MerkleRoot, result.registry.root.toString(10));",
            """  assert.equal(result.witness.MerkleRoot, result.registry.root.toString(10));
  assert.equal(result.witness.CurrentRoot, result.registry.root.toString(10));
  assert.equal(result.witness.NewMerkleRoot, result.transition.newRoot.toString(10));
  assert.equal(result.witness.ChangeLeafIndex, '4');""",
        ),
    ],
)

patch(
    "client/watcher/instructions.test.mjs",
    [
        (
            "    96,\n  );",
            "    192,\n  );",
        ),
        (
            "  assert.equal(encoded.length, 1 + 32 + 8 + 2 + 256 + 2 + 96);",
            "  assert.equal(encoded.length, 1 + 32 + 8 + 2 + 256 + 2 + 192);",
        ),
        (
            "test('withdraw payload binds recipient, fees, proof and ten public fields', () => {",
            "test('withdraw payload binds recipient, fees, proof and thirteen public fields', () => {",
        ),
        (
            "  assert.equal(encoded.length, 1 + 32 * 4 + 8 * 3 + 2 + 256 + 2 + 320);",
            "  assert.equal(encoded.length, 1 + 32 * 4 + 8 * 3 + 2 + 256 + 2 + 416);",
        ),
        (
            "    publicInputs: bytes(96, 9),",
            "    publicInputs: bytes(192, 9),",
        ),
        (
            "    publicInputs: bytes(320, 5),",
            "    publicInputs: bytes(416, 5),",
        ),
        (
            "        publicInputs: bytes(96, 3),",
            "        publicInputs: bytes(192, 3),",
        ),
        (
            "        publicInputs: bytes(319, 6),",
            "        publicInputs: bytes(415, 6),",
        ),
        (
            "    /320 bytes/,
",
            "    /416 bytes/,
",
        ),
    ],
)

patch(
    "client/watcher/protocol.test.mjs",
    [
        (
            """      assetId: BigInt(witness.AssetID),
    });""",
            """      assetId: BigInt(witness.AssetID),
      oldRoot: BigInt(witness.OldRoot),
      newRoot: BigInt(witness.NewRoot),
      leafIndex: BigInt(witness.LeafIndex),
    });""",
        ),
        (
            """    contextBinding: BigInt(witness.ContextBinding),
  });""",
            """    contextBinding: BigInt(witness.ContextBinding),
    currentRoot: BigInt(witness.CurrentRoot),
    newMerkleRoot: BigInt(witness.NewMerkleRoot),
    changeLeafIndex: BigInt(witness.ChangeLeafIndex),
  });""",
        ),
        (
            "  assert.equal(deposit.length, 397);",
            "  assert.equal(deposit.length, 493);",
        ),
        (
            "  assert.deepEqual(deposit.slice(299, 301), Uint8Array.of(0x60, 0x00));",
            "  assert.deepEqual(deposit.slice(299, 301), Uint8Array.of(0xc0, 0x00));",
        ),
        (
            "  assert.equal(withdrawal.length, 733);",
            "  assert.equal(withdrawal.length, 829);",
        ),
        (
            "  assert.deepEqual(withdrawal.slice(411, 413), Uint8Array.of(0x40, 0x01));",
            "  assert.deepEqual(withdrawal.slice(411, 413), Uint8Array.of(0xa0, 0x01));",
        ),
        (
            "test('deposit witness exposes exact commitment, amount, and asset public inputs', () => {",
            "test('deposit witness exposes commitment, amount, asset, and append transition inputs', () => {",
        ),
        (
            "  assert.equal(result.witness.AssetID, '1');",
            """  assert.equal(result.witness.AssetID, '1');
  assert.equal(result.witness.OldRoot, '0');
  assert.equal(result.witness.NewRoot, result.transition.newRoot.toString(10));
  assert.equal(result.witness.LeafIndex, '0');""",
        ),
    ],
)

print("Updated Watcher client tests for 6-field deposit and 13-field withdrawal statements.")
