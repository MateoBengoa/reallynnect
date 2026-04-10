/** PM2 — Hetzner VPS: API + worker + scheduler
 *
 * El .env se puede colocar en cualquiera de estos sitios (env.ts los prueba en orden):
 *   1. backend/.env        ← preferido
 *   2. .env (raíz del repo)
 *
 * Si PM2 soporta env_file (pm2 ≥ 4.x) también se puede usar:
 *   env_file: "../.env"   (relativo a cwd=./backend)
 */
module.exports = {
  apps: [
    {
      name: "li-api",
      cwd: "./backend",
      script: "dist/server.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3001,
        HOST: "0.0.0.0",
      },
    },
    {
      name: "li-worker",
      cwd: "./backend",
      script: "dist/workers/runner.js",
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
    },
    {
      name: "li-scheduler",
      cwd: "./backend",
      script: "dist/workers/scheduler.js",
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
    },
  ],
};
