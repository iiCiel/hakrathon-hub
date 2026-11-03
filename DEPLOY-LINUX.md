# Host HAkrathon Hub on a Linux server

Needs: Node 22.13+, git, a hostname pointing at the server (HTTPS is needed on phones), ports 80 and 443 open.
Docker is optional: without it Python and JavaScript still run in the browser; C, C++, Java, Bash and judges' repo runs need it.

1. **Node 22:** `node -v` must say v22.13 or higher. If not: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs git`
2. **Get the code:**
   `sudo useradd -r -m -s /usr/sbin/nologin hak; sudo git clone https://github.com/iiCiel/hakrathon-hub /opt/hakrathon-hub; cd /opt/hakrathon-hub; sudo npm ci --omit=dev; sudo mkdir -p /var/lib/hakrathon; sudo chown -R hak /opt/hakrathon-hub /var/lib/hakrathon; sudo chmod 700 /var/lib/hakrathon`
3. **Optional settings:** copy `.env.example` to `.env` (RUNNER=off if no Docker; PUBLIC_URL, GitHub keys if used).
4. **Run it as a service:** `sudo cp deploy/hakrathon.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now hakrathon`
5. **First admin code:** `sudo journalctl -u hakrathon -n 30` shows "register your admin account with access code ADMIN-XXXXXXXX". Open the site and register with it.
6. **HTTPS, pick one:**
   - **Portal's own HTTPS (use this on a campus-only server; Let's Encrypt can't reach it):** put the certificate chain and key in `/etc/hakrathon/tls/` as `fullchain.pem` and `privkey.pem` (`sudo chown -R root:hak /etc/hakrathon/tls; sudo chmod 750 /etc/hakrathon/tls; sudo chmod 640 /etc/hakrathon/tls/*`), then `sudo mkdir -p /etc/systemd/system/hakrathon.service.d && sudo cp deploy/hakrathon-https.conf /etc/systemd/system/hakrathon.service.d/https.conf && sudo systemctl daemon-reload && sudo systemctl restart hakrathon`. It serves 443, redirects 80, and runs as `hak` with only the right to bind low ports. `node scripts/make-cert.js --csr --host YOUR-HOSTNAME` makes a key and a request to send to whoever issues certificates; without `--csr` it makes a self-signed certificate (every browser warns). Undo: delete `https.conf`, `sudo systemctl daemon-reload && sudo systemctl restart hakrathon`.
   - **Caddy (public server with a public hostname):** install Caddy (https://caddyserver.com/docs/install#debian-ubuntu-raspbian), put your hostname in `deploy/Caddyfile`, then `sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy`.

Check: `curl -I https://YOUR-HOSTNAME` returns 200, and `sudo systemctl status hakrathon` says active (running). The startup log prints the certificate's names and expiry date.

Update later: `cd /opt/hakrathon-hub && sudo -u hak git pull && sudo npm ci --omit=dev && sudo systemctl restart hakrathon`.
Backup: copy `/var/lib/hakrathon` (the database and uploads). Never commit it.
Real event: do not use `scripts/demo.js`; start with `server/index.js` as above.

Docker runner (optional): install Docker, `sudo usermod -aG docker hak`, build the runner image: `docker build -t hakrathon-runner:latest runner`, set `RUNNER=docker`, restart.
