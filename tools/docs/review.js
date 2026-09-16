(() => {
'use strict';
const KEY = 'vino-docs-review-mode';
const AUTHOR_KEY = 'vino-docs-review-author';
const sel = document.getElementById('review-mode');
if (!sel) return;
const authorSel = document.getElementById('review-author');
let mode = 'marked';
let author = 'all';
try { mode = localStorage.getItem(KEY) || 'marked'; } catch (e) {}
try { author = localStorage.getItem(AUTHOR_KEY) || 'all'; } catch (e) {}
if (!['marked', 'original', 'accepted'].includes(mode)) mode = 'marked';
if (!authorSel || !Array.from(authorSel.options).some(o => o.value === author)) author = 'all';
const matches = el => author === 'all' || el.dataset.reviewAgent === author;
const decorate = () => {
const query = (document.getElementById('toc-search')?.value || '').trim().toLocaleLowerCase();
let visible = 0;
document.querySelectorAll('#toc-links a').forEach(a => {
  const section = document.getElementById(decodeURIComponent(a.hash.slice(1)));
  if (!section) return;
  a.hidden = !a.dataset.title.toLocaleLowerCase().includes(query) || (section.classList.contains('review-appendix') && (mode !== 'marked' || !matches(section)));
  if (!a.hidden) visible += 1;
  const n = Array.from(section.querySelectorAll('.review-label[data-rid]')).filter(matches).length;
  if (n && mode === 'marked') a.dataset.reviews = String(n); else delete a.dataset.reviews;
});
if (query) document.getElementById('nav-hint').textContent = visible ? `일치하는 장 ${visible}개` : '일치하는 장 제목이 없습니다.';
};
const apply = () => {
  sel.value = mode;
  if (authorSel) { authorSel.value = author; authorSel.disabled = mode !== 'marked'; }
  document.body.classList.toggle('review-original', mode === 'original');
  document.body.classList.toggle('review-accepted', mode === 'accepted');
  document.querySelectorAll('blockquote.review, .review-appendix').forEach(el => { el.hidden = !matches(el); });
  decorate();
  try { localStorage.setItem(KEY, mode); localStorage.setItem(AUTHOR_KEY, author); } catch (e) {}
};
apply();
const toc = document.getElementById('toc-links');
if (toc) new MutationObserver(decorate).observe(toc, { childList: true });
document.getElementById('toc-search')?.addEventListener('input', decorate);
sel.addEventListener('change', () => { mode = sel.value; apply(); });
if (authorSel) authorSel.addEventListener('change', () => { author = authorSel.value; apply(); });
const revealHash = () => {
  let id;
  try { id = decodeURIComponent(location.hash.slice(1)); } catch (e) { return; }
  const target = document.getElementById(id);
  if (!target || !target.dataset.reviewAgent) return;
  mode = 'marked';
  if (!matches(target)) author = 'all';
  apply();
  target.scrollIntoView({ block: 'center' });
};
window.addEventListener('hashchange', revealHash);
revealHash();
})();
