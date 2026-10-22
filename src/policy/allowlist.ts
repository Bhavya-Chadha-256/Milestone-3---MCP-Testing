/**
 * Allowlist matching (§12, §14).
 *
 * Domain rules, all case-insensitive:
 *   - "example.com"   matches exactly example.com (NOT sub.example.com).
 *   - "*.example.com" matches any subdomain (sub.example.com, a.b.example.com) but NOT example.com.
 * List both forms to allow a domain and its subdomains. An empty list allows everything.
 */

export function domainMatches(domain: string, entry: string): boolean {
  const d = domain.toLowerCase().replace(/\.$/, "");
  const e = entry.toLowerCase().trim().replace(/\.$/, "");
  if (e.startsWith("*.")) {
    const suffix = e.slice(1); // ".example.com"
    return d.length > suffix.length && d.endsWith(suffix);
  }
  return d === e;
}

export function isDomainAllowed(domain: string, allowlist: readonly string[]): boolean {
  return allowlist.length === 0 || allowlist.some((entry) => domainMatches(domain, entry));
}

/** Addresses whose domain is not allowed, in input order. */
export function blockedRecipients(addresses: readonly string[], allowlist: readonly string[]): string[] {
  if (allowlist.length === 0) return [];
  return addresses.filter((a) => !isDomainAllowed(a.slice(a.lastIndexOf("@") + 1), allowlist));
}

/** Document IDs are case-sensitive, so they are compared exactly. */
export function isDocumentAllowed(documentId: string, allowlist: readonly string[]): boolean {
  return allowlist.length === 0 || allowlist.includes(documentId);
}
