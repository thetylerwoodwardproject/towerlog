// Where to go after logging in (?next=…): only a path on this site. Used by the
// login page on the server and again in the browser.

/** `next` if it is a local path, else '/'. */
export function safeNext(next: string | null | undefined): string {
  const s = String(next ?? '');
  // "//host" and "/\host" (browsers read "\" as "/") leave the site, and browsers
  // drop tabs/newlines first, so "/\t/host" does too: refuse all of those.
  if (!s.startsWith('/') || s.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(s)) return '/';
  return s;
}
