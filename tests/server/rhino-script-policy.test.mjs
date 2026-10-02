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
  COMMAND_DENY_UNLESS_OPTION,
  COMMAND_DENY_PREFIX,
  COMMAND_CONFIRM,
  COMMAND_CONFIRM_UNLESS_OPTION,
  COMMAND_CONFIRM_PREFIX,
  COMMAND_OPTION_OWNERS,
  GUARD_SEVERITY,
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
    '_-Snapshots _Save "A" _Enter',
    '_Curve 0,0,0 5,5,0 10,0,0 _Close',
    '_-Points 0,0,0 1,0,0 _Undo 2,0,0 _Enter',
  ])
    assert.deepEqual(checkRhinoCommand(script), { ok: true }, script);
});

test('opening, quitting, scripts from disk, plug-ins and undo are refused; options, units and Grasshopper pass (ADR-031 8)', () => {
  for (const script of [
    '_-Options _Enter',
    '_-Units _Millimeters _Enter',
    '_Line _Pause _Pause',
    '_-Grasshopper _Enter',
    '_-DocumentProperties _Enter',
  ])
    assert.equal(checkRhinoCommand(script).ok, true, script);
  for (const [script, word] of [
    ['_Exit', '_exit'],
    ['!_-Open "C:\\a.3dm"', '_open'],
    ['_-Import "C:\\a.dwg"', '_import'],
    ['_-ImportLayouts', '_importlayouts'],
    ['_-RunScript (Command "_Exit")', '_runscript'],
    ['_-RunPythonScript "C:\\a.py"', '_runpythonscript'],
    ['_-PlugInManager', '_pluginmanager'],
    ['_New', '_new'],
    ['_Undo', '_undo'],
    ['_SelAll _Enter _Undo', '_undo'],
    ['_ClearUndo', '_clearundo'],
    // A command that asks nothing is followed by the next command on the same line: the shared
    // words are options only right after the command that owns them (review finding, 2026-10-02).
    ['_SelNone _Close', '_close'],
    ['_SelAll _Undo', '_undo'],
    ['_SelAll _Delete _New', '_new'],
    ['_SelNone _-Insert "x.3dm" _Enter _Enter', '_insert'],
    ['_SelAll _Redo', '_redo'],
    // Close ends Polyline, so the Undo after it is the Undo command; Line ends after two points.
    ['_Polyline 0,0,0 1,0,0 2,1,0 _Close _Undo', '_undo'],
    ['_Line 0,0,0 1,0,0 _Undo', '_undo'],
    ['_SelName Layer _New', '_new'],
  ]) {
    const verdict = checkRhinoCommand(script);
    assert.equal(verdict.ok, false, script);
    assert.match(verdict.diagnostics[0], new RegExp(word), script);
  }
});

test('the refusal says Redo and Insert are always refused, as the policy does', () => {
  const verdict = checkRhinoCommand('_Polyline 0,0,0 1,0,0 _Redo');
  assert.equal(verdict.ok, false);
  assert.match(verdict.diagnostics[0], /Redo and Insert are always refused/);
  assert.doesNotMatch(verdict.diagnostics[0], /Undo, Redo and Insert pass/);
});

test('commands that write files or purge are held for the card with their kind', () => {
  assert.equal(checkRhinoCommand('_-SaveAs "C:\\b.3dm"').guard.kind, 'save-as');
  const save = checkRhinoCommand('_Save');
  assert.equal(save.guard.kind, 'save');
  assert.match(save.guard.detail, /열린 원본 파일을 덮어씁니다\(_save\)/);
  assert.equal(checkRhinoCommand('_-Export "C:\\a.dwg" _Enter').guard.kind, 'export');
  assert.equal(checkRhinoCommand('_-ExportWithOrigin 0,0,0 "a.dwg"').guard.kind, 'export');
  assert.equal(checkRhinoCommand('_-Print _Go').guard.kind, 'publish');
  const purge = checkRhinoCommand('_-Purge _Enter');
  assert.equal(purge.guard.kind, 'purge');
  assert.match(purge.guard.detail, /되돌릴 수 없습니다/);
  // A refusal wins over a guard.
  assert.equal(checkRhinoCommand('_Save _Exit').ok, false);
});

test('a save after a command that asks nothing is still held (not taken for an option)', () => {
  for (const script of ['_SelAll _Save', '_NoEcho _Save', '_SelAll _Join _Save']) {
    const verdict = checkRhinoCommand(script);
    assert.equal(verdict.ok, true, script);
    assert.equal(verdict.guard?.kind, 'save', script);
  }
  // NamedView's Save option is still an option, also after the view name.
  assert.deepEqual(checkRhinoCommand('_-NamedView _Save Top _Enter'), { ok: true });
});

