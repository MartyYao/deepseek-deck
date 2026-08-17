/**
 * Small SemVer helpers used by the shell update checks.
 *
 * DSH is currently published as pre-release versions such as
 * `0.1.0-rc.6`. Comparing only the numeric core makes rc.6 and rc.7 look
 * equal, so pre-release identifiers must participate in the comparison.
 */

/**
 * Parse a SemVer string accepted by the update sources.
 *
 * @param {string} value - Version with an optional leading `v`.
 * @returns {{core: number[], prerelease: Array<string|number>}|null}
 */
export function parseSemver(value) {
  const match = String(value).trim().replace(/^v/, '').match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  );
  if (!match) return null;
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]
      ? match[4].split('.').map((part) => /^\d+$/.test(part) ? Number(part) : part)
      : []
  };
}

/**
 * Compare two SemVer strings, including pre-release identifiers.
 *
 * @param {string} a - Left version.
 * @param {string} b - Right version.
 * @returns {number} 1 when a is newer, -1 when older, otherwise 0.
 * @throws {Error} When either value is not valid SemVer.
 */
export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error(`invalid SemVer: ${String(!pa ? a : b)}`);

  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] > pb.core[i] ? 1 : -1;
  }

  // A stable release is newer than any pre-release of the same core version.
  if (pa.prerelease.length === 0 && pb.prerelease.length !== 0) return 1;
  if (pa.prerelease.length !== 0 && pb.prerelease.length === 0) return -1;

  for (let i = 0; i < Math.max(pa.prerelease.length, pb.prerelease.length); i++) {
    if (i >= pa.prerelease.length) return -1;
    if (i >= pb.prerelease.length) return 1;
    const aPart = pa.prerelease[i];
    const bPart = pb.prerelease[i];
    if (aPart === bPart) continue;
    if (typeof aPart === 'number' && typeof bPart === 'number') return aPart > bPart ? 1 : -1;
    if (typeof aPart === 'number') return -1;
    if (typeof bPart === 'number') return 1;
    return aPart > bPart ? 1 : -1;
  }
  return 0;
}

