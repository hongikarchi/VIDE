import test from 'node:test';
import assert from 'node:assert/strict';
import { csharpLiteral } from '../../hosts/common/csharp.ts';
test('C# verbatim literals preserve quotes, paths, newlines and Unicode', () => {
  for (const input of ['a"b', 'C:\\models\\file.3dm', 'line1\nline2', '한글 🏠', '']) {
    const code = csharpLiteral(input);
    assert.ok(code.startsWith('@"') && code.endsWith('"'));
    assert.equal(code.slice(2, -1).replaceAll('""', '"'), input);
  }
  assert.equal(csharpLiteral('"; throw new Exception(); //'), '@"""; throw new Exception(); //"');
});

// The Rhino plugin cannot run here; these source checks keep the direct-mode safety net in place.
test('Rhino direct execution runs in one undo record and generated code cannot control undo', async () => {
  const { readFile } = await import('node:fs/promises');
  const read = (name) =>
    readFile(new URL(`../../hosts/rhino/worker/${name}`, import.meta.url), 'utf8');
  const [direct, connection, policy] = await Promise.all([
    read('DirectExecution.cs'),
    read('AttachedConnection.cs'),
    read('CodePolicy.cs'),
  ]);
  for (const method of ['direct-execute', 'direct-undo', 'fingerprint'])
    assert.ok(connection.includes(`method == "${method}"`), method);
  assert.ok(direct.includes('BeginUndoRecord(label)') && direct.includes('EndUndoRecord(serial)'));
  assert.ok(
    direct.includes('"bulk-delete"') &&
      direct.includes('"layer-delete"') &&
      direct.includes('"purge"'),
  );
  // Latest: every later record is undone or an empty one; Undo/Redo outside a command close their own record.
  assert.ok(direct.includes('reason = "not-latest"') && direct.includes('!undone.Contains(later)'));
  assert.ok(direct.includes('CloseOwnRecord(next)'));
  for (const member of [
    '"Undo"',
    '"BeginUndoRecord"',
    '"UndoRecordingEnabled"',
    'RhinoDocUndoRecord',
  ])
    assert.ok(policy.includes(member), member);
  // Read-only validity checks inherited from CommonObject are allowed; Rhino.Runtime stays denied otherwise.
  assert.ok(policy.includes('"Rhino.Runtime"'));
  assert.match(
    policy,
    /name == "Rhino\.Runtime\.CommonObject" && symbol\.Name is "IsValid" or "IsValidWithLog" or "IsDocumentControlled"\) continue;/,
  );
});
