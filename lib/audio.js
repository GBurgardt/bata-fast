import { exec, spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import readline from "readline";
import player from "play-sound";
import logUpdate from "log-update";
import { voice, wrapLine, TERM_WIDTH, formatTime } from "./ui.js";
import { logStage, logDebug, trimForLog, debugMode } from "./debug.js";

const audioPlayer = player({});
const SEEK_SECONDS = 5;
const VOLUME_STEP = 0.1;
const MIN_VOLUME = 0;
const MAX_VOLUME = 4;
const PROGRESS_BAR_WIDTH = 32;

let ffplayAvailableCache = null;
let interactivePlayerNoticeShown = false;

const hasFfplayBinary = () => {
  if (ffplayAvailableCache !== null) {
    return ffplayAvailableCache;
  }
  try {
    const result = spawnSync("ffplay", ["-version"], { stdio: "ignore" });
    ffplayAvailableCache = result.status === 0;
  } catch {
    ffplayAvailableCache = false;
  }
  return ffplayAvailableCache;
};

const supportsInteractiveConsole = () =>
  Boolean(process.stdin?.isTTY) && hasFfplayBinary();

const notifyInteractiveLimitation = (message) => {
  if (interactivePlayerNoticeShown) {
    return;
  }
  voice.hint(message);
  interactivePlayerNoticeShown = true;
};

const buildProgressBar = (currentSeconds, totalSeconds) => {
  if (!totalSeconds || totalSeconds <= 0) {
    return "-".repeat(PROGRESS_BAR_WIDTH);
  }
  const ratio = Math.min(Math.max(currentSeconds / totalSeconds, 0), 1);
  const filled = Math.round(ratio * PROGRESS_BAR_WIDTH);
  const empty = PROGRESS_BAR_WIDTH - filled;
  return `${"=".repeat(filled)}${"-".repeat(Math.max(empty, 0))}`;
};

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
  const duration = await getAudioDuration(audioFilePath);
  try {
    let playbackResult = null;
    if (supportsInteractiveConsole()) {
      try {
        playbackResult = await playWithInteractiveConsole(
          audioFilePath,
          baseName,
          duration
        );
      } catch (interactiveError) {
        logStage(
          "PLAY",
          "interactive-player-error",
          trimForLog(interactiveError?.message || interactiveError)
        );
        notifyInteractiveLimitation(
          "couldn't start the console player, so i'm using the basic one for now."
        );
        playbackResult = await playWithBasicAudio(
          audioFilePath,
          baseName,
          duration
        );
      }
    } else {
      if (!process.stdin?.isTTY) {
        notifyInteractiveLimitation(
          "run bata inside a terminal to unlock arrow controls. using the basic player for now."
        );
      } else if (!hasFfplayBinary()) {
        notifyInteractiveLimitation(
          "install ffmpeg (ffplay) to unlock arrow controls. using the basic player for now."
        );
      }
      playbackResult = await playWithBasicAudio(
        audioFilePath,
        baseName,
        duration
      );
    }

    if (playbackResult?.completed === false) {
      voice.hint(`stopped ${baseName}.`);
    } else {
      voice.success(`done listening to ${baseName}.`);
    }
  } catch (playError) {
    logStage("PLAY-ERROR", "detail", trimForLog(playError?.message || playError));
    if (!debugMode) {
      voice.warn(playError.message);
    } else {
      console.error(playError);
    }
  }
}

