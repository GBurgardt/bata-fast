import fs from "fs";
import path from "path";
import { logDebug, logStage } from "./debug.js";

export const collectDrumStems = (jobOutputDir) => {
  const resultJsonPath = path.join(jobOutputDir, "workflow.result.json");
  let potentialDrumFiles = [];

  if (fs.existsSync(resultJsonPath)) {
    try {
      const resultJson = JSON.parse(fs.readFileSync(resultJsonPath, "utf-8"));
      potentialDrumFiles = Object.values(resultJson)
        .filter(
          (val) => typeof val === "string" && val.toLowerCase().endsWith(".wav")
        )
        .map((relativePath) =>
          path.join(jobOutputDir, path.basename(relativePath))
        );
      logDebug(
        "[DEBUG] WAV files found via JSON:",
        potentialDrumFiles
      );
    } catch (jsonError) {
      logStage(
        "MOISES",
        "failed parsing workflow.result.json",
        jsonError.message
      );
    }
  } else {
    logStage(
      "MOISES",
      "workflow.result.json missing, scanning folder",
      jobOutputDir
    );
  }

  if (potentialDrumFiles.length === 0) {
    try {
      potentialDrumFiles = fs
        .readdirSync(jobOutputDir)
        .filter(
          (file) =>
            file.toLowerCase().endsWith(".wav") &&
            file !== "combined_drums.wav"
        )
        .map((file) => path.join(jobOutputDir, file));
      if (potentialDrumFiles.length > 0) {
        logDebug(
          "[DEBUG] WAV files found by scanning directory:",
          potentialDrumFiles
        );
      }
    } catch (readDirError) {
      logStage(
        "MOISES",
        "error reading results directory",
        readDirError.message
      );
    }
  }

  return potentialDrumFiles.filter((file) => {
    const name = path.basename(file).toLowerCase();
    return name !== "other.wav" && name !== "combined_drums.wav";
  });
};
