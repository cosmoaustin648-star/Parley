/**
 * Chat Markdown → React elements. Never uses innerHTML, so message content can't inject markup.
 * Supports: **bold**, *italic*, _italic_, __underline__, ~~strike~~, ||spoiler||, `code`, ```blocks```,
 * > quotes, # headings, - / 1. lists, links, [masked](https://links), <@user>, <@&role>, <#channel>, @everyone.
 */
import { useState, type ReactNode } from 'react';
import { getState, openModal, displayName } from './store.ts';
import { navigate } from './router.ts';

interface Ctx { serverId: string | null; keyPrefix: string; n: number }

function Spoiler({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="spoiler" data-open={open} role="button" tabIndex={0} aria-label={open ? undefined : 'Spoiler, press to reveal'}
      onClick={(e: MouseEvent) => { e.stopPropagation(); setOpen(true); }}
      onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') setOpen(true); }}>
      {children}
    </span>
  );
}

function UserMention({ id, serverId }: { id: string; serverId: string | null }) {
  const u = getState().users[id];
  return (
    <span className="mention" role="button" tabIndex={0} onClick={(e: MouseEvent) => { e.stopPropagation(); openModal({ kind: 'profile', userId: id, serverId }); }}>
      @{u ? displayName(u, serverId) : 'unknown-user'}
    </span>
  );
}
function RoleMention({ id, serverId }: { id: string; serverId: string | null }) {
  const role = serverId ? getState().servers[serverId]?.roles.find((r) => r.id === id) : undefined;
  const c = role?.color;
  return <span className="mention" style={c ? { color: c, background: `${c}26` } : undefined}>@{role?.name ?? 'deleted-role'}</span>;
}
function ChannelMention({ id }: { id: string }) {
  const ch = getState().channels[id];
  return (
    <span className="mention" role="button" tabIndex={0} onClick={(e: MouseEvent) => { e.stopPropagation(); if (ch?.server_id) navigate(`/channels/${ch.server_id}/${ch.type === 'thread' ? ch.parent_channel_id : ch.id}`); }}>
      #{ch?.name ?? 'unknown-channel'}
    </span>
  );
}

const SAFE_URL = /^https?:\/\//i;
function Link({ href, children }: { href: string; children: ReactNode }) {
  if (!SAFE_URL.test(href)) return <>{children}</>;
  // Same-origin invite links stay in-app.
  const invite = href.match(/^https?:\/\/[^/]+\/invite\/([A-Za-z0-9]+)$/);
  if (invite && new URL(href).host === location.host) {
    return <a href={href} onClick={(e: MouseEvent) => { e.preventDefault(); navigate(`/invite/${invite[1]}`); }}>{children}</a>;
  }
  return <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc" title={href}>{children}</a>;
}

type Rule = { re: RegExp; render: (m: RegExpExecArray, ctx: Ctx) => ReactNode };
const k = (ctx: Ctx) => `${ctx.keyPrefix}-${ctx.n++}`;

