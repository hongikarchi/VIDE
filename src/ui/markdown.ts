import MarkdownIt from 'markdown-it';

// AI answers are Markdown (T-189). Raw HTML in the text is shown as text (html: false), links
// open only for http(s) and mailto, and images are not loaded, so the result is safe to insert.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
md.disable('image');

const SAFE_LINK = /^(https?:|mailto:)/i;
md.validateLink = (url) => SAFE_LINK.test(url.trim());

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, index, options, env, self);
};

// Wide tables scroll inside their own box instead of widening the chat column.
md.renderer.rules.table_open = () => '<div class="md-table"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';

/** HTML for an AI answer written in Markdown. */
export function renderMarkdown(text: string): string {
  return md.render(text);
}
