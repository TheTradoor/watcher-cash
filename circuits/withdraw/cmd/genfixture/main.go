package main

import (
    "bytes"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "math/big"
    "os"
    "path/filepath"

    "github.com/consensys/gnark-crypto/ecc"
    "github.com/consensys/gnark-crypto/ecc/bn254/fr"
    nativemimc "github.com/consensys/gnark-crypto/ecc/bn254/fr/mimc"
    "github.com/consensys/gnark/backend/groth16"
    "github.com/consensys/gnark/frontend"
    "github.com/consensys/gnark/frontend/cs/r1cs"

    withdraw "watcher.cash/circuits/withdraw"
)

const (
    domainNote = 91001
    domainNullifier = 91002
    domainMerkle = 91003
    depth = withdraw.MerkleDepthV1
)

func bi(v int64) *big.Int { return big.NewInt(v) }
func hash(values ...*big.Int) *big.Int {
    h := nativemimc.NewMiMC()
    for _, value := range values {
        var e fr.Element
        e.SetBigInt(value)
        b := e.Bytes()
        if _, err := h.Write(b[:]); err != nil { panic(err) }
    }
    return new(big.Int).SetBytes(h.Sum(nil))
}
func note(asset, amount, owner, nonce *big.Int) *big.Int { return hash(bi(domainNote), asset, amount, owner, nonce) }
func nullifier(owner, nonce, commitment *big.Int) *big.Int { return hash(bi(domainNullifier), owner, nonce, commitment) }
func parent(left, right *big.Int) *big.Int { return hash(bi(domainMerkle), left, right) }

type tree struct{ levels [][]*big.Int }
func makeTree(leaves []*big.Int) tree {
    levels:=make([][]*big.Int,depth+1);levels[0]=leaves
    for d:=0;d<depth;d++{next:=make([]*big.Int,len(levels[d])/2);for i:=range next{next[i]=parent(levels[d][2*i],levels[d][2*i+1])};levels[d+1]=next}
    return tree{levels}
}
func (t tree) proof(index int)([depth]frontend.Variable,[depth]frontend.Variable){var p [depth]frontend.Variable;var bits [depth]frontend.Variable;pos:=index;for d:=0;d<depth;d++{if pos%2==0{p[d]=new(big.Int).Set(t.levels[d][pos+1]);bits[d]=0}else{p[d]=new(big.Int).Set(t.levels[d][pos-1]);bits[d]=1};pos/=2};return p,bits}
func field32(v *big.Int) [32]byte { var e fr.Element; e.SetBigInt(v); return e.Bytes() }
func write(path string,b []byte){if err:=os.WriteFile(path,b,0644);err!=nil{panic(err)}}

type manifest struct {
    Curve string `json:"curve"`
    Scheme string `json:"scheme"`
    Circuit string `json:"circuit"`
    Warning string `json:"warning"`
    ProofRawBytes int `json:"proof_raw_bytes"`
    VerifyingKeyRawBytes int `json:"verifying_key_raw_bytes"`
    PublicWitnessBytes int `json:"public_witness_bytes"`
    PublicInputCount int `json:"public_input_count"`
    PublicInputOrder []string `json:"public_input_order"`
    ProofSHA256Note string `json:"proof_format_note"`
    PublicHex string `json:"public_inputs_hex"`
}

func main(){
    asset:=bi(1);a0,o0,n0:=bi(8_000_000),bi(1111),bi(2222);a1,o1,n1:=bi(3_000_000),bi(3333),bi(4444)
    c0:=note(asset,a0,o0,n0);c1:=note(asset,a1,o1,n1)
    leaves:=make([]*big.Int,1<<depth);for i:=range leaves{leaves[i]=new(big.Int)};leaves[2]=c0;leaves[7]=c1;t:=makeTree(leaves);p0,b0:=t.proof(2);p1,b1:=t.proof(7)
    ca,co,cn:=bi(6_000_000),bi(5555),bi(6666);cc:=note(asset,ca,co,cn)
    assignment:=withdraw.CircuitV1{Input0Amount:a0,Input0Owner:o0,Input0Nonce:n0,Input0Path:p0,Input0Index:b0,Input1Amount:a1,Input1Owner:o1,Input1Nonce:n1,Input1Path:p1,Input1Index:b1,ChangeAmount:ca,ChangeOwner:co,ChangeNonce:cn,MerkleRoot:t.levels[depth][0],Nullifier0:nullifier(o0,n0,c0),Nullifier1:nullifier(o1,n1,c1),ChangeCommitment:cc,PublicAmount:4_000_000,ProtocolFee:500_000,RelayerFee:500_000,RecipientBinding:101,AssetID:1,ContextBinding:202}

    ccs,err:=frontend.Compile(ecc.BN254.ScalarField(),r1cs.NewBuilder,&withdraw.CircuitV1{});if err!=nil{panic(err)}
    pk,vk,err:=groth16.Setup(ccs);if err!=nil{panic(err)}
    w,err:=frontend.NewWitness(&assignment,ecc.BN254.ScalarField());if err!=nil{panic(err)};pub,err:=w.Public();if err!=nil{panic(err)}
    proof,err:=groth16.Prove(ccs,pk,w);if err!=nil{panic(err)};if err:=groth16.Verify(proof,vk,pub);err!=nil{panic(err)}

    var proofBuf,vkBuf bytes.Buffer
    if _,err:=proof.WriteRawTo(&proofBuf);err!=nil{panic(err)}
    if _,err:=vk.WriteRawTo(&vkBuf);err!=nil{panic(err)}

    ordered:=[]*big.Int{t.levels[depth][0],nullifier(o0,n0,c0),nullifier(o1,n1,c1),cc,bi(4_000_000),bi(500_000),bi(500_000),bi(101),bi(1),bi(202)}
    publicRaw:=make([]byte,0,32*len(ordered));for _,v:=range ordered{x:=field32(v);publicRaw=append(publicRaw,x[:]...)}

    out:="testdata/v1_fixture";if err:=os.MkdirAll(out,0755);err!=nil{panic(err)}
    write(filepath.Join(out,"proof.raw"),proofBuf.Bytes());write(filepath.Join(out,"vk.raw"),vkBuf.Bytes());write(filepath.Join(out,"public_inputs.bin"),publicRaw)
    m:=manifest{Curve:"BN254",Scheme:"Groth16",Circuit:"Watcher CircuitV1",Warning:"DEVELOPMENT FIXTURE ONLY. groth16.Setup here is not a production ceremony.",ProofRawBytes:proofBuf.Len(),VerifyingKeyRawBytes:vkBuf.Len(),PublicWitnessBytes:len(publicRaw),PublicInputCount:10,PublicInputOrder:[]string{"MerkleRoot","Nullifier0","Nullifier1","ChangeCommitment","PublicAmount","ProtocolFee","RelayerFee","RecipientBinding","AssetID","ContextBinding"},ProofSHA256Note:"gnark Proof.WriteRawTo output; exact point layout must be decoded before Solana verifier use",PublicHex:hex.EncodeToString(publicRaw)}
    j,_:=json.MarshalIndent(m,"","  ");write(filepath.Join(out,"manifest.json"),append(j,'\n'))
    fmt.Printf("generated fixture: proof=%d vk=%d public=%d\n",proofBuf.Len(),vkBuf.Len(),len(publicRaw))
}
