import { memo, useEffect, useMemo } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Placeholder } from '@tiptap/extensions';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { NOTE_FIELD } from '../../contracts/note-doc';

/**
 * The block editor of a shared note (SPEC-10.3, Design SCR-23), the same on the account site and
 * in VIDE: TipTap bound to the note's Yjs document, other people's cursors from awareness.
 * Markdown shortcuts work as typed (`# `, `- `, `1. `, `[ ] `, `> `, `---`).
 */
export interface NoteUser {
  name: string;
  color: string;
}
const COLORS = ['#d0664a', '#2f5aa8', '#2f7d4f', '#a8660b', '#7a4fb0', '#1f8a8a', '#b42367'];
export const userColor = (name: string) =>
  COLORS[[...name].reduce((sum, c) => (sum * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];

function Toolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null;
  const chain = () => editor.chain().focus();
  const tools: [string, string, () => void, boolean][] = [
    [
      '제목',
      'H1',
      () => chain().toggleHeading({ level: 1 }).run(),
      editor.isActive('heading', { level: 1 }),
    ],
    [
      '소제목',
      'H2',
      () => chain().toggleHeading({ level: 2 }).run(),
      editor.isActive('heading', { level: 2 }),
    ],
    ['굵게', 'B', () => chain().toggleBold().run(), editor.isActive('bold')],
    ['목록', '•', () => chain().toggleBulletList().run(), editor.isActive('bulletList')],
    ['번호 목록', '1.', () => chain().toggleOrderedList().run(), editor.isActive('orderedList')],
    ['체크 목록', '☐', () => chain().toggleTaskList().run(), editor.isActive('taskList')],
    ['인용', '❝', () => chain().toggleBlockquote().run(), editor.isActive('blockquote')],
    ['구분선', '—', () => chain().setHorizontalRule().run(), false],
  ];
  return (
    <div className="note-toolbar" role="toolbar" aria-label="서식">
      {tools.map(([label, glyph, run, active]) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          title={label}
          aria-pressed={active}
          className={active ? 'active' : ''}
          onMouseDown={(event) => event.preventDefault()}
          onClick={run}
        >
          {glyph}
        </button>
      ))}
    </div>
  );
}

/**
 * Another person's caret: not editable, so a caret placed next to it (End at that line's end)
 * stays in the text the editor reads; colours are set through CSSOM (the CSP has no inline style).
 */
function caret(user: Record<string, unknown>) {
  const color =
    typeof user.color === 'string' && /^#[0-9a-f]{6}$/i.test(user.color) ? user.color : '#737373';
  const cursor = document.createElement('span');
  cursor.className = 'collaboration-carets__caret';
  cursor.contentEditable = 'false';
  cursor.style.borderColor = color;
  const label = document.createElement('span');
  label.className = 'collaboration-carets__label';
  label.contentEditable = 'false';
  label.style.backgroundColor = color;
  label.textContent = String(user.name ?? '');
  cursor.append(label);
  return cursor;
}

/**
 * Memoized: the editor and its extensions are made once per document. A parent re-render (a
 * cursor moved, the status changed) must not hand TipTap new options, which would rebuild the
 * collaboration plugins and lose the selection.
 */
export const NoteEditor = memo(function NoteEditor({
  doc,
  awareness,
  user,
  placeholder = '여기에 적으세요. # 제목, - 목록, [ ] 할 일',
}: {
  doc: Y.Doc;
  awareness: Awareness;
  user: NoteUser;
  placeholder?: string;
}) {
  const options = useMemo(
    () => ({
      extensions: [
        // Undo comes from the shared document (Collaboration); no trailing paragraph either, which
        // every client would add on its own.
        StarterKit.configure({
          undoRedo: false,
          trailingNode: false,
          link: { openOnClick: false },
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Placeholder.configure({ placeholder }),
        Collaboration.configure({ document: doc, field: NOTE_FIELD }),
        CollaborationCaret.configure({ provider: { awareness }, user, render: caret }),
      ],
      // The pages' CSP allows no inline style: the editor's base CSS is in notes.css.
      injectCSS: false,
      editorProps: { attributes: { 'aria-label': '노트 본문', class: 'note-body' } },
      shouldRerenderOnTransaction: true,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per document
    [doc, awareness],
  );
  const editor = useEditor(options, [doc, awareness]);
  useEffect(() => {
    awareness.setLocalStateField('user', user);
  }, [awareness, user.name, user.color]);
  return (
    <div className="note-editor">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
});
