(() => {
'use strict';
const sourceData=JSON.parse(document.getElementById('source-data').textContent);
const config=JSON.parse(document.getElementById('reader-config').textContent);
const esc=s=>String(s);
let activeDoc=config.initial;
let observer;
let toastTimer;
const $=s=>document.querySelector(s);
function notify(message){const t=$('#toast');t.textContent=message;t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{t.hidden=true;},3400);}
function renderToc(){const links=$('#toc-links');links.replaceChildren();const nodes=document.querySelectorAll('#'+activeDoc+' .doc-section');nodes.forEach(section=>{const a=document.createElement('a');a.href='#'+section.id;a.textContent=section.querySelector('h2').textContent;a.dataset.title=a.textContent;a.addEventListener('click',()=>{$('#toc-shell').classList.remove('open');$('#toc-toggle').setAttribute('aria-expanded','false');});links.appendChild(a);});$('#toc-count').textContent=nodes.length+' CHAPTERS';$('#toc-search').value='';$('#nav-hint').textContent='章 제목으로 찾아갑니다.'.replace('章','장');if(observer)observer.disconnect();observer=new IntersectionObserver(entries=>{const visible=entries.filter(e=>e.isIntersecting).sort((a,b)=>a.boundingClientRect.top-b.boundingClientRect.top);if(!visible.length)return;document.querySelectorAll('#toc-links a').forEach(a=>a.classList.toggle('active',a.hash==='#'+visible[0].target.id));},{rootMargin:'-90px 0px -64% 0px',threshold:0});nodes.forEach(n=>observer.observe(n));}
function showDoc(name,reset){if(!sourceData[name])name=config.initial;activeDoc=name;document.querySelectorAll('.document').forEach(d=>d.hidden=d.id!==name);document.querySelectorAll('.doc-tab').forEach(a=>{a.classList.toggle('active',a.dataset.doc===name);if(a.dataset.doc===name)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});renderToc();document.title=(config.siteTitle||'VIDE')+' · '+sourceData[name].label;if(reset)window.scrollTo({top:0,behavior:'instant'});}
function useHash(){let raw=decodeURIComponent(location.hash.slice(1)||config.initial);let name=raw.split('-section-')[0];if(!sourceData[name])name=config.initial;if(name!==activeDoc||!$('#toc-links').children.length)showDoc(name,false);const el=document.getElementById(raw);if(el&&!el.hidden){requestAnimationFrame(()=>el.scrollIntoView({block:'start',behavior:'instant'}));}}
window.addEventListener('hashchange',useHash);
document.querySelectorAll('.doc-tab[data-doc]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();const name=a.dataset.doc;showDoc(name,true);history.replaceState(null,'','#'+name);}));
$('#toc-toggle').addEventListener('click',()=>{const on=$('#toc-shell').classList.toggle('open');$('#toc-toggle').setAttribute('aria-expanded',String(on));});
$('#toc-search').addEventListener('input',()=>{const q=$('#toc-search').value.trim().toLocaleLowerCase();let n=0;document.querySelectorAll('#toc-links a').forEach(a=>{a.hidden=!a.dataset.title.toLocaleLowerCase().includes(q);if(!a.hidden)n++;});$('#nav-hint').textContent=q?(n?'일치하는 장 '+n+'개':'일치하는 장 제목이 없습니다.'):'장 제목으로 찾아갑니다.';});
function download(name,contents,type){const blob=new Blob([contents],{type});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2500);}
$('#source-download').addEventListener('click',()=>download(sourceData[activeDoc].file,sourceData[activeDoc].markdown,'text/markdown;charset=utf-8'));
$('#print-doc').addEventListener('click',()=>window.print());
async function copy(text){try{if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(text);return true;}}catch(e){}const t=document.createElement('textarea');t.value=text;t.style.position='fixed';t.style.left='-9999px';document.body.appendChild(t);t.select();let ok=false;try{ok=document.execCommand('copy');}catch(e){}t.remove();return ok;}
document.querySelectorAll('.copy-code').forEach(b=>b.addEventListener('click',async()=>{const text=b.parentElement.querySelector('pre').textContent;const ok=await copy(text);if(ok){b.textContent='복사됨';notify('텍스트를 복사했습니다.');setTimeout(()=>b.textContent='복사',1800);}else{const range=document.createRange();range.selectNodeContents(b.parentElement.querySelector('pre'));const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range);notify('자동 복사가 제한됩니다. 선택된 텍스트를 직접 복사하세요.');}}));
showDoc(config.initial,false);useHash();
})();
