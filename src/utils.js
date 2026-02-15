export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) {
    return "00:00.00";
  }

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const hundredths = Math.floor((seconds % 1) * 100);

  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(hundredths).padStart(2, "0")}`;
}

export function roundToHundredths(value) {
  return Math.round(value * 100) / 100;
}

export function sanitizeFileName(name) {
  return String(name)
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function greatestCommonDivisor(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);

  while (y) {
    const tmp = y;
    y = x % y;
    x = tmp;
  }

  return x || 1;
}

export function formatAspectRatio(width, height) {
  if (!width || !height) {
    return "--";
  }

  const divisor = greatestCommonDivisor(width, height);
  return `${Math.floor(width / divisor)}:${Math.floor(height / divisor)}`;
}