const playWithBasicAudio = (audioFilePath, baseName, durationSeconds) =>
  new Promise((resolve, reject) => {
    const durationLabel = durationSeconds ? formatTime(durationSeconds) : "??:??";
    process.stdout.write(
      wrapLine(
        `\nlistening to ${baseName} [00:00 / ${durationLabel}] · ctrl+c to stop`
      )
    );

    const startTime = Date.now();
    let progressInterval = null;
    let audioProcess = null;
    let abortedBySigint = false;

    if (durationSeconds) {
      progressInterval = setInterval(() => {
        const elapsedSeconds = (Date.now() - startTime) / 1000;
        const currentSeconds = Math.min(elapsedSeconds, durationSeconds);
        process.stdout.write(
          wrapLine(
            `\rlistening to ${baseName} [${formatTime(
              currentSeconds
            )} / ${durationLabel}] · ctrl+c to stop `
          )
        );
      }, 1000);
    }

    const stopLine = () => {
      if (progressInterval) {
        clearInterval(progressInterval);
      }
      process.stdout.write("\r" + " ".repeat(TERM_WIDTH) + "\r");
    };

    const handleSigint = () => {
      if (abortedBySigint) return;
      abortedBySigint = true;
      stopLine();
      if (audioProcess?.kill) {
        try {
          audioProcess.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    };

    process.on("SIGINT", handleSigint);

    const cleanup = () => {
      process.off("SIGINT", handleSigint);
    };

    audioProcess = audioPlayer.play(audioFilePath, (err) => {
      cleanup();
      stopLine();

      if (err) {
        if (abortedBySigint) {
          resolve({ completed: false });
          return;
        }
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
        resolve({ completed: true });
      }
    });

    if (audioProcess) {
      audioProcess.on("close", (code) => {
        logDebug(`Audio process ended with code: ${code}`);
      });
      audioProcess.on("error", (error) => {
        cleanup();
        stopLine();
        logDebug(`Audio process error: ${error}`);
        reject(new Error(`audio player error: ${error.message}`));
      });
    } else {
      cleanup();
      stopLine();
      logDebug("play-sound did not return a child process.");
      reject(new Error("couldn't start the playback process."));
    }
  });

const playWithInteractiveConsole = (
  audioFilePath,
  baseName,
  durationSeconds
) =>
  new Promise((resolve, reject) => {
    if (!supportsInteractiveConsole()) {
      reject(new Error("interactive console player isn't available."));
      return;
    }

    readline.emitKeypressEvents(process.stdin);
    const initialRawMode = !!process.stdin.isRaw;
    if (!initialRawMode) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdout.write("\n");
    process.stdout.write("\x1B[?25l");

    let ffplayProcess = null;
    let expectingStop = false;
    let pendingStopResolve = null;
    let busy = false;
    let done = false;
    let progressTimer = null;

    const state = {
      offset: 0,
      startedAt: Date.now(),
      playing: false,
      volume: 1,
    };

    const clampPosition = (seconds = 0) => {
      const safeValue = Math.max(0, seconds);
      if (!durationSeconds || durationSeconds <= 0) {
        return safeValue;
      }
      return Math.min(safeValue, durationSeconds);
    };

    const getLivePosition = () => {
      if (!state.playing) {
        return clampPosition(state.offset);
      }
      const elapsed = (Date.now() - state.startedAt) / 1000;
      return clampPosition(state.offset + elapsed);
    };

    const clampVolume = (value = 1) =>
      Math.min(Math.max(value, MIN_VOLUME), MAX_VOLUME);

    const render = () => {
      if (done) return;
      const current = getLivePosition();
      const durationLabel = durationSeconds
        ? formatTime(durationSeconds)
        : "??:??";
      const volumePercent = Math.round(state.volume * 100);
      const lines = [
        wrapLine(`listening to ${baseName}`),
        wrapLine(
          `[${buildProgressBar(current, durationSeconds)}] ${formatTime(
            current
          )} / ${durationLabel} · ${
            state.playing ? "playing" : "paused"
          } · vol ${volumePercent}%`
        ),
        wrapLine(
          `controls: space play/pause · ← -${SEEK_SECONDS}s · → +${SEEK_SECONDS}s · ↑ louder · ↓ softer · q exit`
        ),
      ];
      logUpdate(lines.join("\n"));
    };

    const clearUi = () => {
      logUpdate.clear();
      process.stdout.write("\x1B[?25h");
    };

    const detachKeypress = () => {
      process.stdin.removeListener("keypress", onKeypress);
      if (!initialRawMode) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          // ignore
        }
      }
    };

    const stopCurrentProcess = () =>
      new Promise((resolveStop) => {
        if (!ffplayProcess) {
          resolveStop();
          return;
        }
        pendingStopResolve = resolveStop;
        expectingStop = true;
        try {
          ffplayProcess.kill("SIGKILL");
        } catch {
          expectingStop = false;
          pendingStopResolve = null;
          resolveStop();
        }
      });

    const finalize = async (completed) => {
      if (done) return;
      done = true;
      clearInterval(progressTimer);
      await stopCurrentProcess();
      detachKeypress();
      clearUi();
      resolve({ completed });
    };

    const fail = async (error) => {
      if (done) return;
      done = true;
      clearInterval(progressTimer);
      await stopCurrentProcess();
      detachKeypress();
      clearUi();
      reject(error);
    };

    const handleProcessClose = () => {
      const wasExpecting = expectingStop;
      expectingStop = false;
      const resolver = pendingStopResolve;
      pendingStopResolve = null;

      if (ffplayProcess) {
        ffplayProcess.removeAllListeners("error");
        ffplayProcess.removeAllListeners("close");
        ffplayProcess = null;
      }

      if (wasExpecting) {
        resolver?.();
        return;
      }

      state.playing = false;
      finalize(true);
    };

    const handleProcessError = (error) => {
      if (ffplayProcess) {
        ffplayProcess.removeAllListeners("error");
        ffplayProcess.removeAllListeners("close");
        ffplayProcess = null;
      }

      const isMissing =
        error?.code === "ENOENT" ||
        error?.message?.toLowerCase().includes("ffplay");

      fail(
        new Error(
          isMissing
            ? "ffplay isn't available. install ffmpeg to unlock the in-console player."
            : `ffplay error: ${error?.message || "unknown"}`
        )
      );
    };

    const startPlayback = async (startSeconds = 0) => {
      await stopCurrentProcess();
      const start = clampPosition(startSeconds);
      state.offset = start;
      state.startedAt = Date.now();
      state.playing = true;
      expectingStop = false;
      pendingStopResolve = null;

      const child = spawn("ffplay", [
        "-nodisp",
        "-autoexit",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        start.toFixed(2),
        "-i",
        audioFilePath,
        "-af",
        `volume=${state.volume.toFixed(2)}`,
      ]);

      ffplayProcess = child;
      child.on("close", handleProcessClose);
      child.on("error", handleProcessError);
      render();
    };

    const pausePlayback = async () => {
      if (!state.playing) return;
      state.offset = getLivePosition();
      state.playing = false;
      await stopCurrentProcess();
      render();
    };

    const resumePlayback = async () => {
      await startPlayback(state.offset);
    };

    const seekBy = async (deltaSeconds) => {
      const target = clampPosition(getLivePosition() + deltaSeconds);
      const wasPlaying = state.playing;
      state.offset = target;
      if (wasPlaying) {
        await startPlayback(target);
      } else {
        render();
      }
    };

    const adjustVolume = async (delta) => {
      const nextVolume = clampVolume(
        Math.round((state.volume + delta) * 100) / 100
      );
      if (nextVolume === state.volume) {
        render();
        return;
      }
      state.volume = nextVolume;
      if (state.playing) {
        await startPlayback(getLivePosition());
      } else {
        render();
      }
    };

    const onKeypress = async (_, key = {}) => {
      if (busy) return;
      busy = true;
      try {
        if (key.ctrl && key.name === "c") {
          await finalize(false);
          return;
        }

        switch (key.name) {
          case "space":
            if (state.playing) {
              await pausePlayback();
            } else {
              await resumePlayback();
            }
            break;
          case "left":
            await seekBy(-SEEK_SECONDS);
            break;
          case "right":
            await seekBy(SEEK_SECONDS);
            break;
          case "up":
            await adjustVolume(VOLUME_STEP);
            break;
          case "down":
            await adjustVolume(-VOLUME_STEP);
            break;
          case "q":
          case "escape":
          case "return":
            await finalize(false);
            break;
          default:
            break;
        }
      } catch (error) {
        await fail(error);
      } finally {
        busy = false;
      }
    };

    process.stdin.on("keypress", onKeypress);

    progressTimer = setInterval(render, 120);
    render();
    startPlayback(0).catch((error) => fail(error));
  });

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
