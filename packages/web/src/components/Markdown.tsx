// SPDX-License-Identifier: Apache-2.0
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Agent output is untrusted. react-markdown never renders raw HTML and drops unsafe URL
// schemes; images are left out too, so a reply cannot make the page load remote content.
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

/** Renders an agent's reply (GitHub-flavoured markdown) inside the task panel. */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`markdown ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={COMPONENTS}
        disallowedElements={['img']}
        unwrapDisallowed
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
