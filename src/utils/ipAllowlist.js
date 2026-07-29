/**
 * IP Allowlist Utility
 *
 * Checks whether a client IP address is permitted by an allowlist of IPs and CIDR ranges.
 * Supports IPv4, IPv6, and CIDR notation (e.g. 192.168.1.0/24, 2001:db8::/32).
 *
 * Security note: `clientIp` must be sourced from a trusted location (e.g. req.ip with
 * Express `trust proxy` configured correctly). Do NOT use X-Forwarded-For directly
 * without proxy trust configuration, as it can be spoofed.
 */

const { isIPv4, isIPv6 } = require('net');

/**
 * Normalize an IP address to a canonical form for comparison.
 *
 * Node's networking stack, dual-stack sockets, and various proxies may represent
 * an IPv4 address as an IPv4-mapped IPv6 address (e.g. "::ffff:1.2.3.4").  Both
 * forms refer to the same underlying address.  Without normalization, string or
 * CIDR comparisons against a plain-IPv4 allowlist entry would incorrectly fail
 * for the mapped form, causing legitimate callers to be denied.
 *
 * This function strips the "::ffff:" prefix so that "::ffff:1.2.3.4" and
 * "::FFFF:1.2.3.4" are both reduced to "1.2.3.4" before any comparison.
 *
 * @param {string} ip - Raw IP string (IPv4 or IPv6, possibly IPv4-mapped)
 * @returns {string} Canonical IP string
 */
function normalizeIp(ip) {
  if (!ip) return ip;
  // Match ::ffff: prefix (case-insensitive) followed by an IPv4 address
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  return ip;
}

/**
 * Converts an IPv4 address string to a 32-bit unsigned integer.
 * @param {string} ip - IPv4 address (e.g. "192.168.1.1")
 * @returns {number}
 */
function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) | parseInt(octet, 10), 0) >>> 0;
}

/**
 * Converts an IPv6 address string to a BigInt for numeric comparison.
 * Handles compressed notation (::) by expanding it first.
 * @param {string} ip - Full or compressed IPv6 address
 * @returns {BigInt}
 */
function ipv6ToBigInt(ip) {
  // Expand :: shorthand
  const halves = ip.split('::');
  let left = halves[0] ? halves[0].split(':') : [];
  let right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  const middle = Array(missing).fill('0');
  const groups = [...left, ...middle, ...right];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || '0', 16)), 0n);
}

/**
 * Checks whether `clientIp` falls within the given CIDR range.
 * Both `clientIp` and the network address of the CIDR are normalized before
 * comparison so that IPv4-mapped IPv6 addresses match plain-IPv4 CIDR entries.
 * @param {string} clientIp
 * @param {string} cidr - e.g. "10.0.0.0/8" or "2001:db8::/32"
 * @returns {boolean}
 */
function isInCidr(clientIp, cidr) {
  const [network, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);

  const normClient  = normalizeIp(clientIp);
  const normNetwork = normalizeIp(network);

  if (isIPv4(normNetwork) && isIPv4(normClient)) {
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ipv4ToInt(normClient) & mask) === (ipv4ToInt(normNetwork) & mask);
  }

  if (isIPv6(normNetwork) && isIPv6(normClient)) {
    const mask = prefix === 0 ? 0n : (~0n << BigInt(128 - prefix)) & ((1n << 128n) - 1n);
    return (ipv6ToBigInt(normClient) & mask) === (ipv6ToBigInt(normNetwork) & mask);
  }

  return false;
}

/**
 * Determines whether `clientIp` is permitted by the given allowlist.
 *
 * Each entry in `allowedIps` may be:
 *   - An exact IPv4 address: "1.2.3.4"
 *   - An exact IPv6 address: "2001:db8::1"
 *   - A CIDR range:          "10.0.0.0/8" or "2001:db8::/32"
 *
 * Returns `true` (allow all) when `allowedIps` is null, undefined, or empty.
 *
 * IPv4-mapped IPv6 addresses (e.g. "::ffff:1.2.3.4") are normalized to their
 * plain IPv4 form before any comparison so that a dual-stack socket or proxy
 * reporting the mapped form still matches a plain-IPv4 allowlist entry.
 *
 * @param {string} clientIp - The client's IP address
 * @param {string[]|null|undefined} allowedIps - The allowlist configured on the API key
 * @returns {boolean}
 */
function isIpAllowed(clientIp, allowedIps) {
  if (!allowedIps || allowedIps.length === 0) return true;
  if (!clientIp) return false;

  const normClient = normalizeIp(clientIp);

  for (const entry of allowedIps) {
    const normEntry = normalizeIp(entry.includes('/') ? entry.split('/')[0] : entry);

    if (entry.includes('/')) {
      // Re-assemble CIDR with normalized network address for isInCidr
      const prefix = entry.split('/')[1];
      if (isInCidr(normClient, `${normEntry}/${prefix}`)) return true;
    } else if (normEntry === normClient) {
      return true;
    }
  }

  return false;
}

module.exports = { isIpAllowed, isInCidr };
