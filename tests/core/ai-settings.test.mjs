import {test} from 'node:test';import assert from 'node:assert/strict';import {Store} from '../../src/core/store.mjs';import {AiSettings} from '../../src/core/ai-settings.mjs';
test('CLI settings persist paths, enforce revisions and reject credentials, shell commands and missing files',()=>{
 const store=new Store(':memory:');try{
  const settings=new AiSettings(store,path=>!path.includes('missing'));assert.equal(settings.get().revision,0);
  const paths={'claude-cli':'C:/Tools/claude.exe','codex-cli':'C:/Tools/codex.exe'};const saved=settings.save({revision:0,paths});assert.equal(saved.paths['codex-cli'],'C:\\Tools\\codex.exe');assert.deepEqual(new AiSettings(store).get(),saved);
  assert.throws(()=>settings.save({revision:0,paths}),{code:'REVISION_CONFLICT'});
  for(const path of ['cmd.exe /c codex','C:/Tools/codex.cmd','https://example.com/codex.exe','\\\\server\\share\\codex.exe'])assert.throws(()=>settings.save({revision:1,paths:{...paths,'codex-cli':path}}),{code:'INVALID_CLI_PATH'});
  assert.throws(()=>settings.save({revision:1,paths,token:'secret'}),{code:'INVALID_INPUT'});assert.throws(()=>settings.save({revision:1,paths:{...paths,'codex-cli':'C:/missing/codex.exe'}}),{code:'CLI_FILE_MISSING'});assert.equal(settings.get().revision,1);
  assert.deepEqual(settings.save({revision:1,paths:{'claude-cli':null,'codex-cli':null}}).paths,{'claude-cli':null,'codex-cli':null});
 }finally{store.close();}
});
