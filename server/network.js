/**
 * Which network an address belongs to.
 *
 * Hosted on the internet, every device in a home shares one public address because the NAT
 * gives them one, so the address itself groups exactly the right people. Hosted *inside* a
 * network, such as a box on the shelf or a laptop serving to a phone, that stops being true:
 * each device arrives from its own private address, every label is different, and local
 * discovery silently finds nobody. That is the one deployment where finding the device in
 * the next room matters most.
 *
 * So a private address is grouped by its subnet rather than by the host. A /24 for IPv4 and
 * a /64 for IPv6 is what "the same network" means in practice, and both are ranges the
 * devices can already reach each other across directly. A public IPv4 address is left alone,
 * because the NAT in front of it has already done the grouping.
 *
 * A public IPv6 address is not left alone, and that is the one that is easy to get wrong.
 * IPv6 has no NAT: the ISP delegates a prefix, every device takes its own global /128 inside
 * a /64, and privacy extensions rotate that /128 every few hours. Treated as hosts, two
 * phones in one room are two networks, and a device stops matching itself when its address
 * rotates. A /64 is what gets delegated per LAN, so it is the IPv6 spelling of "behind one
 * NAT", and it is what every IPv6 address groups by here.
 *
 * The result is only ever used as the input to an HMAC under a secret that is re-rolled
 * every six hours; the address itself is used and discarded in the same expression.
 */
/** The network an address belongs to: a subnet when it is private, the host otherwise. */
export function networkOf(raw, selfNetwork = null) {
  const addr = String(raw).replace(/^::ffff:/i, '');

  /*
   * A socket from the machine the relay is running on.
   *
   * When that machine is someone's own computer or a box on their shelf, which is the point
   * of being self-hostable, it is on the same network as the phone in their
   * hand, and a browser opened on it should find that phone. Treating loopback as its own
   * island meant the one device guaranteed to be on the network was the one device that
   * could never see anything on it.
   *
   * So it is folded into the machine's own subnet where there is one. On a hosted relay
   * nobody browses from the server, so this groups nothing that was not already alone.
   */
  if (addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.')) {
    return selfNetwork || 'loopback';
  }

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(addr);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const private4 =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127);
    return private4 ? `${v4[1]}.${v4[2]}.${v4[3]}.0/24` : addr;
  }

  if (addr.includes(':')) {
    const lower = addr.toLowerCase();
    /*
     * Every IPv6 address groups by its /64, global ones included.
     *
     * Unique-local and link-local are the obvious cases, and are the same situation as a
     * private IPv4 range. A global address is the case that matters most and used to be
     * excluded: with no NAT to group them, each device in a home has its own /128 and the
     * whole feature found nobody. The /64 is the link they share.
     *
     * Splitting the written form does not work: `fe80::1` and `fe80::2` are the same /64 but
     * have different pieces once you cut on colons, so they would land in different groups
     * and never see each other. Expand first, then take the network half.
     */
    const full = expandV6(lower);
    return full ? full.slice(0, 4).join(':') + '::/64' : lower;
  }

  return addr;
}

/** The eight hextets of an IPv6 address, with `::` filled in. Null if it will not parse. */
function expandV6(addr) {
  const zone = addr.indexOf('%'); // fe80::1%eth0
  const bare = zone === -1 ? addr : addr.slice(0, zone);
  const halves = bare.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && head.length !== 8) return null;

  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const parts = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  return parts.map((h) => String(parseInt(h || '0', 16) || 0));
}

/**
 * The subnet this machine is actually on.
 *
 * Walking the interface list and taking the first private address is wrong on any machine
 * with virtualisation installed: Hyper-V, WSL, Docker and VPN clients all add adapters with
 * private addresses, and one of those wins the race. On this machine the first answer was a
 * virtual switch on 172.19.128.0/24 while the real network was 192.168.1.0/24, so the
 * relay would have grouped the host with nothing at all.
 *
 * Asking which address the kernel would use to reach the internet picks the one the phone
 * in the next room is also behind. `connect` on a UDP socket sends no packets; it only
 * fixes the route, and the address is unroutable on purpose.
 */
export function ownNetwork(interfaces, primary = null) {
  if (primary) {
    const net = networkOf(primary);
    if (net.endsWith('/24')) return net;
  }
  for (const addrs of Object.values(interfaces || {})) {
    for (const a of addrs || []) {
      const family = a.family === 4 || a.family === 'IPv4';
      if (!family || a.internal) continue;
      const net = networkOf(a.address);
      if (net.endsWith('/24')) return net;
    }
  }
  return null;
}

/**
 * The local address the kernel would use to reach the wider network, or null.
 *
 * Async because binding a socket is: reading `address()` before the bind completes throws,
 * and closing an unbound socket leaves a handle that keeps the process alive. Resolved once
 * at startup, never on a request path.
 */
export function primaryAddress(dgram, timeoutMs = 400) {
  return new Promise((resolve) => {
    let sock;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try {
        sock?.close();
      } catch {
        /* never bound */
      }
      resolve(value && value !== '0.0.0.0' ? value : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    try {
      sock = dgram.createSocket('udp4');
      sock.on('error', () => finish(null));
      // TEST-NET-3: reserved for documentation, routed nowhere, contacted never. `connect`
      // on a UDP socket sends nothing; it only asks the kernel which route it would take.
      sock.connect(9, '203.0.113.1', () => {
        clearTimeout(timer);
        let addr = null;
        try {
          addr = sock.address()?.address || null;
        } catch {
          /* fall through to null */
        }
        finish(addr);
      });
    } catch {
      finish(null);
    }
  });
}
