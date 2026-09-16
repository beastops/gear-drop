/**
 * Short-lived TURN credentials (coturn `use-auth-secret` / RFC 5766 REST API).
 *
 * Static TURN usernames and passwords shipped to every client, as PairDrop's
 * rtc_config.json does, are a standing invitation to relay-theft. These expire.
 */
import crypto from 'node:crypto';

export function iceServers(conf, ttlSeconds = 600) {
  const servers = [];

  for (const url of conf.stunUrls) servers.push({ urls: url });

  if (conf.turnUrls.length && conf.turnSecret) {
    const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
    const username = `${expiry}`;
    const credential = crypto
      .createHmac('sha1', conf.turnSecret)
      .update(username)
      .digest('base64');
    servers.push({ urls: conf.turnUrls, username, credential });
  } else if (conf.turnUrls.length && conf.turnUser) {
    // Static fallback, only if an operator explicitly configured one.
    servers.push({ urls: conf.turnUrls, username: conf.turnUser, credential: conf.turnPass });
  }

  return { iceServers: servers, ttl: ttlSeconds };
}
