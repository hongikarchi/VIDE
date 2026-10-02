// ADR-029 (T-106): the policy for Rhino command macros and Python in direct mode, and that the
// Rhino plugin (DirectScripts.cs) keeps the same lists as the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  checkRhinoCommand,
  checkRhinoPython,
  commandWords,
  COMMAND_DENY,
  COMMAND_DENY_AT_START,
  COMMAND_DENY_PREFIX,
  COMMAND_CONFIRM,
  COMMAND_CONFIRM_AT_START,
  COMMAND_CONFIRM_PREFIX,
  PYTHON_DENY,
  PYTHON_PURGE,
} from '../../src/contracts/rhino-script-policy.ts';

test('everyday commands pass; options that share a name with a command do not trip it', () => {
  for (const script of [
    '_-SelDup _Enter',
    '_SelAll _Delete',
    '_-Layer _New "Save" _Enter',
    '_-Layer _New Walls _Enter',
    '_-NamedView _Save Top _Enter',
    '_Polyline 0,0,0 10,0,0 _Undo 5,5,0 _Close',
    '_SelLayer "A::B" _Enter _Join',
    '_-Make2D _Enter',
  ])
    assert.deepEqual(checkRhinoCommand(script), { ok: true }, script);
});

test('opening, quitting, scripts from disk, options, plug-ins, units and undo are refused', () => {
  for (const [script, word] of [
    ['_Exit', '_exit'],
    ['!_-Open "C:\\a.3dm"', '_open'],
    ['_-Import "C:\\a.dwg"', '_import'],
    ['_-ImportLayouts', '_importlayouts'],
    ['_-RunScript (Command "_Exit")', '_runscript'],
    ['_-RunPythonScript "C:\\a.py"', '_runpythonscript'],
    ['_-Options _Enter', '_options'],
    ['_-PlugInManager', '_pluginmanager'],
    ['_-Units _Millimeters', '_units'],
    ['_New', '_new'],
    ['_Undo', '_undo'],
    ['_SelAll _Enter _Undo', '_undo'],
    ['_ClearUndo', '_clearundo'],
    ['_Line _Pause _Pause', '_pause'],
  ]) {
    const verdict = checkRhinoCommand(script);
    assert.equal(verdict.ok, false, script);
    assert.match(verdict.diagnostics[0], new RegExp(word), script);
  }
});

test('commands that write files or purge are held for the card with their kind', () => {
  assert.equal(checkRhinoCommand('_-SaveAs "C:\\b.3dm"').guard.kind, 'save-as');
  assert.equal(checkRhinoCommand('_Save').guard.kind, 'save-as');
  assert.equal(checkRhinoCommand('_-Export "C:\\a.dwg" _Enter').guard.kind, 'export');
  assert.equal(checkRhinoCommand('_-ExportWithOrigin 0,0,0 "a.dwg"').guard.kind, 'export');
  assert.equal(checkRhinoCommand('_-Print _Go').guard.kind, 'publish');
  const purge = checkRhinoCommand('_-Purge _Enter');
  assert.equal(purge.guard.kind, 'purge');
  assert.match(purge.guard.detail, /되돌릴 수 없습니다/);
  // A refusal wins over a guard.
  assert.equal(checkRhinoCommand('_Save _Exit').ok, false);
});

test('command words: prefixes, quoted values and command positions', () => {
  assert.deepEqual(commandWords('!_-SelDup _Enter "a b" _Delete=Yes\n_Join'), [
    { word: 'seldup', start: true },
    { word: 'enter', start: false },
    { word: 'delete', start: false },
    { word: 'join', start: true },
  ]);
});

test('Python: geometry and tables pass; file, network, process, application and undo access are refused', () => {
  for (const source of [
    'import rhinoscriptsyntax as rs\nrs.AddLine((0,0,0),(1,0,0))',
    'import scriptcontext as sc\nimport Rhino\nfrom Rhino.Geometry import Point3d\nsc.doc.Objects.AddPoint(Point3d(0,0,0))',
    'import math, re\npattern = re.compile("A")\nprint(math.pi)',
    'from System.Drawing import Color',
  ])
    assert.deepEqual(checkRhinoPython(source), { ok: true }, source);
  for (const source of [
    'import os',
    'import math, subprocess',
    'from pathlib import Path',
    'data = open("x.txt").read()',
    'exec("print(1)")',
    'import System\nSystem.IO.File.Delete("a")',
    'from System import IO',
    'import Rhino\nRhino.RhinoApp.RunScript("_Exit", False)',
    'import rhinoscriptsyntax as rs\nrs.Command("_Save")',
    'import scriptcontext as sc\nsc.doc.Undo()',
    'import clr',
  ]) {
    const verdict = checkRhinoPython(source);
    assert.equal(verdict.ok, false, source);
    assert.match(verdict.diagnostics[0], /not permitted/);
  }
  assert.equal(checkRhinoPython('sc.doc.Materials.Compact()').guard.kind, 'purge');
});

test('the Rhino plugin keeps the same lists as the engine', () => {
  const cs = readFileSync(
    new URL('../../hosts/rhino/worker/DirectScripts.cs', import.meta.url),
    'utf8',
  );
  const array = (name) => {
    const body = new RegExp(`${name} = \\[([^\\]]*)\\]`).exec(cs)?.[1];
    assert.ok(body, name);
    return [...body.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  };
  const map = (name) => {
    const body = new RegExp(`${name} = new\\(\\) \\{([^}]*)\\}`).exec(cs)?.[1];
    assert.ok(body, name);
    return Object.fromEntries(
      [...body.matchAll(/\["([^"]*)"\] = "([^"]*)"/g)].map((m) => [m[1], m[2]]),
    );
  };
  assert.deepEqual(array('CommandDeny'), COMMAND_DENY);
  assert.deepEqual(array('CommandDenyAtStart'), COMMAND_DENY_AT_START);
  assert.deepEqual(array('CommandDenyPrefix'), COMMAND_DENY_PREFIX);
  assert.deepEqual(map('CommandConfirm'), COMMAND_CONFIRM);
  assert.deepEqual(map('CommandConfirmAtStart'), COMMAND_CONFIRM_AT_START);
  assert.deepEqual(map('CommandConfirmPrefix'), COMMAND_CONFIRM_PREFIX);
  const python = /PythonDeny =\s*\[([\s\S]*?)\n\s*\];/.exec(cs)?.[1];
  assert.ok(python);
  assert.deepEqual(
    [...python.matchAll(/@"([^"]*)"/g)].map((m) => m[1]),
    PYTHON_DENY,
  );
  assert.equal(/PythonPurge = @"([^"]*)"/.exec(cs)?.[1], PYTHON_PURGE);
});
