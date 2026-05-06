'use client';

// RichTextEditor — TipTap-based WYSIWYG editor used in field-authoring
// surfaces on the PWA. Same chrome and behavior as the admin app's
// RichTextEditor so authors get a consistent experience whether they
// write at a desk or on equipment.
//
// Storage stays as Markdown via the `tiptap-markdown` extension. Voice
// input via the existing MicButton inserts transcripts at the cursor.

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';
import {
  Bold,
  Italic,
  Heading as HeadingIcon,
  List,
  ListOrdered,
  Link as LinkIcon,
} from 'lucide-react';
import { useEffect } from 'react';
import { MicButton } from '@/components/voice-input';

export function RichTextEditor({
  value,
  onChange,
  placeholder,
  minHeight = 120,
  disabled = false,
}: {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  minHeight?: number;
  disabled?: boolean;
}) {
  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: { levels: [3, 4] },
        codeBlock: false,
      }),
      Placeholder.configure({
        placeholder: placeholder ?? 'Type, or tap the mic to dictate.',
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
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

  const btn = (active: boolean) =>
    `inline-flex h-8 w-8 items-center justify-center rounded transition ${
      active
        ? 'bg-brand-soft-v/30 text-ink-brand'
        : 'text-ink-tertiary hover:bg-surface hover:text-ink-primary'
    }`;

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
          title="Bold"
          aria-label="Bold"
        >
          <Bold size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={btn(editor.isActive('italic'))}
          title="Italic"
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
        <span className="ml-auto" />
        <MicButton size="sm" appendMode onTranscript={insertVoiceTranscript} />
      </div>
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
