"""Extract geometry only from the user's reference; never execute embedded scripts."""
import base64
import hashlib
import json
import struct
import sys
from pathlib import Path

source = Path(sys.argv[1])
text = source.read_text(encoding="utf-8")
model, _ = json.JSONDecoder().raw_decode(text.split("const MODEL = ", 1)[1])
objects = []
for number, part in enumerate(model["groundDisplay"]["parts"]):
    encoding = part.get("encoding", {})
    code = {"<i2": "h", "<i4": "i"}.get(encoding.get("type"), "f")
    raw = base64.b64decode(part["position"])
    values = struct.unpack("<" + code * (len(raw) // struct.calcsize(code)), raw)
    origin = encoding.get("origin", [0, 0, 0])
    positions = [(value + origin[i % 3]) / 1000 for i, value in enumerate(values)]
    raw = base64.b64decode(part["indices"])
    code = "H" if part["indexType"] == "<u2" else "I"
    indices = struct.unpack("<" + code * (len(raw) // struct.calcsize(code)), raw)
    objects.append(dict(id=f"reference-{number}", positions=positions, indices=indices))
output = Path(".vide/viewport-spike")
output.mkdir(parents=True, exist_ok=True)
payload = dict(sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),
               scope="groundDisplay mesh subset only; meters, original viewer Y-up", objects=objects)
(output / "reference.json").write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
print(json.dumps(dict(objects=len(objects), triangles=sum(len(o['indices']) // 3 for o in objects),
                     sourceSha256=payload['sourceSha256'])))
