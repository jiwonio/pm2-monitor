# PM2 Slack Monitor

An advanced monitoring script for PM2 that sends real-time alerts to Slack for process restarts, status changes, and high resource usage (CPU/Memory).

It intelligently handles clustered apps, throttles notifications to prevent spam, and provides an optional web endpoint to view status history.

---

## ✨ Features

-   **Intelligent Restart Polling**: When a restart is detected, the script polls the app until it's stable (`online`) or times out, giving a definitive success/failure notification.
-   **Resource Threshold Alerts**: Get warnings for high CPU and Memory usage based on configurable thresholds.
-   **Cluster-Aware Notifications**: Groups restart notifications for clustered apps into a single event.
-   **Alert Throttling**: Prevents spam by suppressing identical notifications for a configurable duration.
-   **Configurable Cron Schedule**: Define exactly when the monitoring script should run (e.g., only during business hours).
-   **Optional Web UI**: A simple HTTP endpoint (`/status`) to view the recent history of process statuses as a JSON object.

---

## 🛠️ Setup & Installation

### Prerequisites

-   [Node.js](https://nodejs.org/) (v14 or later recommended)
-   [PM2](https://pm2.keymetrics.io/) installed globally (`npm install -g pm2`)
-   A Slack Incoming Webhook URL. You can create one [here](https://api.slack.com/messaging/webhooks).

### Installation Steps

1.  **Clone the repository:**
    ```bash
    git clone git@github.com:jiwonio/pm2-monitor.git
    cd pm2-monitor
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Set up Environment Variables:**
    The script requires your Slack Webhook URL. **For security reasons, do not hardcode this in any file.**

    Create a `.env` file in the root directory and add your webhook URL:
    ```env
    # .env
    SLACK_WEBHOOK_URL='[https://hooks.slack.com/services/YOUR/WEBHOOK/URL](https://hooks.slack.com/services/YOUR/WEBHOOK/URL)'
    ```
    PM2 will automatically load variables from this file if you install `dotenv`. Alternatively, you can set it as a system environment variable.

---

## ⚙️ Configuration

You can customize the monitor's behavior by editing the `CONFIG` object at the top of the `pm2-monitor.js` script.

| Key                  | Description                                                                 | Default                       |
| -------------------- | --------------------------------------------------------------------------- | ----------------------------- |
| `CRON_SCHEDULE`      | The schedule for when to run the check. Uses `node-cron` format.            | `'*/1 8-19 * * 1-5'`          |
| `EXCLUDED_APPS`      | An array of PM2 app names to ignore during checks.                          | `['pm2-monitor', 'pm2-logrotate']` |
| `THRESHOLDS`         | An object defining the CPU (%) and Memory (MB) limits.                      | `{ CPU: 80, MEMORY: 450 }`    |
| `THROTTLE_DURATION_MS` | How long (in ms) to suppress identical alerts (e.g., repeated CPU warnings).| `30000` (30 seconds)          |
| `RECHECK_TIMEOUT_SEC`| Total time (in seconds) to wait for a restarting app to stabilize.          | `60` (1 minute)               |
| `WEB_SERVER.ENABLED` | Set to `true` to enable the status history web server.                      | `true`                        |
| `WEB_SERVER.PORT`    | The port for the status web server.                                         | `3031`                        |

---

## 🚀 Usage

The recommended way to run the monitor is with PM2, using the provided configuration file.

1.  **Start the monitor with PM2:**
    This command will register the script as a PM2 process named `pm2-monitor`.
    ```bash
    npm start
    ```

2.  **Check the logs:**
    To see the monitor's activity and check for errors, run:
    ```bash
    npm run logs
    ```
    or
    ```bash
    pm2 logs pm2-monitor
    ```

3.  **Save the process list:**
    To ensure the monitor restarts automatically after a server reboot, run:
    ```bash
    pm2 save
    ```

### Optional: Viewing Status History

If `WEB_SERVER.ENABLED` is `true`, you can view a JSON history of process statuses by navigating to:
`http://<your-server-ip>:3031/status`

---

## ⚠️ Security Notice

Your `SLACK_WEBHOOK_URL` is a secret. **Do not hardcode it** in `ecosystem.config.cjs` or any other file that will be committed to version control. Use an environment variable or a `.env` file (which should be added to `.gitignore`) to keep it secure.

---

## 📄 License

This project is licensed under the ISC License.