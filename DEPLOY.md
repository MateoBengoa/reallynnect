# Despliegue completo en Hetzner (sin entorno local)

**¿Primera vez o dudas con proxies y qué pulsar en Hetzner?** Lee primero [`HETZNER-Y-PROXIES.md`](HETZNER-Y-PROXIES.md).

Objetivo: un **VPS Hetzner** con **Redis**, **API + workers** en **PM2**, **HTTPS** con Nginx, **Supabase** en la nube y el **panel** en **Vercel** (recomendado) o en el mismo VPS.

---

## Fase A — Supabase (antes o en paralelo)

1. Crea proyecto en [supabase.com](https://supabase.com).
2. **SQL Editor** → pega y ejecuta las migraciones en orden ([`001_initial_schema.sql`](supabase/migrations/001_initial_schema.sql) y sucesivas `002`…`005` si están en el repo).
3. **Authentication → Providers** → activa **Email** (contraseña).
4. Anota:
   - **Project URL** → `SUPABASE_URL`
   - **service_role** (Settings → API) → `SUPABASE_SERVICE_ROLE_KEY` (solo servidor)
   - **anon** → la usarás en Vercel como `NEXT_PUBLIC_SUPABASE_ANON_KEY`

5. Genera una clave larga aleatoria para `COOKIE_ENCRYPTION_KEY` (32+ caracteres). Guárdala solo en el servidor / gestor de secretos.

---

## Fase B — Servidor Hetzner

### B1. Crear el VPS

1. En [Hetzner Cloud](https://console.hetzner.cloud): **Add Server**.
2. **Image:** Ubuntu 22.04.
3. **Tipo:** CX22 (2 vCPU, 4 GB) o superior si vas a muchas cuentas.
4. **SSH key:** añade tu clave pública (acceso sin contraseña).
5. Crea el servidor y anota la **IP pública**.

### B2. DNS

- Crea un registro **A** para la API, por ejemplo `api.tudominio.com` → IP del VPS.
- (Opcional) Otro registro para el front si no usas el dominio de Vercel.

### B3. Primer acceso y seguridad básica

```bash
ssh root@TU_IP_PUBLICA
apt update && apt upgrade -y
```

Firewall (UFW):

```bash
apt install -y ufw
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

**No abras** el puerto 6379 (Redis) ni el 3001 (Node) a Internet: solo Nginx en 80/443.

### B4. Instalar Redis, Nginx, Certbot, Node

```bash
apt install -y redis-server nginx certbot python3-certbot-nginx

# Redis solo local
sed -i 's/^supervised no/supervised systemd/' /etc/redis/redis.conf
grep -q '^bind 127.0.0.1' /etc/redis/redis.conf || echo 'bind 127.0.0.1' >> /etc/redis/redis.conf
systemctl enable redis-server
systemctl restart redis-server
redis-cli ping
# Debe responder: PONG
```

Node.js 22:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm i -g pm2
```

### B5. Dependencias de sistema para Playwright (Chromium)

```bash
apt install -y \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2 libpango-1.0-0 libcairo2
```

(Si al ejecutar el worker falta alguna librería, Playwright suele indicar el nombre del paquete en el error.)

---

## Fase C — Código en el VPS

### Opción 1 — Git

```bash
cd /opt
git clone TU_REPO_URL linkedin-saas
cd linkedin-saas
npm install
cd automation && npx playwright install chromium && cd ..
npm run build -w automation
npm run build -w backend
```

### Opción 2 — Subir zip desde tu PC

En tu máquina (PowerShell), empaqueta el proyecto (sin `node_modules`) y:

```powershell
scp -r "d:\Nueva carpeta (2)" root@TU_IP:/opt/linkedin-saas
```

En el servidor:

```bash
cd /opt/linkedin-saas
npm install
cd automation && npx playwright install chromium && cd ..
npm run build -w automation
npm run build -w backend
```

---

## Fase D — Variables de entorno en el servidor

```bash
nano /opt/linkedin-saas/backend/.env
```

Contenido mínimo (ajusta valores reales):

```env
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
COOKIE_ENCRYPTION_KEY=tu_clave_larga_secreta_minimo_32_caracteres

REDIS_URL=redis://127.0.0.1:6379

GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash

NODE_ENV=production
PORT=3001
HOST=127.0.0.1
PLAYWRIGHT_HEADLESS=true
```

`HOST=127.0.0.1` hace que Node **solo escuche en localhost** (Nginx es quien expone la API al mundo).

PM2 debe cargar este `.env`. Ajusta [`ecosystem.config.cjs`](ecosystem.config.cjs) para usar `env_file` o duplica las variables en `env`. Lo más simple: usar el módulo `dotenv` ya incluido — los procesos arrancan con `node dist/...` y **no cargan `.env` automáticamente** salvo que el código haga `dotenv/config` (el proyecto ya usa `import "dotenv/config"` en `server.ts` y workers **si** el cwd es `backend` donde está `.env`).

**Importante:** en `ecosystem.config.cjs` pon `cwd: "./backend"` como ya está; al ejecutar `pm2 start` desde la **raíz del repo**, las rutas relativas apuntan bien. Asegúrate de ejecutar PM2 desde `/opt/linkedin-saas` y de que `backend/.env` exista.

---

## Fase E — Nginx + HTTPS

```bash
nano /etc/nginx/sites-available/linkedin-api
```

```nginx
server {
    listen 80;
    server_name api.tudominio.com;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
ln -sf /etc/nginx/sites-available/linkedin-api /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
certbot --nginx -d api.tudominio.com
```

---

## Fase F — PM2 (API + worker + scheduler)

Desde la raíz del repo (`/opt/linkedin-saas`):

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
# Ejecuta el comando que te muestre pm2 startup (systemd)
```

Comprobar:

```bash
pm2 status
pm2 logs li-api --lines 50
curl -s http://127.0.0.1:3001/health
```

Desde fuera (tras DNS y certificado):

```bash
curl -s https://api.tudominio.com/health
```

Debe devolver `{"ok":true}`.

---

## Fase G — Panel (Vercel, recomendado)

1. Cuenta en [vercel.com](https://vercel.com), **New Project** → importa el repo o sube la carpeta `frontend`.
2. **Root Directory:** `frontend`.
3. Variables de entorno:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `NEXT_PUBLIC_API_URL=https://api.tudominio.com` (sin barra final)
4. Deploy.

En **Supabase → Authentication → URL Configuration**, añade la URL de Vercel en **Site URL** y **Redirect URLs** para que el login funcione.

---

## Fase H — Uso operativo en producción

1. Entra al panel (URL de Vercel).
2. Regístrate / inicia sesión.
3. **Proxies:** alta de Webshare (host, puerto, user/pass).
4. **LinkedIn:** pega `li_at`.
5. Arranca **worker** si no está en PM2 (`li-worker`, `li-scheduler`).

Sin **worker**, las tareas no se ejecutan (cola en Redis + filas en Supabase).

---

## Checklist rápido

| Paso | Estado |
|------|--------|
| Migración SQL en Supabase | ☐ |
| Auth email activo + URLs en Supabase | ☐ |
| VPS: Redis `PONG`, bind 127.0.0.1 | ☐ |
| `backend/.env` completo | ☐ |
| `npm run build` automation + backend | ☐ |
| Playwright chromium instalado | ☐ |
| PM2: api + worker + scheduler | ☐ |
| Nginx + TLS, `/health` OK | ☐ |
| Vercel con `NEXT_PUBLIC_API_URL` | ☐ |
| Proxies dados de alta en el panel | ☐ |

---

## Humo local (LinkedIn)

Requiere `LI_AT` y `automation` compilado (`npm run build -w automation`).

| Script | Comando | Variables |
|--------|---------|-----------|
| Invitación / Conectar | `npm run connect-smoke -w automation` | `PROFILE_URL` opcional |
| DM en hilo existente | `npm run message-smoke -w automation` | `THREAD_URL`, `DM_TEXT` opcional |

Detalle en las cabeceras de [`automation/connect-smoke.cjs`](automation/connect-smoke.cjs) y [`automation/message-smoke.cjs`](automation/message-smoke.cjs).

---

## Recursos

- **4 GB RAM:** un solo `li-worker`; el semáforo limita a 4 Chromium.
- **Logs:** `pm2 logs li-worker`
- **Redis no expuesto:** solo cola interna; si necesitas inspeccionar: `redis-cli` en el VPS.