test('a macro with several guarded commands names all of them; the card takes the most severe', () => {
  const both = checkRhinoCommand('_-Export "a.dwg" _Enter _-SaveAs "b.3dm" _Enter');
  assert.equal(both.guard.kind, 'save-as');
  assert.match(both.guard.detail, /_export/);
  assert.match(both.guard.detail, /_saveas/);
  const purgeSave = checkRhinoCommand('_-Purge _Enter _Save');
  assert.equal(purgeSave.guard.kind, 'save');
  assert.match(purgeSave.guard.detail, /원본 파일을 덮어씁니다\(_save\)/);
  assert.match(purgeSave.guard.detail, /정리\(_purge\)/);
  const print = checkRhinoCommand('_-Print _Go _Enter _-Export "a.dwg" _Enter');
  assert.equal(print.guard.kind, 'export');
  assert.match(print.guard.detail, /인쇄 명령\(_print\)/);
  assert.deepEqual(GUARD_SEVERITY, ['save', 'save-as', 'purge', 'export', 'publish']);
});

test('command words: prefixes, quoted values and command positions', () => {
  assert.deepEqual(commandWords('!_-SelDup _Enter "a b" _Delete=Yes\n_Join'), [
    { word: 'seldup', start: true, command: 'seldup' },
    { word: 'enter', start: false, command: 'seldup' },
    { word: 'delete', start: false, command: '' },
    { word: 'join', start: true, command: 'join' },
  ]);
  assert.deepEqual(commandWords('_SelAll _Join _Save'), [
    { word: 'selall', start: true, command: 'selall' },
    { word: 'join', start: false, command: 'selall' },
    { word: 'save', start: false, command: 'selall' },
  ]);
});

test('Python: geometry, tables, threads and getattr pass; file, network, process, code loading and undo are refused', () => {
  for (const source of [
    'import rhinoscriptsyntax as rs\nrs.AddLine((0,0,0),(1,0,0))',
    // Since ADR-031 8 only escape rules stay.
    "name = getattr(obj, 'Name', None)",
    'import threading',
    'import Rhino\nRhino.RhinoApp.WriteLine("x")',
    'from Rhino import RhinoApp',
    'value = input',
    'g = globals()',
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
    // Commands reached without a dotted call (review finding, 2026-10-02).
    'from rhinoscriptsyntax import *\nCommand("_-Export a.dwg")',
    'import rhinoscriptsyntax as rs\nc = rs.Command\nc("_Save")',
    'from rhinoscriptsyntax import Command as run',
    'from rhinoscriptsyntax.application import Command',
    // Saving the document from Python skips the save card (review finding, 2026-10-02).
    'import scriptcontext as sc\nsc.doc.Save()',
    'sc.doc.SaveAs(r"C:\\a.3dm")',
    'sc.doc.SaveAsTemplate(path)',
    'sc.doc.SaveWithOptions (opts)',
    // The interpreter's escape hatches stay refused.
    "f = getattr(__builtins__, 'op' + 'en')",
    'sc.doc.__class__.__subclasses__()',
  ]) {
    const verdict = checkRhinoPython(source);
    assert.equal(verdict.ok, false, source);
    assert.match(verdict.diagnostics[0], /not permitted/);
  }
  for (const source of [
    'sc.doc.Materials.Compact()',
    'sc.doc.InstanceDefinitions.Compact(True)',
    'sc.doc.Layers.Purge(i, True)',
    'rs.PurgeLayer("Old")',
  ])
    assert.equal(checkRhinoPython(source).guard?.kind, 'purge', source);
  // Geometry Compact (mesh/brep tidy in memory) is not a document purge.
  for (const source of [
    'mesh.Compact()',
    'brep.Compact()',
    'm = Rhino.Geometry.Mesh()\nm.Compact()',
  ])
    assert.deepEqual(checkRhinoPython(source), { ok: true }, source);
  // Names that merely contain Save, or attributes read directly, still pass.
  for (const source of ['saved = 3\nprint(saved)', 'rs.ObjectName(i, "SaveMe")', 'n = sc.doc.Name'])
    assert.deepEqual(checkRhinoPython(source), { ok: true }, source);
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
  assert.deepEqual(array('CommandDenyUnlessOption'), COMMAND_DENY_UNLESS_OPTION);
  assert.deepEqual(array('GuardSeverity'), GUARD_SEVERITY);
  assert.deepEqual(array('CommandDenyPrefix'), COMMAND_DENY_PREFIX);
  assert.deepEqual(map('CommandConfirm'), COMMAND_CONFIRM);
  assert.deepEqual(map('CommandConfirmUnlessOption'), COMMAND_CONFIRM_UNLESS_OPTION);
  const owners = /CommandOptionOwners = new\(\) \{(.*)\};/.exec(cs)?.[1];
  assert.ok(owners, 'CommandOptionOwners');
  assert.deepEqual(
    Object.fromEntries(
      [...owners.matchAll(/\["([^"]*)"\] = \[([^\]]*)\]/g)].map((m) => [
        m[1],
        [...m[2].matchAll(/"([^"]*)"/g)].map((w) => w[1]),
      ]),
    ),
    COMMAND_OPTION_OWNERS,
  );
  assert.deepEqual(map('CommandConfirmPrefix'), COMMAND_CONFIRM_PREFIX);
  const python = /PythonDeny =\s*\[([\s\S]*?)\n\s*\];/.exec(cs)?.[1];
  assert.ok(python);
  assert.deepEqual(
    [...python.matchAll(/@"([^"]*)"/g)].map((m) => m[1]),
    PYTHON_DENY,
  );
  assert.equal(/PythonPurge = @"([^"]*)"/.exec(cs)?.[1], PYTHON_PURGE);
});
