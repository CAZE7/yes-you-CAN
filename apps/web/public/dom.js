/**
 * Shared DOM helpers of the workbench front end (AGENTS 16).
 *
 * `app.js`, `graphs.js` and `vehicle.js` each carried their own copy of `$`,
 * `el` and the error-message helper — three identical implementations, none of
 * them typed. They live here once, with JSDoc types, so the frontend passes the
 * `checkJs` gate with `noImplicitAny` on (E19) and a change to the helpers can
 * no longer drift between the views.
 *
 * The module stays dependency-free and is served like every other static asset
 * under `public/` (ADR 0012 — containment by path segment, not by string).
 */

/**
 * The first element matching `selector`, or `null` when the page does not have
 * it. Callers use `if (!node) return;` — the panels are optional, because the
 * same modules decorate pages that do not contain every panel.
 *
 * @param {string} selector
 * @returns {HTMLElement | null}
 */
export const $ = (selector) => /** @type {HTMLElement | null} */ (document.querySelector(selector));

/**
 * Create an element.
 *
 * `attrs` accepts three spellings the views rely on: `class` (assigned as
 * `className`), `text` (assigned as `textContent`, so user data is never parsed
 * as markup) and any `on*` key, which becomes a listener without the `on`
 * prefix. Everything else is set as an attribute.
 *
 * @param {string} tag
 * @param {Record<string, string | ((event: Event) => void)>} [attrs]
 * @param {Array<string | Node | null | undefined> | string | Node} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = /** @type {string} */ (value);
    else if (key === "text") node.textContent = /** @type {string} */ (value);
    else if (key.startsWith("on"))
      node.addEventListener(key.slice(2), /** @type {EventListener} */ (value));
    else node.setAttribute(key, /** @type {string} */ (value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child == null) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/**
 * A table row. `mono` lists the column indices rendered in the monospace class —
 * raw addresses and hex belong there, decoded text does not (AGENTS 18).
 *
 * @param {ReadonlyArray<string | number | null | undefined>} cells
 * @param {ReadonlyArray<number>} [mono]
 * @returns {HTMLTableRowElement}
 */
export function row(cells, mono = []) {
  const tr = /** @type {HTMLTableRowElement} */ (el("tr"));
  cells.forEach((value, index) => {
    tr.append(
      el("td", {
        class: mono.includes(index) ? "mono" : "",
        text: value == null ? "—" : String(value),
      }),
    );
  });
  return tr;
}

/**
 * Replace the contents of `target` with a label/value table.
 *
 * @param {string} target CSS selector of the host element
 * @param {Iterable<[string, string | number | null | undefined]>} entries
 * @returns {void}
 */
export function kv(target, entries) {
  const node = $(target);
  if (!node) return;
  node.replaceChildren();
  for (const [label, value] of entries) {
    node.append(row([label, value == null ? "—" : String(value)]));
  }
}

/**
 * Message of an unknown `catch` binding (rule 34.25 — never swallow silently,
 * and never print `[object Object]`).
 *
 * @param {unknown} error
 * @returns {string}
 */
export const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Wire a listener to a selector, if the element exists.
 *
 * @param {string} selector
 * @param {string} event
 * @param {EventListener} handler
 * @returns {HTMLElement | null} the element that was wired (for callers that
 *   need to read or write it afterwards)
 */
export function on(selector, event, handler) {
  const node = $(selector);
  node?.addEventListener(event, handler);
  return node;
}

/**
 * Like `$`, but for elements the module's own markup guarantees.
 *
 * A missing element means the markup and the script drifted apart. Today the
 * code would throw a `TypeError` on the next property access anyway (that is
 * what `$("#x").textContent = …` does when `#x` is gone); this throws one
 * sentence that names the selector instead. It is a programming error in the
 * page, not a user situation — the workbench is served from the same repository
 * as its `index.html` (ADR 0009).
 *
 * @param {string} selector
 * @returns {HTMLElement}
 */
export function must(selector) {
  const node = $(selector);
  if (!node) throw new Error(`Markup und Frontend passen nicht zusammen: "${selector}" fehlt`);
  return node;
}

/**
 * @template {keyof HTMLElementTagNameMap} T
 * @param {string} selector
 * @param {T} tag expected tag name
 * @returns {HTMLElementTagNameMap[T]}
 */
function mustByTag(selector, tag) {
  const node = must(selector);
  if (node.tagName.toLowerCase() !== tag) {
    throw new Error(`"${selector}" ist ein <${node.tagName.toLowerCase()}>, erwartet war <${tag}>`);
  }
  return /** @type {HTMLElementTagNameMap[T]} */ (node);
}

/** @param {string} selector @returns {HTMLInputElement} */
export const input = (selector) => mustByTag(selector, "input");
/** @param {string} selector @returns {HTMLSelectElement} */
export const select = (selector) => mustByTag(selector, "select");
/** @param {string} selector @returns {HTMLButtonElement} */
export const button = (selector) => mustByTag(selector, "button");

/**
 * A descendant that must exist — for elements this module created itself a few
 * lines earlier (live cards), where a missing node means a programming error.
 *
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {HTMLElement}
 */
export function child(root, selector) {
  const node = root.querySelector(selector);
  if (!node) throw new Error(`"${selector}" fehlt im gerenderten Knoten`);
  return /** @type {HTMLElement} */ (node);
}
