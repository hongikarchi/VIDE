import test from 'node:test';
import assert from 'node:assert/strict';
import {csharpLiteral} from '../../hosts/common/csharp.ts';
test('C# verbatim literals preserve quotes, paths, newlines and Unicode',()=>{
 for(const input of ['a"b','C:\\models\\file.3dm','line1\nline2','한글 🏠','']) {
  const code=csharpLiteral(input);
  assert.ok(code.startsWith('@"')&&code.endsWith('"'));
  assert.equal(code.slice(2,-1).replaceAll('""','"'),input);
 }
 assert.equal(csharpLiteral('"; throw new Exception(); //'),'@"""; throw new Exception(); //"');
});
