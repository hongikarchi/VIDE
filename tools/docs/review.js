(() => {
'use strict';
const KEY = 'vino-docs-review-mode';
const sel = document.getElementById('review-mode');
const counts = {};
document.querySelectorAll('.doc-section').forEach(s => {
  const n = s.querySelectorAll('.review-label').length;
  if (n) counts[s.id] = n;
});
const decorate = () => document.querySelectorAll('#toc-links a').forEach(a => {
  const id = decodeURIComponent(a.hash.slice(1));
  if (counts[id]) a.dataset.reviews = String(counts[id]); else delete a.dataset.reviews;
});
decorate();
const toc = document.getElementById('toc-links');
if (toc) new MutationObserver(decorate).observe(toc, { childList: true });
if (!sel) return;
const apply = m => {
  document.body.classList.toggle('review-original', m === 'original');
  document.body.classList.toggle('review-accepted', m === 'accepted');
};
let mode = 'marked';
try { mode = localStorage.getItem(KEY) || 'marked'; } catch (e) {}
if (!['marked', 'original', 'accepted'].includes(mode)) mode = 'marked';
sel.value = mode; apply(mode);
sel.addEventListener('change', () => { apply(sel.value); try { localStorage.setItem(KEY, sel.value); } catch (e) {} });
})();
