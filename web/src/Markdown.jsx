import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function Markdown({ content }) {
  return <div className="markdown"><ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      a: (props) => <a href={props.href} rel="noreferrer noopener" target="_blank">{props.children}</a>,
      img: (props) => props.alt || null,
      table: (props) => <div className="table-scroll"><table>{props.children}</table></div>,
    }}
  >{content}</ReactMarkdown></div>;
}

