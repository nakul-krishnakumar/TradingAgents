import { cloneElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import { Popover } from 'radix-ui';
import './help.css';

let dismissOpenHelp;

export function Help({ label, text, className = '', side = 'top' }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = useRef(null);
  const timer = useRef();
  const pinned = useRef(false);

  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    pinned.current = false;
    if (dismissOpenHelp === close) dismissOpenHelp = undefined;
    setOpen(false);
  }, []);

  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (dismissOpenHelp === close) dismissOpenHelp = undefined;
  }, [close]);

  function show() {
    window.clearTimeout(timer.current);
    if (dismissOpenHelp !== close) dismissOpenHelp?.();
    dismissOpenHelp = close;
    setOpen(true);
  }

  function leave(event) {
    if (event.pointerType !== 'mouse' || pinned.current || button.current?.matches(':focus-visible')) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(close, 160);
  }

  return <Popover.Root open={open} onOpenChange={(value) => { if (!value) close(); }}>
    <Popover.Anchor asChild>
      <button ref={button} type="button" className={`help-trigger ${className}`.trim()} aria-label={`Help for ${label}`}
        aria-expanded={open} aria-controls={open ? id : undefined} aria-describedby={open ? `${id}-description` : undefined}
        data-log="help.toggle"
        onPointerEnter={(event) => {
          if (event.pointerType !== 'mouse') return;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(show, 220);
        }}
        onPointerLeave={leave}
        onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) show(); }}
        onBlur={(event) => { if (!pinned.current || event.relatedTarget) close(); }}
        onClick={() => {
          if (pinned.current) close();
          else { pinned.current = true; show(); }
        }}>
        <CircleHelp size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </Popover.Anchor>
    <Popover.Portal>
      <Popover.Content id={id} role="tooltip" className="help-tip" side={side} sideOffset={6} collisionPadding={12}
        onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => { if (button.current?.contains(event.target)) event.preventDefault(); }}
        onPointerEnter={() => window.clearTimeout(timer.current)} onPointerLeave={leave}>
        <strong>{label}</strong>
        <p id={`${id}-description`}>{text}</p>
        <Popover.Arrow className="help-arrow" />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

export function HelpTitle({ as: Heading = 'h2', label, text, children, ...headingProps }) {
  return <div className="help-heading">
    <Heading {...headingProps}>{children ?? label}</Heading>
    <Help label={label} text={text} />
  </div>;
}

export function WithHelp({ label, text, children, className = '', side }) {
  return <span className={`help-inline ${className}`.trim()}>
    {children ?? <span>{label}</span>}<Help label={label} text={text} side={side} />
  </span>;
}

export function HelpField({ label, text, children, className = '' }) {
  const generatedId = useId();
  const id = children.props.id || generatedId;
  return <div className={`help-field ${className}`.trim()}>
    <WithHelp label={label} text={text}><label htmlFor={id}>{label}</label></WithHelp>
    {cloneElement(children, { id })}
  </div>;
}

export function HelpDetails({ label, text, summary, summaryProps, wrapperClassName = '', children, ...detailsProps }) {
  return <div className={`help-disclosure ${wrapperClassName}`.trim()}>
    <details {...detailsProps}>
      <summary {...summaryProps}>{summary ?? label}</summary>
      {children}
    </details>
    <Help label={label} text={text} />
  </div>;
}
