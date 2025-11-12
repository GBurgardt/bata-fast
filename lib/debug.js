import chalk from "chalk";

export const debugMode = process.argv.includes("--debug");

export const logDebug = (...args) => {
  if (debugMode) {
    console.log(chalk.grey(...args));
  }
};

export const trimForLog = (value, maxLength = 600) => {
  if (value === undefined || value === null) {
    return "<empty>";
  }
  const str = typeof value === "string" ? value : String(value);
  if (str.length <= maxLength) {
    return str;
  }
  return `${str.slice(0, maxLength)}... (truncated, total ${str.length} chars)`;
};

export const logStage = (label, message, payload) => {
  if (!debugMode) {
    return;
  }
  const prefix = chalk.magenta(`[${label}]`);
  if (payload !== undefined) {
    console.log(prefix, message, payload);
  } else {
    console.log(prefix, message);
  }
};
