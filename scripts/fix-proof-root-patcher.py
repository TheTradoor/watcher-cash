from pathlib import Path

path = Path(__file__).resolve().with_name("apply-proof-carried-root-transitions.py")
source = path.read_text()

old_regex = "updated, count = re.subn(pattern, replacement, content, count=1, flags=re.S)"
new_regex = "updated, count = re.subn(pattern, lambda _match: replacement, content, count=1, flags=re.S)"
if old_regex in source:
    source = source.replace(old_regex, new_regex, 1)
elif new_regex not in source:
    raise SystemExit("replace_regex implementation is not recognized")

old_first_append = r'''\tcomputedOldRoot, err := merkleRootV1(api, 0, c.Path, c.Index)
\tif err != nil {
\t\treturn err
\t}
\tisFirst := api.IsZero(c.LeafIndex)
\tfor i := 0; i < MerkleDepthV1; i++ {
\t\tapi.AssertIsEqual(api.Mul(isFirst, c.Path[i]), 0)
\t}
\tapi.AssertIsEqual(api.Mul(isFirst, c.OldRoot), 0)
\tapi.AssertIsEqual(
\t\tapi.Mul(api.Sub(1, isFirst), api.Sub(computedOldRoot, c.OldRoot)),
\t\t0,
\t)'''

new_first_append = r'''\tcomputedOldRoot, err := merkleRootV1(api, 0, c.Path, c.Index)
\tif err != nil {
\t\treturn err
\t}
\tisFirst := api.IsZero(c.LeafIndex)
\temptySibling := frontend.Variable(0)
\tfor i := 0; i < MerkleDepthV1; i++ {
\t\tapi.AssertIsEqual(api.Mul(isFirst, api.Sub(c.Path[i], emptySibling)), 0)
\t\temptySibling, err = hashV1(api, domainMerkleV1, emptySibling, emptySibling)
\t\tif err != nil {
\t\t\treturn err
\t\t}
\t}
\tapi.AssertIsEqual(api.Mul(isFirst, c.OldRoot), 0)
\tapi.AssertIsEqual(
\t\tapi.Mul(api.Sub(1, isFirst), api.Sub(computedOldRoot, c.OldRoot)),
\t\t0,
\t)'''

if old_first_append in source:
    source = source.replace(old_first_append, new_first_append, 1)
elif new_first_append not in source:
    raise SystemExit("first-append constraint block is not recognized")

path.write_text(source)
print("Proof-transition patcher repair applied.")
