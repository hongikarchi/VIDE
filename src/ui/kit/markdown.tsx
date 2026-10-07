import { useMemo } from 'react';
import { renderMarkdown } from '../markdown.ts';
import './markdown.css';

/** An AI answer drawn from its Markdown (T-189). The HTML is escaped and its links checked. */
export function Markdown({
  text,
  className,
  label,
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className={className ? `md ${className}` : 'md'}
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
