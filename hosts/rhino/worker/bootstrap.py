"""Trusted startup loader for the VIDE-owned Rhino experiment."""
import os
import json
import Rhino

plugin = os.environ.get("VIDE_WORKER_PLUGIN", "")
report = os.environ.get("VIDE_WORKER_REPORT", "")
try:
    if not os.path.isabs(plugin) or not os.path.isfile(plugin):
        raise Exception("WORKER_PLUGIN_MISSING")
    loaded, plugin_id = Rhino.PlugIns.PlugIn.LoadPlugIn(plugin)
    if not Rhino.RhinoApp.RunScript("_VIDEWorkHost", False) and not os.path.isfile(report):
        raise Exception("WORKER_COMMAND_FAILED: " + str(loaded))
except Exception as error:
    # Preserve a specific diagnostic emitted by the trusted command; publish ours atomically.
    if os.path.isabs(report) and not os.path.exists(report + ".error.json"):
        with open(report + ".loader-error.tmp", "w") as output:
            json.dump({"code": "WORKER_BOOTSTRAP_FAILED", "message": str(error)}, output)
        os.rename(report + ".loader-error.tmp", report + ".error.json")
    print(str(error))
