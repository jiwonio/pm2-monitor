// ecosystem.config.cjs
module.exports = {
  apps: [{
    name: 'pm2-monitor',
    script: './pm2-monitor.js',
    watch: false,
    time: true,
    env: {
      PORT: 3031,
      HOST: "0.0.0.0",
      // ⚠️ Set your Slack webhook URL here, 
      // Set it in your server's environment or a .env file.
      SLACK_WEBHOOK_URL: "YOUR_SLACK_WEBHOOK_URL_HERE"
    },
  }]
};