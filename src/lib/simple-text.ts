/**
 * Simple formatting for merchant texts (thank-you « Message personnalisé »): paragraphs (blank
 * line), line breaks, **bold** and links — [texte](https://…), mailto: links, or a bare https://
 * address. Parsed into plain data the page renders as React elements: no HTML is ever injected,
 * and only http(s) / mailto addresses become links. Pure.
 */

export type SimpleInline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  // `bold`: a link inside **…** (or with **…** in its label).
  | { kind: "link"; text: string; href: string; bold?: true }
  | { kind: "br" };

const MAX_LABEL = 200;
const MAX_TARGET = 2000;
const TRAILING_PUNCT = /[.,;:!?'"»]+$/;

/** A link target buyers can safely open: an absolute http(s) URL or a mailto: address; else null. */
export function safeHref(raw: string): string | null {
  const v = raw.trim();
  if (/^https?:\/\//i.test(v)) return URL.canParse(v) ? v : null;
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(v)) return v;
  return null;
}

/**
 * End (exclusive) of an address starting at `from`: up to a space, < > or ** (unless `lenient`),
 * with balanced parentheses (a `)` without its `(` ends it). One pass, at most `max` characters.
 */
function addressEnd(line: string, from: number, max: number, lenient = false): number {
  let depth = 0;
  let i = from;
  const stop = Math.min(line.length, from + max);
  for (; i < stop; i++) {
    const c = line[i];
    // ** ends it too: a bold address (**https://…**).
    if (!lenient && (c === " " || c === "\t" || c === "<" || c === ">" || (c === "*" && line[i + 1] === "*"))) break;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    }
  }
  return i;
}

/**
 * [label](target) at `at` (line[at] === "["): its parts and end, or null when it isn't one. A
 * target with spaces or < > is no address (`target: null`): only its label is shown, never the
 * raw markdown (`[x](javascript:alert('a b'))`).
 */
function markdownLink(line: string, at: number): { label: string; target: string | null; end: number } | null {
  const close = line.indexOf("]", at + 1);
  if (close < 0 || close - at - 1 < 1 || close - at - 1 > MAX_LABEL || line[close + 1] !== "(") return null;
  const from = close + 2;
  const label = line.slice(at + 1, close);
  const end = addressEnd(line, from, MAX_TARGET);
  if (end > from && line[end] === ")") return { label, target: line.slice(from, end), end: end + 1 };
  const loose = addressEnd(line, from, MAX_TARGET, true);
  return loose > from && line[loose] === ")" ? { label, target: null, end: loose + 1 } : null;
}

/**
 * One line: a single left-to-right pass (no backtracking regex), so any input parses in
 * near-linear time. **…** toggles bold (only when a closing ** follows), links work inside it.
 */
function inline(line: string): SimpleInline[] {
  const out: SimpleInline[] = [];
  let bold = false;
  const push = (text: string) => {
    if (!text) return;
    const kind = bold ? "bold" : "text";
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  const link = (text: string, href: string, strong: boolean) => out.push(strong ? { kind: "link", text, href, bold: true } : { kind: "link", text, href });
  let buf = "";
  const flush = () => {
    push(buf);
    buf = "";
  };
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "*" && line[i + 1] === "*" && (bold || line.indexOf("**", i + 3) >= 0)) {
      flush();
      bold = !bold;
      i += 2;
      continue;
    }
    if (c === "[") {
      const m = markdownLink(line, i);
      if (m) {
        flush();
        const label = m.label.replace(/\*\*/g, "");
        const href = m.target == null ? null : safeHref(m.target);
        // An unsafe target (javascript:, data:, relative…) keeps only its words.
        if (href && label.trim()) link(label, href, bold || label !== m.label);
        else push(label);
        i = m.end;
        continue;
      }
    }
    if ((c === "h" || c === "H") && /^https?:\/\//i.test(line.slice(i, i + 8))) {
      const end = addressEnd(line, i, MAX_TARGET);
      const raw = line.slice(i, end).replace(TRAILING_PUNCT, "");
      const href = raw.length > raw.indexOf("//") + 2 ? safeHref(raw) : null;
      if (href) {
        flush();
        link(raw, href, bold);
        i += raw.length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Paragraphs of inline pieces; a single line break inside a paragraph is a `br`. */
export function parseSimpleText(text: string): SimpleInline[][] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => p.split("\n").flatMap((line, i) => [...(i > 0 ? [{ kind: "br" } as const] : []), ...inline(line)]));
}

const FIRST_NAME = /\{(?:name|prénom|prenom)\}/gi;

/**
 * A title with {prénom} / {name} replaced by the buyer's first name. Without one, the placeholder
 * goes with the comma or space around it (« Merci, {prénom} ! » → « Merci ! »). Pure.
 */
export function withFirstName(title: string, firstName: string | null | undefined): string {
  const name = (firstName ?? "").trim();
  // A replacer function: a name is inserted as typed (« $& », « $' » are not replacement patterns).
  if (name) return title.replace(FIRST_NAME, () => name).trim();
  const out = title
    .replace(/[ \t]*,?[ \t]*\{(?:name|prénom|prenom)\}/gi, "")
    .replace(/^[\s,]+/, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}
