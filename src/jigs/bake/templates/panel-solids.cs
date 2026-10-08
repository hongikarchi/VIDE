// vide.bake.panel-solids@1 — 패널링 2단계 [부재 만들기] (SPEC-16.9, PLAN-49 T-255, ARCH-03 §9.1): each
// member is the joint-reduced panel cut out of the ORIGINAL picked face and offset by the signed
// thickness along the face's oriented normal into one closed solid (Brep.CreateOffsetBrep, solid,
// not extended); not one valid closed solid = NOT_CLOSED, never repaired or filled. Fixed C# method
// body owned by VIDE; the body itself is the shared text of panel-make.cs.
var data = Convert.FromBase64String("{{DATA_BASE64}}");
var expectedTemplate = "vide.bake.panel-solids@1";
var solid = true;
//@include face-hash.cs
//@include panel-make.cs
