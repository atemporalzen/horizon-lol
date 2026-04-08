# horizon

Minimal DNS-rebinding attack against a single hardcoded target. See [WIKI.md](WIKI.md) for the deep dive.

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
