/**
 * The only way script can enter this page.
 *
 * Today nothing here builds markup from a string: peer names, file names and messages all
 * reach the DOM through `textContent`, and that has been checked. The problem with "has been
 * checked" is that it describes the code as it is now, and the next change is written by
 * somebody in a hurry. One `innerHTML` with a name in it, once, is a remote peer running
 * code in a page that is holding session keys and file contents.
 *
 * Trusted Types closes that off at the browser rather than at review time. With
 * `require-trusted-types-for 'script'` set, assigning a plain string to `innerHTML`, `eval`,
 * a script `src` or a worker URL throws, because there is no longer a sink to reach. What
 * is this one policy, which mints script URLs and refuses anything that is not a module
 * already shipped from this origin.
 *
 * Browsers without Trusted Types (currently everything outside Chromium) ignore the
 * directive and the strings pass through unchanged. They are no worse off than before; the
 * engines that can enforce it, do.
 */

/** Same-origin, same-directory tree, ending in .js. Nothing else is ours. */
function ours(value) {
  const url = new URL(String(value), location.href);
  if (url.origin !== location.origin) throw new Error(`refusing off-origin script: ${url.origin}`);
  if (!url.pathname.endsWith('.js')) throw new Error(`refusing non-module URL: ${url.pathname}`);
  return url.href;
}

const policy = globalThis.trustedTypes?.createPolicy
  ? globalThis.trustedTypes.createPolicy('gd', {
      createScriptURL: ours,
      // Deliberately absent: createHTML and createScript. There is no legitimate caller for
      // either, so leaving them undefined turns any future attempt into an immediate error
      // rather than something that quietly works.
    })
  : null;

/**
 * A worker or service-worker URL, ready to hand to the constructor.
 *
 * The origin check runs whether or not the browser enforces Trusted Types, so the rule is
 * the same everywhere and a mistake shows up in any engine rather than only in Chrome.
 */
export function scriptURL(value) {
  const href = ours(value);
  return policy ? policy.createScriptURL(href) : href;
}

/** Whether the browser is actually enforcing this. Useful for an honest status line. */
export const trustedTypesActive = () => !!policy;
