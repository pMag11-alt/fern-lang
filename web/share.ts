/**
 * Share links keep the whole program in the URL fragment (`#code=...`) as base64url-encoded UTF-8. The fragment is
 * never sent to a server, so sharing needs no backend.
 */
export function encodeShare(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The program in a `#code=...` fragment, or null if there is none or it is damaged. */
export function decodeShare(hash: string): string | null {
  const match = /^#?code=([A-Za-z0-9_-]*)$/.exec(hash);
  if (!match) return null;
  try {
    const binary = atob(match[1]!.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
