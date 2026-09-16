# Vendored libraries

Four libraries are copied in here rather than fetched at run time, so the page loads
everything it executes from its own origin. That removes a third party from the trust chain
of an app whose whole claim is that nothing but this origin has to be trusted — a CDN that
serves the crypto is a CDN that can change the crypto.

It replaces that risk with a different one: a copied file is a file somebody can edit, and a
one-character change to a curve or a KDF is invisible in review and fatal in use. So the
copies are checked. `test/supply-chain.test.js` compares every vendored `.js` file against the
package npm published, byte for byte, ignoring only the import specifiers that the vendoring
step rewrites, and `test/heic-vendor.test.js` does the same for the decoder.

| | version | licence | why it is here |
|---|---|---|---|
| [`@noble/curves`](https://github.com/paulmillr/noble-curves) | see `package.json` | [MIT](@noble/curves/LICENSE) | ristretto255, for the CPace handshake |
| [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) | see `package.json` | [MIT](@noble/hashes/LICENSE) | SHA-2, SHA-3, HMAC, HKDF, scrypt |
| [`@noble/post-quantum`](https://github.com/paulmillr/noble-post-quantum) | see `package.json` | [MIT](@noble/post-quantum/LICENSE) | ML-KEM-768, the lattice half of the handshake |
| [`libheif`](https://github.com/strukturag/libheif) (via [`libheif-js`](https://github.com/catdad-experiments/libheif-js)) | see `package.json` | [LGPL-3.0](libheif/LICENSE) | showing a photo an iPhone took on a browser that cannot decode one |

The exact versions are recorded in `package.json` as devDependencies, and a test asserts the
vendored copies match what is installed — so "which version is this?" has an answer that is
checked rather than remembered.

## About libheif

It is the one library here that is not MIT, and it is three megabytes, so it is treated
differently from the rest. It is never part of the app shell and is never precached: it is
fetched the first time somebody actually holds a HEIC file, and only then. People who do not
own an iPhone never download it at all.

LGPL-3.0 and this project's AGPL-3.0 are compatible, and the licence text travels with the
copy, which is what the LGPL asks for. It is used unmodified, through its published API, and
`web/core/heic-worker.js` is the only file that loads it.
