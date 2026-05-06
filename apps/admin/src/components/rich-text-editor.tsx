'use client';

// RichTextEditor — TipTap-based WYSIWYG editor for procedure body
// content. Replaces raw markdown <textarea>s so authors get a familiar
// Word/Notion-style editing experience without learning Markdown
// syntax.
//
// Storage stays as Markdown. The `tiptap-markdown` extension parses
// stored Markdown into ProseMirror nodes on mount and serializes back
// out on every change. Existing rows in the DB don't need migration;
// new edits round-trip cleanly.
//
// Toolbar: Bold, Italic, Bullet list, Numbered list, Heading 3 (sub-
// section), Link, plus the shared MicButton for voice-to-text. Keeps
// the floor low for engineers and technicians who haven't authored
// digital docs before.

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import { Markdown } from 'tiptap-markdown';
import {
  Bold,
  Italic,
  Heading as HeadingIcon,
  Image as ImageIcon,
  List,
  ListOrdered,
  Link as LinkIcon,
  Table as TableIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MicButton } from './voice-input';

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  minHeight = 140,
  disabled = false,
  onImageUpload,
}: {
  /** Markdown string. Empty string is treated as "no content." */
  value: string;
  /** Called with the updated Markdown string on every meaningful change. */
  onChange: (markdown: string) => void;
  placeholder?: string;
  /** Minimum editor body height in px so short docs still feel like a real editor. */
  minHeight?: number;
  disabled?: boolean;
  /** When provided, the toolbar exposes an Image button that calls this
   *  on file pick and inserts the returned URL inline. Without it, images
   *  can't be inserted (the button is hidden). */
  onImageUpload?: (file: File) => Promise<string>;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: { levels: [3, 4] },
        // ProseMirror's default codeBlock collides with markdown serializer
        // edge cases on this version; drop it for v1 (re-enable later if
        // authors actually want code blocks in procedures).
        codeBlock: false,
      }),
      Placeholder.configure({
        placeholder: placeholder ?? 'Type, or tap the mic to dictate.',
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      Image.configure({
        inline: false,
        allowBase64: false,
        HTMLAttributes: { class: 'rte-image' },
      }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Markdown.configure({
        html: false,
        breaks: true,
        linkify: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
    ],
    content: value || '',
    onUpdate({ editor }) {
      const md = (editor.storage as { markdown?: { getMarkdown(): string } })
        .markdown?.getMarkdown();
      if (md != null) onChange(md);
    },
    editorProps: {
      attributes: {
        class:
          'rte-content prose prose-sm max-w-none focus:outline-none px-3 py-2',
      },
    },
  });

  // Re-sync external value changes (e.g., voice transcript appended,
  // form reset). Skipped when the editor is the source of truth.
  useEffect(() => {
    if (!editor) return;
    const current =
      (editor.storage as { markdown?: { getMarkdown(): string } })
        .markdown?.getMarkdown() ?? '';
    if (current !== value) {
      editor.commands.setContent(value || '', false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  if (!editor) {
    return (
      <div
        className="rounded border border-line bg-surface-raised p-3 text-sm text-ink-tertiary"
        style={{ minHeight }}
      >
        Loading editor…
      </div>
    );
  }

  function insertVoiceTranscript(text: string) {
    if (!editor) return;
    editor.chain().focus().insertContent(text + ' ').run();
  }

  function toggleLink() {
    if (!editor) return;
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('URL', prev ?? 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }

  function insertTable() {
    if (!editor) return;
    editor
      .chain()
      .focus()
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
      .run();
  }

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !editor || !onImageUpload) return;
    setUploading(true);
    setUploadError(null);
    try {
      const url = await onImageUpload(file);
      editor.chain().focus().setImage({ src: url, alt: file.name }).run();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }

  const btn = (active: boolean, extra = '') =>
    `inline-flex h-8 w-8 items-center justify-center rounded transition ${
      active
        ? 'bg-brand-soft-v/30 text-ink-brand'
        : 'text-ink-tertiary hover:bg-surface hover:text-ink-primary'
    } ${extra}`;

  return (
    <div
      className="overflow-hidden rounded border border-line bg-surface-raised focus-within:border-brand"
      onClick={() => editor.chain().focus().run()}
    >
      <div
        className="flex flex-wrap items-center gap-0.5 border-b border-line-subtle bg-surface px-1.5 py-1"
        onMouseDown={(e) => e.preventDefault()}
      >
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={btn(editor.isActive('bold'))}
          title="Bold (Ctrl+B)"
          aria-label="Bold"
        >
          <Bold size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={btn(editor.isActive('italic'))}
          title="Italic (Ctrl+I)"
          aria-label="Italic"
        >
          <Italic size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: 3 }).run()
          }
          className={btn(editor.isActive('heading', { level: 3 }))}
          title="Sub-heading"
          aria-label="Sub-heading"
        >
          <HeadingIcon size={14} strokeWidth={2} />
        </button>
        <span className="mx-1 h-5 w-px bg-line-subtle" aria-hidden />
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={btn(editor.isActive('bulletList'))}
          title="Bullet list"
          aria-label="Bullet list"
        >
          <List size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={btn(editor.isActive('orderedList'))}
          title="Numbered list"
          aria-label="Numbered list"
        >
          <ListOrdered size={14} strokeWidth={2} />
        </button>
        <span className="mx-1 h-5 w-px bg-line-subtle" aria-hidden />
        <button
          type="button"
          onClick={toggleLink}
          className={btn(editor.isActive('link'))}
          title="Link"
          aria-label="Link"
        >
          <LinkIcon size={14} strokeWidth={2} />
        </button>
        {onImageUpload && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={btn(false)}
            title={uploading ? 'Uploading…' : 'Insert image'}
            aria-label="Insert image"
            disabled={uploading}
          >
            <ImageIcon size={14} strokeWidth={2} />
          </button>
        )}
        <button
          type="button"
          onClick={insertTable}
          className={btn(editor.isActive('table'))}
          title="Insert table"
          aria-label="Insert table"
        >
          <TableIcon size={14} strokeWidth={2} />
        </button>
        <span className="ml-auto" />
        <MicButton size="sm" onTranscript={insertVoiceTranscript} />
      </div>
      {onImageUpload && (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={onPickImage}
          className="hidden"
        />
      )}
      {uploadError && (
        <div className="border-b border-signal-fault/40 bg-signal-fault/10 px-3 py-1.5 text-xs text-signal-fault">
          {uploadError}
        </div>
      )}
      <div
        className="rte-host"
        style={{ minHeight }}
        onClick={() => editor.chain().focus().run()}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
