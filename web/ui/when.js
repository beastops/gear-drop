/**
 * How a conversation is laid out in time: which messages run together, where a time line goes,
 * and how that time line reads.
 *
 * The way Messages does it. Messages sent by the same side close together stack as one run, and
 * only the last of a run carries a tail. A centred time line opens the conversation and returns
 * wherever it picks up after a quiet hour, and it reads the way a person would say it: "Today
 * 2:40 PM", "Yesterday 9:05 AM", the day of the week inside the last week, a date before that.
 *
 * Pure, so it can be tested without a page.
 */

/** Messages from one side this close together are one run. */
export const GROUP_MS = 2 * 60 * 1000;
/** A quiet hour, and the conversation gets a time line where it picks up. */
export const STAMP_MS = 60 * 60 * 1000;

/**
 * For each message: `stamp`, a time line goes above it; `first` and `last`, where it sits in its
 * run. A time line always ends a run.
 */
export function layoutOf(messages) {
  const out = messages.map((m, i) => {
    const prev = messages[i - 1];
    return { stamp: !prev || m.at - prev.at > STAMP_MS };
  });
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const joinsPrev = prev && !out[i].stamp && prev.dir === m.dir && m.at - prev.at <= GROUP_MS;
    const joinsNext = next && !out[i + 1].stamp && next.dir === m.dir && next.at - m.at <= GROUP_MS;
    out[i].first = !joinsPrev;
    out[i].last = !joinsNext;
  });
  return out;
}

const startOfDay = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** A time line's words. `today` and `yesterday` come from the page, in its language. */
export function stampOf(at, { now = Date.now(), locale = undefined, today = 'Today', yesterday = 'Yesterday' } = {}) {
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(at);
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000);
  if (days <= 0) return `${today} ${time}`;
  if (days === 1) return `${yesterday} ${time}`;
  if (days < 7) return `${new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(at)} ${time}`;
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  const date = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(at);
  return `${date} ${time}`;
}

/** A monogram: the first letter of the first two words of a name. */
export function initialsOf(name) {
  const words = String(name || '')
    .split(/[\s\-_.]+/)
    .filter(Boolean);
  const letters = words.slice(0, 2).map((w) => [...w][0].toLocaleUpperCase());
  return letters.join('') || '?';
}
