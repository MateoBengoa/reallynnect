/** PM2 — Hetzner VPS: API + worker + scheduler */
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
