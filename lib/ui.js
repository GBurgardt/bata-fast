import wrapAnsi from "wrap-ansi";
import logUpdate from "log-update";
import { createSpinner } from "nanospinner";
import { cyan, dim, green, red, yellow } from "colorette";

const TERM_WIDTH = Math.min(process.stdout.columns || 80, 72);

const wrapLine = (text = "") =>
  wrapAnsi(text, TERM_WIDTH, { hard: false, trim: true });

const voice = {
  say: (text = "") => console.log(wrapLine(text)),
  hint: (text = "") => console.log(dim(wrapLine(text))),
  success: (text = "") => console.log(green(wrapLine(text))),
  warn: (text = "") => console.log(yellow(wrapLine(text))),
  error: (text = "") => console.log(red(wrapLine(text))),
};

const createStatus = (text) =>
  createSpinner(wrapLine(text), { color: "cyan" }).start();

const createCalmProgress = () => ({
  set: (text = "") => {
    logUpdate.clear();
    logUpdate(wrapLine(text));
  },
  clear: () => logUpdate.clear(),
});

const tidyTitle = (title = "") => title.replace(/\s+/g, " ").trim();

const formatTime = (totalSeconds) => {
  if (
    totalSeconds === null ||
    totalSeconds === undefined ||
    Number.isNaN(Number(totalSeconds)) ||
    totalSeconds < 0
  ) {
    return "??:??";
  }
  const safeSeconds = Math.floor(Number(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0"
  )}`;
};

const formatRelativeTime = (date) => {
  if (!date) return "";
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 4) return `${diffWeeks}w ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  const diffYears = Math.floor(diffDays / 365);
  return `${diffYears}y ago`;
};

export {
  TERM_WIDTH,
  voice,
  wrapLine,
  tidyTitle,
  createStatus,
  createCalmProgress,
  formatTime,
  formatRelativeTime,
};
