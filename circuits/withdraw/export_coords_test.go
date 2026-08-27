package withdraw

import (
 "encoding/hex"
 "encoding/json"
 "os"
 "path/filepath"
 "testing"

 bn254groth16 "github.com/consensys/gnark/backend/groth16/bn254"
 "github.com/consensys/gnark-crypto/ecc"
 "github.com/consensys/gnark-crypto/ecc/bn254/fr"
 "github.com/consensys/gnark/backend/groth16"
 "github.com/consensys/gnark/frontend"
)

type coordFixture struct { Proof map[string]string `json:"proof"`; VK map[string]any `json:"vk"`; PublicInputs []string `json:"public_inputs"` }
func hx(v interface{ Bytes() [32]byte }) string { b:=v.Bytes(); return hex.EncodeToString(b[:]) }

func TestExportCoordinateFixture(t *testing.T){
 if os.Getenv("WATCHER_EXPORT_COORDS")!="1" { t.Skip("set WATCHER_EXPORT_COORDS=1") }
 ccs,pk,vk:=compileV1(t); a:=validV1(); w,err:=frontend.NewWitness(&a,ecc.BN254.ScalarField());if err!=nil{t.Fatal(err)};pub,err:=w.Public();if err!=nil{t.Fatal(err)}
 p,err:=groth16.Prove(ccs,pk,w);if err!=nil{t.Fatal(err)};if err:=groth16.Verify(p,vk,pub);err!=nil{t.Fatal(err)}
 bp,ok:=p.(*bn254groth16.Proof);if !ok{t.Fatalf("unexpected proof type %T",p)};bvk,ok:=vk.(*bn254groth16.VerifyingKey);if !ok{t.Fatalf("unexpected vk type %T",vk)}
 proof:=map[string]string{"a_x":hx(&bp.Ar.X),"a_y":hx(&bp.Ar.Y),"b_x0":hx(&bp.Bs.X.A0),"b_x1":hx(&bp.Bs.X.A1),"b_y0":hx(&bp.Bs.Y.A0),"b_y1":hx(&bp.Bs.Y.A1),"c_x":hx(&bp.Krs.X),"c_y":hx(&bp.Krs.Y)}
 vkmap:=map[string]any{"alpha_x":hx(&bvk.G1.Alpha.X),"alpha_y":hx(&bvk.G1.Alpha.Y),"beta_x0":hx(&bvk.G2.Beta.X.A0),"beta_x1":hx(&bvk.G2.Beta.X.A1),"beta_y0":hx(&bvk.G2.Beta.Y.A0),"beta_y1":hx(&bvk.G2.Beta.Y.A1),"gamma_x0":hx(&bvk.G2.Gamma.X.A0),"gamma_x1":hx(&bvk.G2.Gamma.X.A1),"gamma_y0":hx(&bvk.G2.Gamma.Y.A0),"gamma_y1":hx(&bvk.G2.Gamma.Y.A1),"delta_x0":hx(&bvk.G2.Delta.X.A0),"delta_x1":hx(&bvk.G2.Delta.X.A1),"delta_y0":hx(&bvk.G2.Delta.Y.A0),"delta_y1":hx(&bvk.G2.Delta.Y.A1)}
 ic:=make([]map[string]string,len(bvk.G1.K));for i:=range bvk.G1.K{ic[i]=map[string]string{"x":hx(&bvk.G1.K[i].X),"y":hx(&bvk.G1.K[i].Y)}};vkmap["ic"]=ic
 vec,ok:=pub.Vector().(fr.Vector);if !ok{t.Fatalf("unexpected public vector type %T",pub.Vector())};inputs:=make([]string,len(vec));for i:=range vec{b:=vec[i].Bytes();inputs[i]=hex.EncodeToString(b[:])}
 out:=coordFixture{Proof:proof,VK:vkmap,PublicInputs:inputs};data,err:=json.MarshalIndent(out,"","  ");if err!=nil{t.Fatal(err)}
 dir:="fixture-out";if err:=os.MkdirAll(dir,0755);err!=nil{t.Fatal(err)};if err:=os.WriteFile(filepath.Join(dir,"coordinates.json"),data,0644);err!=nil{t.Fatal(err)}
 t.Logf("exported proof coordinates, %d IC points, %d public inputs",len(ic),len(inputs))
}
