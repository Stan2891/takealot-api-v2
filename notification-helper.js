// Takealot V2.1 — Notification Helper
// Sends notifications via ntfy.sh (or self-hosted ntfy)
// Never throws — returns structured result object

const axios = require('axios');
const { logTakealotEvent } = require('./takealot-debug-log');

/**
 * Send a notification via ntfy with retry support
 * @param {Object} options
 * @param {string} options.title - Notification title
 * @param {string} options.message - Notification body
 * @param {string} [options.priority] - min, low, default, high, urgent
 * @param {string} [options.tags] - Comma-separated emoji tags
 * @param {string} [options.click] - URL to open on click
 * @param {string} [options.email] - Override email recipient
 * @param {number} [options.maxAttempts=3] - Max send attempts
 * @param {number} [options.retryDelayMs=2000] - Delay between retries in ms
 * @returns {Promise<{sent:boolean, reason?:string, error?:string, status?:number, attempts:number, retryable?:boolean}>}
 */
async function sendNtfyNotification({ title, message, priority, tags, click, email, maxAttempts = 3, retryDelayMs = 2000 } = {}) {
  try {
    // Check if notifications are enabled
    const enabled = (process.env.NTFY_ENABLED || '').toLowerCase() === 'true';
    if (!enabled) {
      const result = { sent: false, reason: 'disabled', attempts: 0 };
      logTakealotEvent({
        source: 'notification-helper',
        event_type: 'notification_attempt',
        level: 'debug',
        message: `Notification skipped: disabled. Title: ${(title || '').substring(0, 100)}`,
        context: { title, priority, tags, click_present: !!click, email_present: !!email },
        result
      });
      return result;
    }

    // Check for required topic
    const topic = (process.env.NTFY_TOPIC || '').trim();
    if (!topic) {
      const result = { sent: false, reason: 'missing_topic', attempts: 0 };
      logTakealotEvent({
        source: 'notification-helper',
        event_type: 'notification_attempt',
        level: 'warn',
        message: `Notification skipped: missing_topic. Title: ${(title || '').substring(0, 100)}`,
        context: { title, priority, tags, click_present: !!click, email_present: !!email },
        result
      });
      return result;
    }

    const server = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');
    const url = server + '/' + topic;

    // Build headers
    const headers = {};
    if (title) headers['Title'] = String(title).substring(0, 250);
    if (priority) headers['Priority'] = String(priority);
    if (tags) headers['Tags'] = String(tags);
    if (click) headers['Click'] = String(click);

    // Email: use explicit param, fall back to env
    const emailTo = email || (process.env.NTFY_EMAIL || '').trim();
    if (emailTo) headers['Email'] = emailTo;

    const body = String(message || '').substring(0, 4000);

    let lastError = null;
    let lastStatus = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = await axios.post(url, body, {
          headers,
          timeout: 10000
        });
        const result = { sent: true, status: resp.status, attempts: attempt };
        logTakealotEvent({
          source: 'notification-helper',
          event_type: 'notification_attempt',
          level: 'info',
          message: `Notification sent. Title: ${(title || '').substring(0, 100)}`,
          context: { title, priority, tags, click_present: !!click, email_present: !!email },
          result
        });
        return result;
      } catch (err) {
        lastError = err.message || 'Unknown error';
        lastStatus = err.response?.status || null;

        // Determine if retryable
        const isRetryable = !lastStatus || lastStatus >= 500;

        if (!isRetryable || attempt >= maxAttempts) {
          const result = {
            sent: false,
            error: lastError,
            status: lastStatus,
            attempts: attempt,
            retryable: isRetryable
          };
          logTakealotEvent({
            source: 'notification-helper',
            event_type: 'notification_attempt',
            level: 'error',
            message: `Notification failed after ${attempt} attempt(s). Title: ${(title || '').substring(0, 100)}`,
            context: { title, priority, tags, click_present: !!click, email_present: !!email },
            result
          });
          return result;
        }

        // Log retry warning (no secrets)
        console.error(`[NTFY] Retry ${attempt + 1}/${maxAttempts} after failure: ${lastError}`);

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }

    // Should not reach here, but safety fallback
    return { sent: false, error: lastError, status: lastStatus, attempts: maxAttempts, retryable: false };
  } catch (err) {
    const result = { sent: false, error: err.message || 'Unknown error', status: null, attempts: 0, retryable: false };
    logTakealotEvent({
      source: 'notification-helper',
      event_type: 'notification_attempt',
      level: 'error',
      message: `Notification unexpected error: ${(err.message || '').substring(0, 200)}`,
      context: { title },
      result
    });
    return result;
  }
}

module.exports = { sendNtfyNotification };
