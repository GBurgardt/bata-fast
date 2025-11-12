import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), "..");

const DOWNLOADS_DIR = path.join(ROOT_DIR, "downloads");
const PROCESSED_DIR = path.join(DOWNLOADS_DIR, "processed_stems");

export { ROOT_DIR, DOWNLOADS_DIR, PROCESSED_DIR };

export const ensureDirectory = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};
