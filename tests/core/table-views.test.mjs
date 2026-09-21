import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Store} from '../../src/core/store.ts';import {TableViews} from '../../src/core/table-views.ts';
test('table definitions survive reopen and reject foreign projects or stale edits/deletes',()=>{
 const directory=mkdtempSync(join(tmpdir(),'vide-table-views-'));let store=new Store(join(directory,'data.sqlite'));
 try{
  let views=new TableViews(store);const project=store.createProject('tables'),other=store.createProject('other');
  const saved=views.save(project.id,{name:'Site quantities',query:{layer:'Site',groupBy:'type'}});assert.equal(saved.revision,1);
  store.close();store=new Store(join(directory,'data.sqlite'));views=new TableViews(store);assert.deepEqual(views.list(project.id)[0],saved);assert.deepEqual(views.list(other.id),[]);
  assert.throws(()=>views.save(other.id,{name:'forged',query:{},revision:1},saved.id),{code:'NOT_FOUND'});
  const updated=views.save(project.id,{name:'Updated',query:{groupBy:'layer'},revision:1},saved.id);assert.equal(updated.revision,2);
  assert.throws(()=>views.save(project.id,{name:'stale',query:{},revision:1},saved.id),{code:'REVISION_CONFLICT'});assert.throws(()=>views.remove(project.id,saved.id,1),{code:'REVISION_CONFLICT'});
  views.remove(project.id,saved.id,2);assert.deepEqual(views.list(project.id),[]);
 }finally{store.close();assert.ok(directory.startsWith(join(tmpdir(),'vide-table-views-')));rmSync(directory,{recursive:true,force:true});}
});
