"""Development-only reference results for the structure core (PLAN-17 T-034).

Builds a few 3D frames in the VIDE model contract (vide.structure.model/1), solves them with
PyNite and writes tests/structure/frames/<id>.json = {source, model, expected}. The core tests
compare global displacements and reactions against these values.

Sections use equal I2 = I3 so the result does not depend on the programs' local-axis rules.
Requires: Python 3.11+, PyNiteFEA (pip install PyNiteFEA). Not part of the product package.
"""

import datetime
import importlib.metadata
import json
import pathlib

from Pynite import FEModel3D

OUT = pathlib.Path(__file__).resolve().parents[2] / "tests" / "structure" / "frames"
E_MPA, G_MPA = 205000.0, 79000.0
BOX = {"A_mm2": 1.2e4, "I2_mm4": 1.8e8, "I3_mm4": 1.8e8, "J_mm4": 2.9e8}
FIXED = {"dx": True, "dy": True, "dz": True, "rx": True, "ry": True, "rz": True}
DOFS = ["dx", "dy", "dz", "rx", "ry", "rz"]


def model(name, nodes, members, loads, patterns, combos):
    return {
        "schema": "vide.structure.model/1",
        "meta": {"name": name},
        "materials": [
            {"id": "S", "grade": "SM355", "E_MPa": E_MPA, "G_MPa": G_MPA, "density_kNpm3": 0,
             "Fy_MPa": 355, "Fu_MPa": 490}
        ],
        "sections": [
            {"id": "BOX", "name": "equal-I box", "shape": "BOX", "dims_mm": {"h": 300, "b": 300, "t": 12},
             "source": "user", "props": BOX}
        ],
        "nodes": nodes,
        "members": [
            {"id": m[0], "i": m[1], "j": m[2], "section": "BOX", "material": "S", "role": m[3],
             "kind": "frame", "betaDeg": 0}
            for m in members
        ],
        "loadPatterns": [{"id": p, "nature": "D"} for p in patterns],
        "loads": loads,
        "combinations": combos,
        "analysis": {"kind": "linearStatic"},
    }


def portal():
    nodes = [
        {"id": "BL", "xyz_m": [0, 0, 0], "support": FIXED},
        {"id": "BR", "xyz_m": [6, 0, 0], "support": FIXED},
        {"id": "TL", "xyz_m": [0, 0, 4]},
        {"id": "TR", "xyz_m": [6, 0, 4]},
    ]
    members = [("CL", "BL", "TL", "column"), ("CR", "BR", "TR", "column"), ("BM", "TL", "TR", "beam")]
    loads = [
        {"id": "h", "pattern": "W", "type": "nodePoint", "targets": ["TL"], "direction": "+X", "value_kN": 10},
        {"id": "g", "pattern": "D", "type": "memberUniform", "targets": ["BM"], "direction": "-Z", "value_kNpm": 8},
    ]
    combos = [
        {"id": "D", "terms": [{"pattern": "D", "factor": 1}], "limitState": "strength"},
        {"id": "W", "terms": [{"pattern": "W", "factor": 1}], "limitState": "strength"},
        {"id": "U", "terms": [{"pattern": "D", "factor": 1.2}, {"pattern": "W", "factor": 1.0}], "limitState": "strength"},
    ]
    return model("portal", nodes, members, loads, ["D", "W"], combos)


def two_story():
    xs, ys, zs = [0, 6], [0, 5], [0, 4, 8]
    nodes, members = [], []
    name = lambda i, j, k: f"N{i}{j}{k}"
    for k, z in enumerate(zs):
        for j, y in enumerate(ys):
            for i, x in enumerate(xs):
                n = {"id": name(i, j, k), "xyz_m": [x, y, z]}
                if k == 0:
                    n["support"] = FIXED
                nodes.append(n)
    for k in range(1, len(zs)):
        for j in range(2):
            for i in range(2):
                members.append((f"C{i}{j}{k}", name(i, j, k - 1), name(i, j, k), "column"))
        for j in range(2):
            members.append((f"BX{j}{k}", name(0, j, k), name(1, j, k), "beam"))
        for i in range(2):
            members.append((f"BY{i}{k}", name(i, 0, k), name(i, 1, k), "beam"))
    loads = [
        {"id": "wx", "pattern": "L", "type": "nodePoint", "targets": ["N002"], "direction": "+X", "value_kN": 10},
        {"id": "wy", "pattern": "L", "type": "nodePoint", "targets": ["N101"], "direction": "+Y", "value_kN": 7},
        {"id": "g", "pattern": "D", "type": "memberUniform", "targets": ["BX01", "BX11", "BY01", "BY11"],
         "direction": "-Z", "value_kNpm": 5},
        {"id": "p", "pattern": "D", "type": "memberPoint", "targets": ["BX12"], "direction": "-Z",
         "value_kN": 12, "position": 0.3},
    ]
    combos = [
        {"id": "C1", "terms": [{"pattern": "D", "factor": 1.2}, {"pattern": "L", "factor": 1.6}], "limitState": "strength"},
        {"id": "C2", "terms": [{"pattern": "D", "factor": 1.0}, {"pattern": "L", "factor": 1.0}], "limitState": "service"},
    ]
    return model("two-story", nodes, members, loads, ["D", "L"], combos)


