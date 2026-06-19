module.exports = {
  apps: [
    {
      name: 'anidiary',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'development',
        PORT: 3000
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        DB_PATH: process.env.DB_PATH
      }
    }
  ]
};
