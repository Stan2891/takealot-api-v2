// Takealot V2.1 — Unified Debug/Audit Logger
// Append-only JSONL to /home/stan/reports/takealot-debug.log
// Never throws. Sanitizes sensitive values.

const fs = require('fs');
const path = require('path');

const LOG_FILE = '/home/stan/reports/takealot-debug.log';

// Patterns that indicate a sensitive key (case-insensitive match)
const SENSITIVE_PATTERNS = [
  'key', 'token', 'secret', 'authorization', 'x-api-key',
  'api_key', 'refresh', 'password', 'url', 'topic'
];

/**
 * Recursively sanitize an object, redacting sensitive keys.
 * @param {*} obj
 * @returns {*} sanitized copy
 */
function sanitizeContext(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj.substring(0, 500);
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeContext);

  const cleaned = {};
  for (const [k, v] of Object.entries(obj)) {
    const lower = k.toLowerCase();
    const isSensitive = SENSITIVE_PATTERNS.some(p => lower.includes(p));
    if (isSensitive && v !== undefined && v !== null && v !== '') {
      cleaned[k] = '[REDACTED]';
    } else if (typeof v === 'object' && v !== null) {
      cleaned[k] = sanitizeContext(v);
    } else if (typeof v === 'string') {
      cleaned[k] = v.substring(0, 500);
    } else {
      cleaned[k] = v;
    }
  }
  return cleaned;
}

/**
 * Log a structured event to the debug log file.
 * @param {Object} event
 * @param {string} event.source - Origin module
 * @param {string} event.event_type - Type of event
 * @param {string} [event.level] - debug|info|warn|error
 * @param {string} [event.message] - Human-readable message (capped at 500 chars)
 * @param {Object} [event.context] - Additional context (sanitized)
 * @param {Object} [event.result] - Result data (sanitized)
 */
function logTakealotEvent(event = {}) {
  try {
    const entry = {
      timestamp: new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', hour12: false }).replace(',', ''),
      source: event.source || 'takealot-integration',
      event_type: event.event_type || 'unknown',
      level: event.level || 'info',
      message: typeof event.message === 'string' ? event.message.substring(0, 500) : '',
      context: sanitizeContext(event.context || {}),
      result: sanitizeContext(event.result || {})
    };

    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(LOG_FILE, line, { encoding: 'utf8' });
  } catch (err) {
    console.error(`[DEBUG-LOG] Write failed: ${(err.message || '').substring(0, 100)}`);
  }
}

module.exports = { logTakealotEvent, sanitizeContext };
