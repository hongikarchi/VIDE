// vide.bake.panels-uv@1 — 패널링 1단계 [미리보기 만들기] (SPEC-16.9, PLAN-49 T-255, ARCH-03 §9.1):
// each panel is an open face cut out of the ORIGINAL picked face along its UV outline, on
// layerRoot::미리보기. Fixed C# method body owned by VIDE; the only value from a jig is the data block
// in the one placeholder. The body itself is the shared text of panel-make.cs.
var data = Convert.FromBase64String("{{DATA_BASE64}}");
var expectedTemplate = "vide.bake.panels-uv@1";
var solid = false;
//@include face-hash.cs
//@include panel-make.cs
