// pm2 ecosystem — tuned for 2017 MacBook Air (dual-core i5, 8GB RAM).
// Single instance ONLY: clustering on 2 cores with a memory-hungry scanner
// just doubles RSS. autorestart guards crashes; max_memory_restart guards leaks.
module.exports = {
  apps: [
    {
      name: 'flash-loan-arb',
      script: 'dist/index.js',
      args: '--mode demo',                 // flip to '--mode live' via arb-live alias
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',                   // no cluster → one V8 heap, predictable
      autorestart: true,
      watch: false,                        // file watching would thrash the SSD/CPU
      max_memory_restart: '450M',          // leak insurance: restart before swap storm
      min_uptime: '20s',                   // crash-loop guard: <20s uptime = failing
      max_restarts: 10,                    // ...and give up after 10 fast crashes
      restart_delay: 4000,                 // back-off so we don't hammer a dead RPC
      exponential_backoff_restart_delay: 1000,  // 1s,2s,4s... capped by pm2 default
      kill_timeout: 5000,                  // let graceful shutdown flush RPC calls
      env: {
        NODE_OPTIONS: '--max-old-space-size=384 --optimize-for-size',
        PM2_LOG_DATE_FORMAT: 'YYYY-MM-DD HH:mm:ss.SSS Z',
      },
      out_file: '../logs/bot-out.log',     // rotated by pm2-logrotate (install.sh)
      error_file: '../logs/bot-err.log',   // max 10MB/file, 7 files, gzip -> disk safe
      merge_logs: true,
      time: true,
    },
  ],
};
