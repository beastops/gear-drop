/**
 * What the relay is allowed to tell the browser to contact.
 *
 * ICE servers come from the relay, since that is who knows a deployment's STUN and TURN.
 * But an ICE server is an instruction to send packets to a host and port: `turn:192.168.1.1:22`
 * is not a connection, it is the browser used as a probe inside a network the relay cannot
 * otherwise reach, timed by how long the attempt takes.
 *
 * So two fields are read and the rest of the object dropped. Spreading it whole handed the
 * relay every other knob `RTCPeerConnection` accepts, now and in future versions. Private
 * addresses and well-known service ports are refused.
 *
 * Not covered: a hostname that resolves to a private address. Resolution happens inside the
 * browser and the result is never visible here, which is one more reason the relay is
 * configurable and asks before it changes.
 */

/** Enough for a STUN server, a TURN server and a couple of spares. */
const MAX_SERVERS = 8;
const MAX_URLS_PER_SERVER = 4;
const MAX_CREDENTIAL = 512;

/** The only schemes an ICE server can legitimately use. */
const SCHEME = /^(stun|stuns|turn|turns):/i;

/**
 * Ports that are unambiguously something else. A self-hosted TURN server may sit on an
 * unusual port, so this is a list of what to refuse rather than a list of what to allow:
 * the aim is to remove the interesting targets, not to dictate how people run their relay.
 */
const CLOSED_PORTS = new Set([
  22, 23, 25, 110, 135, 137, 138, 139, 143, 445, 465, 587, 993, 995, 1433, 1521, 2049, 3306,
  3389, 5432, 5900, 5984, 6379, 9200, 11211, 27017,
]);

/** Addresses that are only reachable from inside somebody's network. */
function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();

  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;

  // IPv4 literal
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  // IPv6 literal
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true;
    if (/^f[cd]/.test(h)) return true; // unique local
    if (/^fe[89ab]/.test(h)) return true; // link-local
    if (/^ff/.test(h)) return true; // multicast
    if (/^::ffff:/.test(h)) return isPrivateHost(h.replace(/^::ffff:/, '')); // mapped v4
    return false;
  }

  return false;
}

/** Split `turn:host:port?transport=udp` into its host and port. */
function hostAndPort(url) {
  const rest = url.slice(url.indexOf(':') + 1).split('?')[0];
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end === -1) return null;
    const port = rest.slice(end + 1).startsWith(':') ? Number(rest.slice(end + 2)) : null;
    return { host: rest.slice(0, end + 1), port };
  }
  const bits = rest.split(':');
  if (bits.length > 2) return null;
  const port = bits.length === 2 ? Number(bits[1]) : null;
  if (bits.length === 2 && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
  return { host: bits[0], port };
}

/** @returns {boolean} whether this is somewhere we are willing to send packets. */
export function isUsableIceUrl(url) {
  if (typeof url !== 'string' || url.length > 256 || !SCHEME.test(url)) return false;
  const parsed = hostAndPort(url);
  if (!parsed || !parsed.host) return false;
  if (isPrivateHost(parsed.host)) return false;
  if (parsed.port !== null && CLOSED_PORTS.has(parsed.port)) return false;
  return true;
}

/**
 * Reduce whatever the relay sent to the part we are prepared to act on.
 *
 * @returns {{iceServers: Array, iceTransportPolicy?: string}} always a usable object;
 *          an empty server list simply means the connection tries without assistance.
 */
export function sanitizeIceConfig(raw) {
  const out = { iceServers: [] };
  if (!raw || typeof raw !== 'object') return out;

  if (raw.iceTransportPolicy === 'relay' || raw.iceTransportPolicy === 'all') {
    out.iceTransportPolicy = raw.iceTransportPolicy;
  }

  const servers = Array.isArray(raw.iceServers) ? raw.iceServers.slice(0, MAX_SERVERS) : [];
  for (const server of servers) {
    if (!server || typeof server !== 'object') continue;

    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
      .filter(isUsableIceUrl)
      .slice(0, MAX_URLS_PER_SERVER);
    if (!urls.length) continue;

    const entry = { urls };
    // Credentials are only meaningful for TURN, and only as short strings.
    if (typeof server.username === 'string' && server.username.length <= MAX_CREDENTIAL) {
      entry.username = server.username;
    }
    if (typeof server.credential === 'string' && server.credential.length <= MAX_CREDENTIAL) {
      entry.credential = server.credential;
    }
    out.iceServers.push(entry);
  }

  return out;
}
