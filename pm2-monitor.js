/**
 * PM2 Monitor Script
 * * Monitors PM2 processes and sends Slack notifications for restarts, status anomalies, or high resource usage.
 * Key Features: Intelligent restart detection, optimized notifications for clustered apps, and alert throttling.
 *
 * How to Run:
 * 1. npm install axios node-cron
 * 2. SLACK_WEBHOOK_URL='YOUR_WEBHOOK_URL' node pm2-monitor.js
 */

// --- 📚 Imports ---
import { exec as callbackExec } from 'child_process';
import { promisify } from 'util';
import cron from 'node-cron';
import axios from 'axios';
import http from 'http';
import fs from 'fs/promises';

const exec = promisify(callbackExec);

// --- ⚙️ Configuration ---
const CONFIG = {
  CRON_SCHEDULE: '*/1 8-19 * * 1-5', // Every minute from 8 AM to 7 PM on weekdays
  EXCLUDED_APPS: ['pm2-monitor', 'pm2-logrotate'],
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL,
  THRESHOLDS: { CPU: 80, MEMORY: 450 }, // CPU (%), Memory (MB)
  THROTTLE_DURATION_MS: 30 * 1000, // Suppress identical notifications for 30 seconds
  // Restart check polling settings
  RECHECK_INTERVAL_MS: 5 * 1000,    // 5-second interval
  RECHECK_MAX_ATTEMPTS: 12,         // Max 12 attempts (total 60-second wait)
  get RECHECK_TIMEOUT_SEC() { return (this.RECHECK_INTERVAL_MS / 1000) * this.RECHECK_MAX_ATTEMPTS; },
  // (Optional) Web server for status history
  WEB_SERVER: {
    ENABLED: true, // Whether to enable the web server
    PORT: process.env.PORT || 3031,
    STATUS_LOG_FILE: './status-history.json',
    MAX_HISTORY: 1440, // Store the last 1440 records (1 day at 1-min intervals)
  },
};

// --- 📦 State Management ---
const appRestartHistory = new Map();
const notificationThrottleCache = new Map();

// --- 🔍 Core Logic ---

/**
 * Main function to monitor all PM2 processes.
 */
async function monitorProcesses() {
  try {
    const processes = await getPm2Processes();
    const restartedApps = await detectAndHandleRestarts(processes);
    await checkStableProcesses(processes, restartedApps);
    if (CONFIG.WEB_SERVER.ENABLED) {
      await logStatusToFile(processes);
    }
  } catch (error) {
    console.error(`[Error] Failed to run monitoring cycle: ${error.message}`);
    sendSlackNotification('PM2 Monitor', 'Monitoring Script Error', error.message, 'danger');
  }
}

/**
 * Detects app restarts and initiates status polling.
 */
async function detectAndHandleRestarts(processes) {
  const restartedApps = new Set();
  const currentRestartsByApp = new Map();

  for (const proc of processes) {
    const count = currentRestartsByApp.get(proc.name) || 0;
    currentRestartsByApp.set(proc.name, count + proc.restarts);
  }

  for (const [appName, totalRestarts] of currentRestartsByApp.entries()) {
    const prevRestarts = appRestartHistory.get(appName);
    if (prevRestarts !== undefined && totalRestarts > prevRestarts) {
      restartedApps.add(appName);
      const message = `A restart was detected for '${appName}'. Monitoring status for up to ${CONFIG.RECHECK_TIMEOUT_SEC} seconds.`;
      sendSlackNotification(appName, 'Process Restart Detected', message, 'warning');
      startPollingAppStatus(appName);
    }
    appRestartHistory.set(appName, totalRestarts);
  }
  return restartedApps;
}

/**
 * Periodically checks an app's status to determine if it has stabilized.
 */
function startPollingAppStatus(appName) {
  let attempts = 0;
  const intervalId = setInterval(async () => {
    attempts++;
    console.log(`[Polling] Checking status for '${appName}'... (${attempts}/${CONFIG.RECHECK_MAX_ATTEMPTS})`);

    try {
      const processes = await getPm2Processes();
      const appInstances = processes.filter(p => p.name === appName);
      const isAllOnline = appInstances.length > 0 && appInstances.every(p => p.status === 'online');

      if (isAllOnline) {
        clearInterval(intervalId);
        const { cpu, memory } = appInstances[0];
        console.log(`[Success] App '${appName}' has stabilized with 'online' status.`);
        const message = `App '${appName}' successfully restarted and is now 'online'.\n(CPU: ${cpu}%, Memory: ${memory}MB)`;
        sendSlackNotification(appName, 'Restart Successful', message, 'good');
        return;
      }

      if (attempts >= CONFIG.RECHECK_MAX_ATTEMPTS) {
        clearInterval(intervalId);
        console.error(`[Failure] App '${appName}' did not stabilize within the time limit.`);
        const reason = appInstances.length > 0 
          ? `Current status:\n- ${appInstances.map(p => `ID ${p.pm_id}: ${p.status}`).join('\n- ')}` 
          : 'Could not find process.';
        const message = `App '${appName}' failed to become 'online' within the time limit.\n${reason}`;
        sendSlackNotification(appName, 'Restart Failed', message, 'danger');
      }
    } catch (error) {
      clearInterval(intervalId);
      console.error(`[Error] Polling for '${appName}' failed: ${error.message}`);
      sendSlackNotification(appName, `Status Polling Error for '${appName}'`, error.message, 'danger');
    }
  }, CONFIG.RECHECK_INTERVAL_MS);
}

/**
 * Checks the status and resource usage of stable processes.
 */
