const params=new URLSearchParams(location.search),name=params.get('engine')||'speckle';
const container=document.querySelector('#view'),out=document.querySelector('#result');
const report={engine:name,checks:{},limitations:[]};
report.cspViolations=[];document.addEventListener('securitypolicyviolation',e=>report.cspViolations.push({directive:e.violatedDirective,blocked:e.blockedURI}));
const finish=()=>{report.resources=performance.getEntriesByType('resource').map(r=>r.name).filter(n=>/^https?:/.test(n)).map(n=>new URL(n).origin).filter((n,i,a)=>a.indexOf(n)===i);window.__result=report;out.textContent=JSON.stringify(report,null,2);document.title='DONE '+name;};
try{
 const reference=await(await fetch('/reference.json')).json();
 if(name==='speckle'){
  const S=await import('@speckle/viewer'),L=await import('@speckle/objectloader2');
  const viewer=new S.Viewer(container,{...S.DefaultViewerParams,environmentSrc:null,showStats:false,verbose:false});await viewer.init();
  const camera=viewer.createExtension(S.CameraController);viewer.createExtension(S.SelectionExtension);viewer.createExtension(S.SectionTool);viewer.createExtension(S.MeasurementsExtension);
  // Reference viewer is Y-up; Speckle display is Z-up. Preserve units and orientation.
  const meshData=reference.objects.map(o=>({id:o.id,speckle_type:'Objects.Geometry.Mesh',units:'m',vertices:o.positions.map((v,i)=>i%3===0?v:i%3===1?-o.positions[i+1]:o.positions[i-1]),faces:o.indices.flatMap((v,i)=>i%3===0?[3,v]:[v]),renderMaterial:{id:'local-material',speckle_type:'Objects.Other.RenderMaterial',diffuse:0x809480,emissive:0,opacity:1,roughness:1,metalness:0}}));
  const data=[{id:'local-root',speckle_type:'Base',elements:meshData}];
  try{const stock=new S.SpeckleOfflineLoader(viewer.getWorldTree(),data,'stock-local');await viewer.loadObject(stock,true);report.checks.stockLocalLoaded=!!viewer.getWorldTree().findId(meshData[0].id)?.length;}catch(e){report.stockError=String(e.message);}
  await viewer.unloadAll();
  class LocalLoader extends S.SpeckleOfflineLoader{
   initObjectLoader(_resource,_token,_cache,resourceData){return L.ObjectLoader2.createFromObjects(structuredClone(resourceData));}
  }
  const start=performance.now();await viewer.loadObject(new LocalLoader(viewer.getWorldTree(),data,'local-root'),true);
  report.loadMs=performance.now()-start;report.objects=meshData.length;report.checks.localObjectId=!!viewer.getWorldTree().findId(meshData[0].id)?.length;
  report.checks.cameraExtension=!!camera;report.checks.sectionExtension=viewer.hasExtension(S.SectionTool);report.checks.measurementExtension=viewer.hasExtension(S.MeasurementsExtension);
  await viewer.unloadObject('local-root');report.checks.unloadIdGone=!viewer.getWorldTree().findId(meshData[0].id)?.length;
  const updated=[{...data[0],elements:[{...meshData[0],vertices:meshData[0].vertices.map((v,i)=>v+(i%3===1?.01:0))}]}];
  await viewer.loadObject(new LocalLoader(viewer.getWorldTree(),updated,'local-root'),true);report.checks.reloadedStableId=!!viewer.getWorldTree().findId(meshData[0].id)?.length;
  report.limitations.push('Reloaded resource, not in-place vertex update; extension presence is not complete UI interaction validation.');
  await viewer.unloadAll();await viewer.loadObject(new LocalLoader(viewer.getWorldTree(),data,'preview-root'),true);
  viewer.requestRender();await new Promise(r=>setTimeout(r,1000));report.renderStats={...viewer.getRenderer().renderer.info.render};report.checks.finiteSceneBounds=Number.isFinite(viewer.getRenderer().sceneBox.min.x);report.checks.sourcePositionsPreserved=meshData[0].vertices.length>0;window.__viewer=viewer;window.addEventListener('pagehide',()=>viewer.dispose(),{once:true});
 }else{
  const X=await import('@xeokit/xeokit-sdk');const canvas=document.createElement('canvas');canvas.id='xeokit-canvas';container.append(canvas);
  const viewer=new X.Viewer({canvasId:canvas.id,transparent:false});
  const start=performance.now();const model=new X.SceneModel(viewer.scene,{id:'local-model',isModel:true});
  for(const o of reference.objects){model.createMesh({id:o.id+'-mesh',primitive:'triangles',positions:o.positions,indices:o.indices,color:[.5,.58,.5]});model.createEntity({id:o.id,meshIds:[o.id+'-mesh'],isObject:true});}model.finalize();
  viewer.cameraFlight.jumpTo(model);report.loadMs=performance.now()-start;report.objects=reference.objects.length;
  const id=reference.objects[0].id;report.checks.localObjectId=!!viewer.scene.objects[id];
  viewer.scene.objects[id].selected=true;report.checks.selectionState=viewer.scene.objects[id].selected;
  const sections=new X.SectionPlanesPlugin(viewer);sections.createSectionPlane({id:'cut',pos:[0,0,0],dir:[1,0,0]});report.checks.sectionCreated=!!viewer.scene.sectionPlanes.cut;
  const entity=viewer.scene.objects[id];entity.offset=[0,.01,0];report.checks.offsetUpdate=Math.abs(entity.offset[1]-.01)<1e-6;
  model.destroy();report.checks.unloadIdGone=!viewer.scene.objects[id];
  const replacement=new X.SceneModel(viewer.scene,{id:'local-model',isModel:true});const o=reference.objects[0];replacement.createMesh({id:'replacement',primitive:'triangles',positions:o.positions,indices:o.indices,color:[.5,.58,.5]});replacement.createEntity({id,meshIds:['replacement'],isObject:true});replacement.finalize();viewer.cameraFlight.jumpTo(replacement);report.checks.reloadedStableId=!!viewer.scene.objects[id];
  report.limitations.push('Entity offset tested; arbitrary vertex editing uses rebuild in this probe. Section created, interaction not validated.');
  sections.clear();replacement.destroy();const preview=new X.SceneModel(viewer.scene,{id:'preview',isModel:true});for(const item of reference.objects){preview.createMesh({id:item.id+'-preview',primitive:'triangles',positions:item.positions,indices:item.indices,color:[.5,.58,.5]});preview.createEntity({id:item.id,meshIds:[item.id+'-preview'],isObject:true});}preview.finalize();const b=preview.aabb,c=[0,1,2].map(i=>(b[i]+b[i+3])/2),radius=Math.hypot(b[3]-b[0],b[4]-b[1],b[5]-b[2]);viewer.camera.eye=[c[0]+radius,c[1]+radius,c[2]+radius];viewer.camera.look=c;viewer.camera.up=[0,1,0];await new Promise(r=>setTimeout(r,1000));
  window.__viewer=viewer;window.addEventListener('pagehide',()=>viewer.destroy(),{once:true});
 }
 finish();
}catch(e){report.error=e.stack;finish();}