const RULES: Rule[] = [
  { re: /^\\([\\*_~`|<>#[\]()@-])/, render: (m) => m[1] },
  { re: /^(`+)([\s\S]*?[^`])\1(?!`)/, render: (m, c) => <code key={k(c)}>{m[2].trim() || m[2]}</code> },
  { re: /^<@!?(\d{1,19})>/, render: (m, c) => <UserMention key={k(c)} id={m[1]} serverId={c.serverId} /> },
  { re: /^<@&(\d{1,19})>/, render: (m, c) => <RoleMention key={k(c)} id={m[1]} serverId={c.serverId} /> },
  { re: /^<#(\d{1,19})>/, render: (m, c) => <ChannelMention key={k(c)} id={m[1]} /> },
  { re: /^@(everyone|here)\b/, render: (m, c) => <span key={k(c)} className="mention">@{m[1]}</span> },
  { re: /^\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]{1,2000})\)/, render: (m, c) => <Link key={k(c)} href={m[2]}>{inline(m[1], c)}</Link> },
  { re: /^<(https?:\/\/[^\s>]{1,2000})>/, render: (m, c) => <Link key={k(c)} href={m[1]}>{m[1]}</Link> },
  { re: /^https?:\/\/[^\s<]{1,2000}[^\s<.,:;"')\]!?*_~|]/, render: (m, c) => <Link key={k(c)} href={m[0]}>{m[0]}</Link> },
  { re: /^\*\*([\s\S]+?)\*\*(?!\*)/, render: (m, c) => <strong key={k(c)}>{inline(m[1], c)}</strong> },
  { re: /^__([\s\S]+?)__(?!_)/, render: (m, c) => <u key={k(c)}>{inline(m[1], c)}</u> },
  { re: /^\*(?=\S)([\s\S]*?\S)\*(?!\*)/, render: (m, c) => <em key={k(c)}>{inline(m[1], c)}</em> },
  { re: /^_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}_])/u, render: (m, c) => <em key={k(c)}>{inline(m[1], c)}</em> },
  { re: /^~~([\s\S]+?)~~/, render: (m, c) => <s key={k(c)}>{inline(m[1], c)}</s> },
  { re: /^\|\|([\s\S]+?)\|\|/, render: (m, c) => <Spoiler key={k(c)}>{inline(m[1], c)}</Spoiler> },
];
const SPECIAL = /[\\`<@[h*_~|]/;

export function inline(text: string, ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  // Treat a word-internal underscore/asterisk as literal (snake_case, 2*3*4).
  while (i < text.length) {
    const rest = text.slice(i);
    const idx = rest.search(SPECIAL);
    if (idx === -1) { buf += rest; break; }
    if (idx > 0) { buf += rest.slice(0, idx); i += idx; continue; }
    const prev = text[i - 1];
    let matched = false;
    if (!((rest[0] === '_' || rest[0] === 'h') && prev && /[\p{L}\p{N}]/u.test(prev))) {
      for (const r of RULES) {
        const m = r.re.exec(rest);
        if (m) {
          if (buf) { out.push(buf); buf = ''; }
          out.push(r.render(m, ctx));
          i += m[0].length;
          matched = true;
          break;
        }
      }
    }
    if (!matched) { buf += rest[0]; i++; }
  }
  if (buf) out.push(buf);
  return out;
}

/* ───────────── tiny code highlighter ───────────── */
const KW = /\b(const|let|var|function|return|if|else|for|while|do|break|continue|class|extends|new|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|switch|case|def|self|elif|lambda|pass|fn|pub|impl|struct|enum|match|use|mod|package|func|type|interface|public|private|protected|static|void|int|string|bool|true|false|null|None|True|False|nil|undefined|this|select|from|where|insert|update|delete|create|table|and|or|not)\b/;
function highlight(code: string, ctx: Ctx): ReactNode[] {
  if (code.length > 20000) return [code];
  const out: ReactNode[] = [];
  const re = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    if (m[1]) out.push(<span key={k(ctx)} className="hl-com">{m[1]}</span>);
    else if (m[2]) out.push(<span key={k(ctx)} className="hl-str">{m[2]}</span>);
    else if (m[3]) out.push(<span key={k(ctx)} className="hl-num">{m[3]}</span>);
    else if (m[4] && KW.test(m[4]) && m[4].length === (KW.exec(m[4])?.[0].length ?? -1)) out.push(<span key={k(ctx)} className="hl-kw">{m[4]}</span>);
    else out.push(m[0]);
    last = re.lastIndex;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

/* ───────────── blocks ───────────── */
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;

export function renderMarkdown(content: string, serverId: string | null, keyPrefix = 'md'): { nodes: ReactNode[]; emojiOnly: boolean } {
  const ctx: Ctx = { serverId, keyPrefix, n: 0 };
  const trimmed = content.trim();
  const emojiOnly = trimmed.length > 0 && trimmed.length <= 32 && EMOJI_ONLY.test(trimmed) && !/^\d+$/.test(trimmed);
  const lines = content.split('\n');
  const nodes: ReactNode[] = [];
  let para: string[] = [];
  const flush = () => {
    if (!para.length) return;
    nodes.push(<span key={k(ctx)}>{inline(para.join('\n'), ctx)}</span>);
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```([\w+#.-]*)\s*(.*)$/);
    if (fence) {
      const single = line.match(/^```([\s\S]+?)```\s*$/);
      if (single && line.length > 6) {
        flush();
        nodes.push(<pre key={k(ctx)}><code>{highlight(single[1].trim(), ctx)}</code></pre>);
        i++;
        continue;
      }
      const close = lines.findIndex((l, j) => j > i && l.trimEnd().endsWith('```'));
      if (close !== -1) {
        flush();
        const body = [fence[2], ...lines.slice(i + 1, close), lines[close].replace(/```\s*$/, '')].filter((x, idx, arr) => !(x === '' && (idx === 0 || idx === arr.length - 1))).join('\n');
        nodes.push(<pre key={k(ctx)} data-lang={fence[1] || undefined}><code>{highlight(body, ctx)}</code></pre>);
        i = close + 1;
        continue;
      }
    }
    if (/^>>> /.test(line)) {
      flush();
      const body = [line.slice(4), ...lines.slice(i + 1)].join('\n');
      nodes.push(<blockquote key={k(ctx)}>{inline(body, ctx)}</blockquote>);
      break;
    }
    if (/^> /.test(line) || line === '>') {
      flush();
      const q: string[] = [];
      while (i < lines.length && (/^> /.test(lines[i]) || lines[i] === '>')) { q.push(lines[i].slice(2)); i++; }
      nodes.push(<blockquote key={k(ctx)}>{inline(q.join('\n'), ctx)}</blockquote>);
      continue;
    }
    const h = line.match(/^(#{1,3}) (.+)$/);
    if (h) {
      flush();
      const Tag = (`h${h[1].length}`) as 'h1';
      nodes.push(<Tag key={k(ctx)}>{inline(h[2], ctx)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d{1,3}\.) \S/.test(line)) {
      flush();
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\s*\d{1,3}\. \S/ : /^\s*[-*] \S/).test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*]|\d{1,3}\.) /, '')); i++;
      }
      const List = ordered ? 'ol' : 'ul';
      nodes.push(<List key={k(ctx)}>{items.map((it) => <li key={k(ctx)}>{inline(it, ctx)}</li>)}</List>);
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return { nodes, emojiOnly };
}

export function Markdown({ content, serverId }: { content: string; serverId: string | null }) {
  const { nodes, emojiOnly } = renderMarkdown(content, serverId);
  return <div className={`msg ${emojiOnly ? 'emoji-only' : ''}`}>{nodes}</div>;
}
