/**
 * Pure helpers bridging a picked GitHub repository and a workspace link (the
 * repo allow-list entry). Onboarding a repo from the integration dropdown
 * creates a project placeholder + a workspace link via `state.createLink`; these
 * derive its fields, and render a link's repo identity back in the allow-list.
 *
 * Dependency-free so they are unit-testable.
 */

/** The remote URL to link for a picked GitHub repo full name ("owner/repo"). */
export function githubRemoteForFullName(fullName: string): string {
  return `github.com/${fullName}`;
}

/** Owner login from "owner/repo" (empty if malformed). */
export function ownerOf(fullName: string): string {
  return fullName.split("/")[0] ?? "";
}

/** Repo name from "owner/repo" — the project slug source (falls back to input). */
export function repoNameOf(fullName: string): string {
  const parts = fullName.split("/");
  return parts[1] ?? fullName;
}

/**
 * Best-effort "owner/repo" from a workspace link's normalized remote (host is
 * stripped: "github.com/owner/repo" → "owner/repo"). Used to render the
 * allow-list. Returns the input unchanged when it doesn't look host-prefixed.
 */
export function repoFullNameFromRemote(remoteUrl: string): string {
  const cleaned = remoteUrl.replace(/^[a-z]+:\/\//i, "").replace(/\.git$/i, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length >= 3) return parts.slice(-2).join("/");
  return parts.join("/");
}
