/** Journal helpers: technical error bodies apart from the French summary, and grouping of repeats. */

/** Where a raw upstream error starts: status lines, API prefixes, JSON bodies, JS errors. */
const TECH_START = [
  /\bStatus code:?\s*\d{3}/i,
  /\bBody:\s*/,
  /\b[A-Z][\w.-]* API \d{3}\b/,
  /\bHTTP(?:\/\d(?:\.\d)?)?\s+\d{3}\b/,
  /[{[]\s*"/,
  /\b[A-Z][A-Za-z]*Error\b/,
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|Request failed|Error:)/,
];
/** French sentence that follows the raw error in some messages ("… Nouvel essai automatique dans 5 min."). */
const FRENCH_TAIL = /[.\s]+((?:Nouvel essai automatique|Action manuelle requise|Réessayez|Vérifiez)[^]*)$/;

export type SplitMessage = { summary: string; details: string | null };

export function splitTechnical(message: string): SplitMessage {
  let start = -1;
  for (const re of TECH_START) {
    const m = re.exec(message);
    if (m && (start < 0 || m.index < start)) start = m.index;
  }
  if (start < 0) return { summary: message, details: null };
  let head = message.slice(0, start).replace(/[\s:(\-–—]+$/, "");
  let rest = message.slice(start);
  const tail = FRENCH_TAIL.exec(rest);
  if (tail && tail.index > 0) {
    rest = rest.slice(0, tail.index);
    head = `${head}. ${tail[1]}`.trim();
  }
  if (!head) head = "Erreur technique renvoyée par le service";
  else if (!/[.!?…]$/.test(head)) head += ".";
  return { summary: head, details: rest.trim() };
}

export type Occurrence = { id: string; createdAt: Date; sessionId: string | null };
export type EventGroup<E extends Occurrence & { kind: string; message: string; level: string }> = {
  key: string;
  first: E;
  items: E[];
};

/** Repeats further apart than this start a new row. */
export const GROUP_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Groups identical (level, kind, message) events of a page, newest first. An event joins the
 * group of the same key when it happened within GROUP_WINDOW_MS of that group's oldest item.
 */
export function groupEvents<E extends Occurrence & { kind: string; message: string; level: string }>(events: E[]): EventGroup<E>[] {
  const groups: EventGroup<E>[] = [];
  const open = new Map<string, EventGroup<E>>();
  for (const e of events) {
    const key = `${e.level}\u0000${e.kind}\u0000${e.message}`;
    const g = open.get(key);
    const oldest = g?.items[g.items.length - 1];
    if (g && oldest && oldest.createdAt.getTime() - e.createdAt.getTime() <= GROUP_WINDOW_MS) {
      g.items.push(e);
    } else {
      const ng = { key: `${key}\u0000${e.id}`, first: e, items: [e] };
      groups.push(ng);
      open.set(key, ng);
    }
  }
  return groups;
}