async function checkStableProcesses(processes, restartedApps) {
  for (const proc of processes) {
    if (restartedApps.has(proc.name)) continue;

    const { name, pm_id, status, cpu, memory } = proc;
    console.log(`[Check] ${name}(${pm_id}): Status(${status}), CPU(${cpu}%), Memory(${memory}MB)`);

    if (status !== 'online') {
      sendSlackNotification(name, 'Process Status Alert', `Instance \`${pm_id}\` has a status of \`${status}\`.`, 'danger');
    } else {
      if (cpu > CONFIG.THRESHOLDS.CPU) {
        sendSlackNotification(name, 'High CPU Usage', `Instance \`${pm_id}\` is using \`${cpu}%\` CPU.`, 'warning');
      }
      if (memory > CONFIG.THRESHOLDS.MEMORY) {
        sendSlackNotification(name, 'High Memory Usage', `Instance \`${pm_id}\` is using \`${memory}MB\` of memory.`, 'warning');
      }
    }
  }
}

// --- 🛠️ Helper Functions ---

/**
 * Fetches and returns a clean array of PM2 process information.
 */
async function getPm2Processes() {
  const { stdout } = await exec('pm2 jlist');
  if (!stdout) return [];
  
  return JSON.parse(stdout)
    .filter(p => !CONFIG.EXCLUDED_APPS.includes(p.name))
    .map(({ pm_id, name, pm2_env, monit }) => ({
      pm_id, name,
      status: pm2_env.status,
      restarts: pm2_env.restart_time || 0,
      cpu: monit.cpu || 0,
      memory: parseFloat((monit.memory / 1024 / 1024).toFixed(2)) || 0,
    }));
}

/**
 * Sends a Slack notification with throttling.
 */
async function sendSlackNotification(appName, title, message, color = 'danger') {
  const key = `${appName}::${title}`;
  const now = Date.now();

  if (notificationThrottleCache.has(key) && (now - notificationThrottleCache.get(key) < CONFIG.THROTTLE_DURATION_MS)) {
    return; // Throttled
  }

  console.log(`[Notification] Sending to Slack: [${appName}] ${title}`);
  try {
    const payload = createSlackPayload(appName, title, message, color);
    await axios.post(CONFIG.SLACK_WEBHOOK_URL, payload);
    notificationThrottleCache.set(key, now);
  } catch (error) {
    console.error(`[Error] Failed to send Slack notification: ${error.message}`);
  }
}

/**
 * Creates the JSON payload for the Slack message.
 */
function createSlackPayload(appName, title, message, color) {
  const emoji = color === 'good' ? '✅' : color === 'warning' ? '⚠️' : '🚨';
  return {
    attachments: [{
      color,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `${emoji} [PM2] ${title}`, emoji: true } },
        { type: 'section', fields: [
            { type: 'mrkdwn', text: `*App Name:*\n\`${appName}\`` },
            { type: 'mrkdwn', text: `*Time:*\n${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}` }
        ]},
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: message } },
      ],
    }],
  };
}

// --- 🚀 Initialization ---

/**
 * Initializes and starts the entire script.
 */
async function initialize() {
  console.log('✅ Starting PM2 monitoring script.');

  if (!CONFIG.SLACK_WEBHOOK_URL || !CONFIG.SLACK_WEBHOOK_URL.startsWith('https://hooks.slack.com/')) {
    console.error('❌ Fatal Error: SLACK_WEBHOOK_URL environment variable is not valid. Exiting.');
    process.exit(1);
  }

  console.log(`- Schedule: ${CONFIG.CRON_SCHEDULE}`);
  console.log(`- Excluded Apps: ${CONFIG.EXCLUDED_APPS.join(', ') || 'None'}`);
  
  if (CONFIG.WEB_SERVER.ENABLED) {
    startWebServer();
  }
  
  // Initialize restart counts to prevent false alarms on first run
  const initialProcesses = await getPm2Processes();
  for (const proc of initialProcesses) {
    const count = appRestartHistory.get(proc.name) || 0;
    appRestartHistory.set(proc.name, count + proc.restarts);
  }
  console.log('📦 Initial process state has been recorded.');

  cron.schedule(CONFIG.CRON_SCHEDULE, monitorProcesses, { timezone: "America/New_York" });
  
  console.log('🚀 Running the first monitoring check immediately...');
  await monitorProcesses();
}

/** (Optional) Starts a web server to view status history. */
function startWebServer() {
  const { PORT, STATUS_LOG_FILE } = CONFIG.WEB_SERVER;
  http.createServer(async (req, res) => {
    if (req.url === '/status') {
      try {
        const data = await fs.readFile(STATUS_LOG_FILE, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(data);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Could not read status file.' }));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  }).listen(PORT, () => console.log(`[Info] Status server is running at http://localhost:${PORT}/status`));
}

/** Logs process status to a file. */
async function logStatusToFile(processes) {
    const { STATUS_LOG_FILE, MAX_HISTORY } = CONFIG.WEB_SERVER;
    let history = [];
    try {
        const fileContent = await fs.readFile(STATUS_LOG_FILE, 'utf-8');
        history = JSON.parse(fileContent);
    } catch (error) {
        if (error.code !== 'ENOENT') console.error(`[Error] Failed to read status history file: ${error.message}`);
    }

    history.unshift({ timestamp: new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }), processes });
    const prunedHistory = history.slice(0, MAX_HISTORY);
    await fs.writeFile(STATUS_LOG_FILE, JSON.stringify(prunedHistory, null, 2));
}

// --- Run Script ---
initialize();