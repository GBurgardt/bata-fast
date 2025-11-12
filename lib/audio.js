import { exec } from "child_process";
import fs from "fs";
import path from "path";
import player from "play-sound";
import { voice, wrapLine, TERM_WIDTH, formatTime } from "./ui.js";
import { logStage, logDebug, trimForLog, debugMode } from "./debug.js";

const audioPlayer = player({});

export async function getAudioDuration(filePath) {
  const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
  logDebug("Running ffprobe:", command);
  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        logDebug("ffprobe error:", stderr || error.message);
        if (
          error.message.includes("ENOENT") ||
          error.message.toLowerCase().includes("not found")
        ) {
          voice.warn(
            "ffprobe isn't available, so duration will be hidden. install ffmpeg to unlock it."
          );
        } else {
          voice.warn("couldn't read the audio duration.");
        }
        resolve(null);
        return;
      }
      const duration = parseFloat(stdout.trim());
      if (isNaN(duration)) {
        logDebug("ffprobe returned an invalid duration:", stdout);
        voice.warn("ffprobe returned an unexpected duration format.");
        resolve(null);
      } else {
        logDebug("Duration (seconds):", duration);
        resolve(duration);
      }
    });
  });
}

export async function playAudioFile(audioFilePath) {
  if (!fs.existsSync(audioFilePath)) {
    voice.error("can't find that file to play.");
    return;
  }

  logStage("PLAY", "Playing file", audioFilePath);
  const baseName = path.basename(audioFilePath);
  let duration = await getAudioDuration(audioFilePath);
  const durationStr = duration ? formatTime(duration) : "??:??";
  let progressInterval = null;

  try {
    process.stdout.write(
      wrapLine(
        `\nlistening to ${baseName} [00:00 / ${durationStr}] · ctrl+c to stop`
      )
    );

    const playPromise = new Promise((resolve, reject) => {
      const startTime = Date.now();

      if (duration) {
        progressInterval = setInterval(() => {
          const elapsedSeconds = (Date.now() - startTime) / 1000;
          const currentSeconds = Math.min(elapsedSeconds, duration);
          const currentTimeStr = formatTime(currentSeconds);
          process.stdout.write(
            wrapLine(
              `\rlistening to ${baseName} [${currentTimeStr} / ${durationStr}] · ctrl+c to stop `
            )
          );
        }, 1000);
      }

      const audioProcess = audioPlayer.play(audioFilePath, (err) => {
        clearInterval(progressInterval);
        process.stdout.write("\r" + " ".repeat(TERM_WIDTH) + "\r");

        if (err) {
          let errorMsg = err.message;
          if (
            !debugMode &&
            (err.message.includes("Couldn't find a suitable audio player") ||
              err.message.toLowerCase().includes("no such file") ||
              err.code === "ENOENT")
          ) {
            errorMsg =
              "no compatible audio player found (afplay, mplayer, ...).";
          }
          reject(new Error(errorMsg));
        } else {
          voice.success(`done listening to ${baseName}.`);
          resolve();
        }
      });

      if (audioProcess) {
        audioProcess.on("close", (code) => {
          logDebug(`Audio process ended with code: ${code}`);
        });
        audioProcess.on("error", (error) => {
          clearInterval(progressInterval);
          process.stdout.write("\r" + " ".repeat(TERM_WIDTH) + "\r");
          logDebug(`Audio process error: ${error}`);
          reject(
            new Error(`audio player error: ${error.message}`)
          );
        });
      } else {
        clearInterval(progressInterval);
        process.stdout.write("\r" + " ".repeat(TERM_WIDTH) + "\r");
        logDebug("play-sound did not return a child process.");
        reject(new Error("couldn't start the playback process."));
      }
    });

    await playPromise;
  } catch (playError) {
    if (progressInterval) clearInterval(progressInterval);
    process.stdout.write("\r" + " ".repeat(TERM_WIDTH) + "\r");
    logStage("PLAY-ERROR", "detail", trimForLog(playError?.message || playError));
    if (!debugMode) {
      voice.warn(playError.message);
    } else {
      console.error(playError);
    }
  }
}

export async function combineDrumStems(wavFiles, outputDir) {
  const combinedFileName = "combined_drums.wav";
  const combinedOutputPath = path.join(outputDir, combinedFileName);

  logStage(
    "FFMPEG",
    "Preparing blend",
    trimForLog(
      JSON.stringify({
        inputCount: wavFiles.length,
        output: combinedOutputPath,
      })
    )
  );

  if (wavFiles.length === 0) {
    throw new Error("no drum stems available to combine.");
  }
  if (wavFiles.length === 1) {
    logStage("FFMPEG", "Only one stem, returning directly", wavFiles[0]);
    return wavFiles[0];
  }

  const inputArgs = wavFiles.map((file) => `-i "${file}"`).join(" ");
  const filterComplex = `amix=inputs=${wavFiles.length}:duration=longest`;
  const command = `ffmpeg ${inputArgs} -filter_complex "${filterComplex}" -y "${combinedOutputPath}"`;

  logStage(
    "FFMPEG",
    "Files to blend",
    wavFiles.map((f) => path.basename(f))
  );
  logStage("FFMPEG", "Command", command);

  try {
    await new Promise((resolve, reject) => {
      const ffmpegProcess = exec(command, (error, stdout, stderr) => {
        if (debugMode) {
          if (stderr) process.stdout.write(stderr);
          if (stdout) process.stdout.write(stdout);
        }
        if (error) {
          if (
            error.message.includes("ENOENT") ||
            error.message.toLowerCase().includes("not found")
          ) {
            return reject(new Error("ffmpeg is missing. install it and try again."));
          }
          return reject(
            new Error(
              `ffmpeg exited with code ${error.code}. run with --debug for the raw output.`
            )
          );
        }
        resolve();
      });

      ffmpegProcess.on("error", (err) => {
        if (
          err.message.includes("ENOENT") ||
          err.message.toLowerCase().includes("not found")
        ) {
          reject(new Error("ffmpeg is missing. install it and try again."));
        } else {
          reject(
            new Error(
              `ffmpeg couldn't run: ${
                debugMode ? err.message : "run with --debug for details."
              }`
            )
          );
        }
      });
    });

    return combinedOutputPath;
  } catch (error) {
    logStage(
      "FFMPEG-ERROR",
      "Blend failure",
      trimForLog(error?.message || error)
    );
    throw error;
  }
}
