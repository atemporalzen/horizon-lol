# horizon

Minimal DNS-rebinding attack against a single hardcoded target. See [WIKI.md](WIKI.md) for the deep dive.

**New:** LNA Navigation Bypass — DNS rebinding that bypasses Chrome/Firefox Local Network Access using `window.open` + navigation instead of `fetch`. No server binary needed. See [WIKI.md → LNA Navigation Bypass](WIKI.md#lna-navigation-bypass-new-research).

## Quick start

1. **Clone**
   ```sh
   git clone https://github.com/atemporalzen/horizon
   cd horizon
   ```

2. **Install Go**
   ```sh
   wget -q -O - https://git.io/vQhTU | bash -s -- --version 1.26.1
   ```

3. **Disable systemd-resolved** (frees up port 53 for the DNS server)
   ```sh
   sudo systemctl disable --now systemd-resolved.service
   ```

4. **Set a real resolver in `/etc/resolv.conf`**
   ```
   nameserver 8.8.8.8
   ```

5. **Edit `html/amaze.html`** — set `CONFIG.attackHostIPAddress`, `CONFIG.attackHostDomain` (must start with `dynamic.`, e.g. `dynamic.your.domain`), and `CONFIG.targetHostIPAddress` / `targetPath`.

6. **Run**
   ```sh
   ./singularity-server -HTTPServerPort 80
   ```

Then have the victim browser visit `http://rebinder.az2.website/amaze.html`.

## LNA Navigation Bypass (no server needed)

If Chrome's LNA is blocking your `fetch`-based rebinding, use the navigation bypass instead:

1. **Serve `html/lna-bypass.html`** from any HTTP server on your attacker domain.
2. **Set up DNS flipping** — any mechanism that repoints your domain from attacker IP → target IP (e.g. `127.0.0.1`, `192.168.x.x`).
3. **Victim clicks once**, waits ~60s for DNS cache to expire. The page detects the rebind via LNA blocking `fetch`, then reads the target through a navigated popup window.

No Singularity binary, no Origin-Trial tokens, no Go toolchain. See [WIKI.md](WIKI.md#lna-navigation-bypass-new-research) for the full explanation.