def skew():
    nodes = [
        {"id": "A", "xyz_m": [0, 0, 0], "support": FIXED},
        {"id": "B", "xyz_m": [5, 1, 0], "support": FIXED},
        {"id": "C", "xyz_m": [1, 4, 0], "support": FIXED},
        {"id": "D", "xyz_m": [2.2, 1.5, 3.5]},
        {"id": "E", "xyz_m": [4.0, 2.5, 3.0]},
    ]
    members = [("AD", "A", "D", "column"), ("BE", "B", "E", "column"), ("CD", "C", "D", "brace"),
               ("CE", "C", "E", "brace"), ("DE", "D", "E", "beam")]
    loads = [
        {"id": "p1", "pattern": "D", "type": "nodePoint", "targets": ["D"], "direction": "-Z", "value_kN": 30},
        {"id": "p2", "pattern": "D", "type": "nodePoint", "targets": ["E"], "direction": "+Y", "value_kN": 6},
        {"id": "q", "pattern": "D", "type": "memberUniform", "targets": ["DE"], "direction": "-Z", "value_kNpm": 4},
    ]
    combos = [{"id": "C1", "terms": [{"pattern": "D", "factor": 1.0}], "limitState": "strength"}]
    return model("skew", nodes, members, loads, ["D"], combos)


def solve(m):
    fe = FEModel3D()
    for n in m["nodes"]:
        fe.add_node(n["id"], *n["xyz_m"])
        s = n.get("support")
        if s:
            fe.def_support(n["id"], *[bool(s.get(d)) for d in DOFS])
    mat = m["materials"][0]
    fe.add_material("S", mat["E_MPa"] * 1e3, mat["G_MPa"] * 1e3, 0.3, 0.0)
    p = m["sections"][0]["props"]
    fe.add_section("BOX", p["A_mm2"] * 1e-6, p["I2_mm4"] * 1e-12, p["I3_mm4"] * 1e-12, p["J_mm4"] * 1e-12)
    lengths = {}
    coords = {n["id"]: n["xyz_m"] for n in m["nodes"]}
    for mem in m["members"]:
        fe.add_member(mem["id"], mem["i"], mem["j"], "S", "BOX")
        a, b = coords[mem["i"]], coords[mem["j"]]
        lengths[mem["id"]] = sum((b[k] - a[k]) ** 2 for k in range(3)) ** 0.5
    axis = {"+X": ("FX", 1), "-X": ("FX", -1), "+Y": ("FY", 1), "-Y": ("FY", -1), "+Z": ("FZ", 1), "-Z": ("FZ", -1)}
    for load in m["loads"]:
        d, s = axis[load["direction"]]
        for t in load["targets"]:
            if load["type"] == "nodePoint":
                fe.add_node_load(t, d, s * load["value_kN"], case=load["pattern"])
            elif load["type"] == "memberUniform":
                w = s * load["value_kNpm"]
                fe.add_member_dist_load(t, d, w, w, case=load["pattern"])
            else:
                fe.add_member_pt_load(t, d, s * load["value_kN"], load["position"] * lengths[t], case=load["pattern"])
    for c in m["combinations"]:
        fe.add_load_combo(c["id"], {t["pattern"]: t["factor"] for t in c["terms"]})
    fe.analyze_linear(check_statics=True)
    expected = {"disp": {}, "reaction": {}}
    for n in m["nodes"]:
        node = fe.nodes[n["id"]]
        for c in m["combinations"]:
            cid = c["id"]
            expected["disp"].setdefault(n["id"], {})[cid] = [
                node.DX[cid], node.DY[cid], node.DZ[cid], node.RX[cid], node.RY[cid], node.RZ[cid]]
            if n.get("support"):
                expected["reaction"].setdefault(n["id"], {})[cid] = [
                    node.RxnFX[cid], node.RxnFY[cid], node.RxnFZ[cid],
                    node.RxnMX[cid], node.RxnMY[cid], node.RxnMZ[cid]]
    return expected


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    version = importlib.metadata.version("PyNiteFEA")
    for m in (portal(), two_story(), skew()):
        data = {
            "source": f"PyNite {version} (MIT), generated {datetime.date.today().isoformat()} by tools/structure/pynite_ref.py",
            "model": m,
            "expected": solve(m),
        }
        path = OUT / f"{m['meta']['name']}.json"
        path.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8", newline="\n")
        print("wrote", path)


if __name__ == "__main__":
    main()
