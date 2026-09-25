/**
 * Host rules for the workbench server (CY-01/CY-02).
 *
 * Which paths the `?token=` exchange applies to, which hostnames the Host/Origin
 * validation trusts, and where the sandbox preview host comes from. All three
 * are security-relevant and named here — in their own module, testable without
 * a running server — instead of living inside the request handler where they
 * would be a paragraph no one re-reads.
 */

/**
 * The paths the `?token=` exchange applies to: the workbench documents.
 *
 * The exchange is the Jupyter pattern — the operator opens the page once with
 * the token in the URL and gets an `httpOnly` cookie back. Browsers only do
 * that for documents they navigate to, so the exchange is allowed for `/` (the
 * panel itself) and `.html` pages, and nowhere else: an API route must answer
 * JSON, not a 302, and an asset URL carrying the token only adds places where
 * the token can be written down (proxy logs, Referer headers).
 */
export function isDocumentPath(path: string): boolean {
  return path === "/" || path.endsWith(".html");
}

/**
 * The host the sandbox preview proxy fronts the server as, when running inside
 * one — derived from `E2B_SANDBOX_ID` and the bound port, not trusted by a
 * wildcard on the platform's domain (which would also trust every *other*
 * sandbox's host).
 */
export function sandboxPreviewHost(port: number): string | undefined {
  const sandboxId = process.env.E2B_SANDBOX_ID;
  return sandboxId ? `${port}-${sandboxId}.e2b.app` : undefined;
}

/**
 * The hostnames a browser uses to reach the server, for the Host/Origin
 * validation: an explicit bind host (never a wildcard bind address —
 * `0.0.0.0` used to trust *every* Host header) plus the sandbox preview host.
 * Localhost and private addresses need no entry: the validation accepts them
 * by construction.
 */
export function trustedHosts(bind: string | undefined, previewHost?: string): string[] {
  const hosts: string[] = [];
  if (bind !== undefined && bind !== "0.0.0.0" && bind !== "::") hosts.push(bind);
  if (previewHost) hosts.push(previewHost);
  return hosts;
}
