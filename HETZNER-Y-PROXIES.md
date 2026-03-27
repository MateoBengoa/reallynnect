# Hetzner + proxies: qué hacer (orden claro)

## Idea general

1. **Supabase** = base de datos y usuarios del panel (en internet, no en Hetzner).
2. **Hetzner** = tu servidor donde corre **Redis**, la **API**, el **worker** (Playwright) y Nginx.
3. **Proxy** = una “puerta de salida” a internet con **IP fija** (residencial/estática). LinkedIn ve esa IP, no la IP de Hetzner. **Cada cuenta LinkedIn va con un proxy distinto** en esta app.

Sin proxy en el panel, al conectar LinkedIn la API puede decir que **no hay proxy disponible**.

---

## Parte 1 — Conseguir proxies (Webshare u otro)

1. Entra en tu proveedor (ej. **Webshare**) y contrata **proxies estáticos residenciales** (o el producto que te dé host + puerto + usuario + contraseña).
2. En su panel verás algo como:
   - **Host:** `algo.webshare.io` (ejemplo)
   - **Puerto:** un número (ej. `80` o `10000`)
   - **Usuario** y **contraseña** de autenticación del proxy
3. **No** pegues eso en Hetzner. Lo pegarás **después** en el **panel web** de la app (sección Proxies), cuando ya esté desplegada.

Guarda esos datos en un sitio seguro hasta entonces.

---

## Parte 2 — Qué es “Hetzner” y qué haces ahí

Hetzner es solo **alquilar una máquina Linux** y **conectarte por SSH** para instalar programas.

### Paso A — Crear el servidor (pantalla web de Hetzner)

1. Entra en [Hetzner Cloud Console](https://console.hetzner.cloud).
2. **Projects** → tu proyecto → botón **Add Server**.
3. **Location:** el datacenter que quieras (ej. Falkenstein).
4. **Image:** **Ubuntu 22.04**.
5. **Type:** **CX22** (o superior).
6. **SSH keys:** añade tu clave pública (si no tienes, en Windows puedes generar con `ssh-keygen` y pegar el contenido de `id_rsa.pub`).
7. **Create & buy now**.
8. Cuando termine, copia la **IPv4** del servidor (ej. `95.x.x.x`).

### Paso B — Apuntar tu dominio a esa IP (para HTTPS)

En donde tengas el dominio (Cloudflare, Namecheap, etc.):

- Registro **A**: nombre `api` (o el subdominio que quieras) → valor **la IP del servidor**.

Así después podrás usar `https://api.tudominio.com`.

### Paso C — Conectarte al servidor (terminal)

En tu PC (PowerShell o terminal):

```bash
ssh root@LA_IP_QUE_COPIASTE
```

La primera vez te pregunta si confías en el host: escribe `yes`.

Ya estás **dentro** de la máquina de Hetzner. Todo lo siguiente es **copiar y pegar** en esa sesión SSH (salvo donde diga “en tu PC”).

---

## Parte 3 — Comandos en el servidor (una tanda)

Pega bloque a bloque y espera a que termine cada uno.

**Actualizar e instalar lo básico:**

```bash
apt update && apt upgrade -y
apt install -y ufw redis-server nginx certbot python3-certbot-nginx git
```

**Firewall (solo SSH y web):**

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

**Redis y que arranque solo:**

```bash
systemctl enable redis-server
systemctl restart redis-server
redis-cli ping
```

Debe salir `PONG`.

**Node.js 22 y PM2:**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm i -g pm2
```

**Librerías para el navegador automatizado (Chromium):**

```bash
apt install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
  libpango-1.0-0 libcairo2
```

---

## Parte 4 — Poner tu código en el servidor

**Si usas GitHub/GitLab:**

```bash
cd /opt
git clone https://github.com/TU_USUARIO/TU_REPO.git linkedin-saas
cd linkedin-saas
```

**Si no tienes repo:** sube la carpeta del proyecto con **WinSCP** o `scp` a `/opt/linkedin-saas` y en el servidor:

```bash
cd /opt/linkedin-saas
```

**Instalar y compilar:**

```bash
npm install
cd automation && npx playwright install chromium && cd ..
npm run build -w automation
npm run build -w backend
```

---

## Parte 5 — Archivo `backend/.env` en el servidor

```bash
nano /opt/linkedin-saas/backend/.env
```

Pega (con tus valores reales):

```env
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
COOKIE_ENCRYPTION_KEY=una_frase_muy_larga_y_secreta_de_al_menos_32_caracteres

REDIS_URL=redis://127.0.0.1:6379

GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.0-flash

NODE_ENV=production
```

Guardar en nano: `Ctrl+O`, Enter, `Ctrl+X`.

---

## Parte 6 — Nginx (API con tu dominio)

Sustituye `api.tudominio.com` por tu subdominio real.

```bash
nano /etc/nginx/sites-available/linkedin-api
```

Contenido:

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

Activar sitio y recargar:

```bash
ln -sf /etc/nginx/sites-available/linkedin-api /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

Certificado HTTPS (cuando el DNS `api` ya apunte a la IP del servidor):

```bash
certbot --nginx -d api.tudominio.com
```

---

## Parte 7 — Arrancar la app con PM2

```bash
cd /opt/linkedin-saas
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Ejecuta **la línea larga** que te imprime `pm2 startup` (empieza por `sudo env PATH=...`).

Comprobar:

```bash
curl -s http://127.0.0.1:3001/health
```

Debe verse `{"ok":true}`.

---

## Parte 8 — Supabase (antes deberías haber hecho esto)

1. Proyecto creado en supabase.com.
2. SQL de `supabase/migrations/001_initial_schema.sql` ejecutado en el editor SQL.
3. Auth → Email activado.
4. Authentication → URL Configuration: pon la URL de tu **frontend** (Vercel) en Site URL y redirect.

---

## Parte 9 — Frontend en Vercel

- Proyecto con **root** = carpeta `frontend`.
- Variables:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `NEXT_PUBLIC_API_URL=https://api.tudominio.com` (tu dominio real, con `https`)

Deploy. Abre la URL de Vercel, regístrate.

---

## Parte 10 — Proxies y LinkedIn (dentro del panel)

**Orden importante:**

1. **Proxies**  
   - Añade **una línea por proxy**: host, puerto, usuario, contraseña (los de Webshare).  
   - Sin esto, al crear cuenta LinkedIn suele fallar (“no hay proxy”).

2. **LinkedIn**  
   - Pega la cookie `li_at` (desde el navegador donde ya iniciaste sesión en LinkedIn).

3. **Leads, campañas, etc.**  
   - Cuando lo anterior funcione.

El servidor Hetzner **no guarda** la lista de proxies a mano en un archivo: los introduces **solo** en el panel; se guardan en **Supabase** (tabla `proxies`).

---

## Si algo falla

| Problema | Dónde mirar |
|----------|-------------|
| Panel no carga login | Vercel + URLs en Supabase Auth |
| API no responde | `pm2 logs li-api`, `nginx -t`, DNS del `api` |
| Tareas no se mueven | `pm2 logs li-worker`, `redis-cli ping` |
| LinkedIn no conecta | Primero **proxies** en el panel; luego `li_at` correcta |

La guía técnica larga sigue en [`DEPLOY.md`](DEPLOY.md).
