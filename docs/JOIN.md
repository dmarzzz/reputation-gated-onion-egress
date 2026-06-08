# you've been handed a key

Someone added you to a private reputation set. That key lets you browse out through a clean IP on a server in New York, while proving you belong to the set and never telling the server who you are. No login, no account, and none of your own IP ever reaches it.

Here is the whole thing.

## what you need

- node 18 or newer
- tor installed locally (`brew install tor`, or `apt install tor`)
- the bundle you were sent (`rgoe-gateway-deploy.tgz`), unpacked
- your secret: one `export RGOE_SECRET=...` line, sent to you privately

## run it

```bash
cd reputation-gated-onion-egress
npm install
bash scripts/join.sh <your-secret>
```

The gateway address is already built in, so you only need your secret. For the
record, the gateway onion is:

```
ezguggje6sbldhw4pl5nudwg2mrwkb5zzyu3a26qc4eka2ur24bv3eqd.onion
```

(If the operator points you at a different box, pass it ahead of your secret:
`bash scripts/join.sh <other-gateway>.onion <your-secret>`.) Knowing the address
buys nothing on its own. The gate is fail-closed, so without a valid membership
proof every connection is dropped. That command starts a local Tor and a small
proxy, then runs a check. When it prints `PASS` next to
the gateway's IP (`204.48.28.220`), you are out.

## use it

Point anything at the proxy on port 8888:

```bash
curl -x http://127.0.0.1:8888 https://api.ipify.org            # shows the gateway's clean IP
curl -x http://127.0.0.1:8888 "https://www.google.com/search?q=zk+proofs"
```

Your traffic goes: your laptop, into Tor, to a rendezvous point, to the server's hidden service. The server checks your proof and then makes the request from its own clean IP. The server never sees your IP. Google never sees Tor. Your search stays inside TLS the whole way, so the server sees only `www.google.com:443`, never the query.

## what your key actually is

It is a bearer credential. Whoever holds it can browse as a member until the set is rotated, so keep it to yourself. It is not tied to your name anywhere, but it is yours.

You get your own rate budget per day and a tag (a nullifier) that lets the server count your requests without knowing they are yours. Across days that tag changes, so your requests do not link over time.

## stop it

```bash
bash scripts/stop.sh
pkill -f torrc.client
```

Want to see exactly what happens to your bytes? Open `docs/walkthrough.html` in a browser and step through it. Everything in there is the real running system.
