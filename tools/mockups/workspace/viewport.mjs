import * as THREE from '/vendor/three.module.js';
import { OrbitControls } from '/vendor/OrbitControls.js';

export function createViewport(container, objects, onPick, onPoint) {
  const scene = new THREE.Scene(); scene.background = new THREE.Color('#f5f6f2');
  const perspective = new THREE.PerspectiveCamera(40, 1, .1, 1000);
  const orthographic = new THREE.OrthographicCamera(-25,25,25,-25,.1,1000);
  let viewSpan=50;
  let camera=perspective; camera.up.set(0,0,1);
  const renderer = new THREE.WebGLRenderer({antialias:true}); renderer.setPixelRatio(Math.min(devicePixelRatio,2));
  renderer.domElement.setAttribute('aria-label','3D 모델 · 드래그 회전, 휠 확대, 우클릭 이동');
  renderer.domElement.tabIndex=0; container.append(renderer.domElement);
  let controls=new OrbitControls(camera,renderer.domElement); controls.enableDamping=true;
  controls.minDistance=4;controls.maxDistance=180;
  const grid=new THREE.GridHelper(100,50,0xb8c2b9,0xe0e5dc);grid.rotation.x=Math.PI/2;scene.add(grid);
  scene.add(new THREE.HemisphereLight(0xffffff,0x9caaa1,2.4));
  const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(-12,-16,30);scene.add(light);
  const meshes=objects.map((o,i)=>{
    const geometry=new THREE.BoxGeometry(o.width,o.depth,o.height);
    const mesh=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:0xd7ded4,roughness:.85}));
    mesh.position.set(i===0?-9:9,i===0?0:4,o.height/2);mesh.userData.id=o.id;
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry),new THREE.LineBasicMaterial({color:0x69766c})));
    scene.add(mesh);return mesh;
  });
  const lines=new THREE.Group();scene.add(lines);
  const ray=new THREE.Raycaster(),mouse=new THREE.Vector2();let mode='select',planeName='XY',down=null,frame;
  function sizing(){const w=container.clientWidth,h=container.clientHeight;if(!w||!h)return;renderer.setSize(w,h);perspective.aspect=w/h;perspective.updateProjectionMatrix();orthographic.left=-viewSpan*w/h/2;orthographic.right=viewSpan*w/h/2;orthographic.top=viewSpan/2;orthographic.bottom=-viewSpan/2;orthographic.updateProjectionMatrix();}
  function configure(){controls.enableRotate=camera.isPerspectiveCamera&&mode!=='sketch';controls.mouseButtons.LEFT=mode==='sketch'?null:camera.isOrthographicCamera?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE;}
  function activate(next,target){controls.dispose();camera=next;camera.lookAt(target);controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.minDistance=4;controls.maxDistance=180;controls.minZoom=.2;controls.maxZoom=20;controls.target.copy(target);configure();sizing();controls.update();renderer.domElement.dataset.projection=camera.isOrthographicCamera?'orthographic':'perspective';}
  function fit(){
    const bounds=new THREE.Box3();meshes.forEach(m=>bounds.expandByObject(m));const center=bounds.getCenter(new THREE.Vector3());
    const shift=center.clone().sub(controls.target);camera.position.add(shift);controls.target.copy(center);camera.lookAt(center);camera.updateMatrixWorld();
    if(camera.isOrthographicCamera){let halfW=0,halfH=0;const c=center.clone().applyMatrix4(camera.matrixWorldInverse);for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z]){const q=new THREE.Vector3(x,y,z).applyMatrix4(camera.matrixWorldInverse).sub(c);halfW=Math.max(halfW,Math.abs(q.x));halfH=Math.max(halfH,Math.abs(q.y));}const aspect=container.clientWidth/Math.max(1,container.clientHeight);viewSpan=2.6*Math.max(halfH,halfW/aspect,1);camera.zoom=1;}
    else {const radius=bounds.getBoundingSphere(new THREE.Sphere()).radius;const v=THREE.MathUtils.degToRad(camera.fov/2),h=Math.atan(Math.tan(v)*camera.aspect);const distance=radius/Math.sin(Math.min(v,h))*1.1;const direction=camera.position.clone().sub(center).normalize();camera.position.copy(center).addScaledVector(direction,distance);}
    sizing();controls.update();
  }
  function home(){perspective.up.set(0,0,1);perspective.position.set(34,-43,32);activate(perspective,new THREE.Vector3(0,2,2));grid.rotation.set(Math.PI/2,0,0);fit();}
  home();
  function planeView(name){planeName=name;orthographic.zoom=1;orthographic.up.set(0,0,1);if(name==='XY'){orthographic.up.set(0,1,0);orthographic.position.set(0,0,52);grid.rotation.set(Math.PI/2,0,0);}else if(name==='XZ'){orthographic.position.set(0,-52,0);grid.rotation.set(0,0,0);}else{orthographic.position.set(52,0,0);grid.rotation.set(0,0,Math.PI/2);}activate(orthographic,new THREE.Vector3());fit();}
  function rayAt(e){const r=renderer.domElement.getBoundingClientRect();mouse.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);ray.setFromCamera(mouse,camera);}
  function pointerDown(e){if(e.button===0)down={x:e.clientX,y:e.clientY};}
  function pointerUp(e){if(e.button!==0||!down)return;const moved=Math.hypot(e.clientX-down.x,e.clientY-down.y);down=null;if(moved>5)return;rayAt(e);
    if(mode==='sketch'){const normal=planeName==='XY'?new THREE.Vector3(0,0,1):planeName==='XZ'?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0);const hit=ray.ray.intersectPlane(new THREE.Plane(normal,0),new THREE.Vector3());if(hit){const uv=planeName==='XY'?[hit.x,hit.y]:planeName==='XZ'?[hit.x,hit.z]:[hit.y,hit.z];onPoint(uv.map(n=>Math.round(n*100)/100));}}
    else {const hit=ray.intersectObjects(meshes,false)[0];if(hit)onPick(hit.object.userData.id,mode==='pin');}
  }
  function cancel(){down=null;}
  renderer.domElement.addEventListener('pointerdown',pointerDown);renderer.domElement.addEventListener('pointerup',pointerUp);renderer.domElement.addEventListener('pointercancel',cancel);
  const resize=new ResizeObserver(sizing);resize.observe(container);
  function animate(){frame=requestAnimationFrame(animate);controls.update();renderer.render(scene,camera);}animate();
  return {
    select(id){meshes.forEach(m=>m.material.color.setHex(m.userData.id===id?0xe4bca6:0xd7ded4));},
    mode(next,plane='XY'){mode=next;configure();renderer.domElement.dataset.tool=next;if(next==='sketch')planeView(plane);},
    plane:planeView,home,fit,
    lines(sketches,draft,plane){while(lines.children.length){const l=lines.children[0];lines.remove(l);l.geometry.dispose();l.material.dispose();}for(const s of [...sketches,{points:draft,plane}]){if(s.points.length<2)continue;const points=s.points.map(([u,v])=>s.plane==='XY'?new THREE.Vector3(u,v,.02):s.plane==='XZ'?new THREE.Vector3(u,-.02,v):new THREE.Vector3(.02,u,v));const l=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points),new THREE.LineBasicMaterial({color:0xc5684b,depthTest:false}));l.renderOrder=10;lines.add(l);}},
    dispose(){cancelAnimationFrame(frame);resize.disconnect();controls.dispose();renderer.domElement.removeEventListener('pointerdown',pointerDown);renderer.domElement.removeEventListener('pointerup',pointerUp);renderer.domElement.removeEventListener('pointercancel',cancel);scene.traverse(o=>{o.geometry?.dispose();if(o.material)for(const m of Array.isArray(o.material)?o.material:[o.material])m.dispose();});renderer.dispose();renderer.domElement.remove();},
  };
}
