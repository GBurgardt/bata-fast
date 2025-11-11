#!/usr/bin/env node

import { google } from "googleapis";
import dotenv from "dotenv";
import { exec } from "child_process"; // Usaremos exec para llamar a yt-dlp directamente para mejor control
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk"; // Para logs y debug
import logUpdate from "log-update";
import wrapAnsi from "wrap-ansi";
import { createSpinner } from "nanospinner";
import enquirer from "enquirer";
import { cyan, dim, green, red, yellow } from "colorette";
import Moises from "moises/sdk.js"; // <--- Importar SDK de Moises
import player from "play-sound"; // <--- Importar para reproducir audio

// Configuración inicial
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOWNLOADS_DIR = path.join(__dirname, "downloads");
const PROCESSED_DIR = path.join(DOWNLOADS_DIR, "processed_stems"); // Carpeta para resultados de Moises
const audioPlayer = player({}); // Inicializar play-sound una vez
const { Input, Select, Confirm } = enquirer;

const termWidth = Math.min(process.stdout.columns || 80, 72);
const wrapLine = (text = "") =>
  wrapAnsi(text, termWidth, { hard: false, trim: true });
const voice = {
  say: (text = "") => console.log(wrapLine(text)),
  hint: (text = "") => console.log(dim(wrapLine(text))),
  success: (text = "") => console.log(green(wrapLine(text))),
  warn: (text = "") => console.log(yellow(wrapLine(text))),
  error: (text = "") => console.log(red(wrapLine(text))),
};
const createStatus = (text) =>
  createSpinner(wrapLine(text), { color: "cyan" }).start();
const createCalmProgress = () => {
  return {
    set: (text = "") => logUpdate(wrapLine(text)),
    clear: () => {
      logUpdate.clear();
    },
  };
};
const tidyTitle = (title = "") => title.replace(/\s+/g, " ").trim();
const formatVideoChoice = (video, index) => {
  const durationLabel =
    typeof video.durationSeconds === "number"
      ? formatTime(video.durationSeconds)
      : "??:??";
  return `${index + 1} • ${tidyTitle(video.title)} · ${durationLabel}`;
};

async function promptSearchTerm() {
  voice.say(cyan("bata · drum finder"));
  voice.hint("type an artist, song, or mood");
  const inputPrompt = new Input({
    message: "what do you feel like hearing?",
    validate: (value) =>
      value.trim().length > 0 || "say something so i can search.",
  });
  const value = await inputPrompt.run();
  return value.trim();
}

async function promptVideoSelection(videos) {
  const selectPrompt = new Select({
    message: "pick the take that feels right",
    choices: videos.map((video, index) => ({
      name: formatVideoChoice(video, index),
      value: video,
    })),
    result(value) {
      const choice = this.find(value);
      return choice?.value ?? value;
    },
  });
  return selectPrompt.run();
}

async function promptConfirm(message, initial = true) {
  const confirmPrompt = new Confirm({
    message,
    initial,
  });
  return confirmPrompt.run();
}

// --- Detección de Modo Debug ---
// Comprueba si se pasó el flag --debug
const debugMode = process.argv.includes("--debug");
if (debugMode) {
  console.log(chalk.yellowBright("[MODO DEBUG ACTIVADO]"));
}

// --- Logger Condicional ---
// Función simple para loguear solo en modo debug
const logDebug = (...args) => {
  if (debugMode) {
    console.log(chalk.grey(...args)); // Usar gris para logs de debug
  }
};

/**
 * Recorta texto demasiado largo para loguear sin saturar la consola.
 * @param {string|number|undefined|null} value
 * @param {number} maxLength
 */
const trimForLog = (value, maxLength = 600) => {
  if (value === undefined || value === null) {
    return "<vacío>";
  }
  const str = typeof value === "string" ? value : String(value);
  if (str.length <= maxLength) {
    return str;
  }
  return `${str.slice(0, maxLength)}... (truncado, total ${str.length} chars)`;
};

/**
 * Registro estructurado de etapas para seguir el flujo y errores específicos.
 * @param {string} label
 * @param {string} message
 * @param {any} [payload]
 */
const logStage = (label, message, payload) => {
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

// Asegurarse de que los directorios existan
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  logStage("FS", "created downloads dir", DOWNLOADS_DIR);
}
// No creamos PROCESSED_DIR aquí, moises.downloadJobResults lo hará si es necesario

// Validar API Keys
if (!process.env.YOUTUBE_API_KEY) {
  voice.error("missing YOUTUBE_API_KEY in your .env file.");
  process.exit(1);
}
// ---> Validar API Key de Moises
if (!process.env.MOISES_API_KEY) {
  voice.error("missing MOISES_API_KEY in your .env file.");
  process.exit(1);
}

// Inicializar clientes
const youtube = google.youtube({
  version: "v3",
  auth: process.env.YOUTUBE_API_KEY,
});
// ---> Inicializar cliente Moises
const moises = new Moises({ apiKey: process.env.MOISES_API_KEY });
const MOISES_WORKFLOW_DRUMS = "isolate_drums_bata"; // Workflow para extraer batería

// --- Funciones ---

/**
 * Formatea segundos a MM:SS.
 * @param {number} totalSeconds
 * @returns {string} Tiempo formateado.
 */
function formatTime(totalSeconds) {
  if (isNaN(totalSeconds) || totalSeconds < 0) {
    return "??:??";
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0"
  )}`;
}

function isoDurationToSeconds(duration) {
  if (!duration) return null;
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return null;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Obtiene la duración de un archivo de audio usando ffprobe.
 * @param {string} filePath
 * @returns {Promise<number | null>} Duración en segundos o null si falla.
 */
async function getAudioDuration(filePath) {
  // Comando ffprobe para obtener duración
  const command = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
  logDebug("Ejecutando ffprobe para obtener duración:", command);
  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        logDebug("Error ejecutando ffprobe:", stderr || error.message);
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
        resolve(null); // No fallar, solo devolver null
        return;
      }
      const duration = parseFloat(stdout.trim());
      if (isNaN(duration)) {
        logDebug("ffprobe devolvió una duración no válida:", stdout);
        voice.warn("ffprobe returned an unexpected duration format.");
        resolve(null);
      } else {
        logDebug("Duración obtenida (segundos):", duration);
        resolve(duration);
      }
    });
  });
}

/**
 * Busca videos en YouTube usando la API.
 * @param {string} query Término de búsqueda.
 * @param {number} maxResults Número máximo de resultados.
 * @returns {Promise<Array<{videoId: string, title: string}>>} Lista de videos encontrados.
 */
async function searchVideos(query, maxResults = 5) {
  logStage("YOUTUBE", `Ejecutando búsqueda: "${query}" (max ${maxResults})`);
  try {
    const response = await youtube.search.list({
      part: ["snippet"],
      q: query,
      type: "video",
      maxResults,
    });

    const items =
      response.data.items?.map((item) => ({
        videoId: item.id?.videoId,
        title: item.snippet?.title,
      })) || [];

    const validItems = items.filter((item) => item.videoId && item.title);

    if (validItems.length === 0) {
      return [];
    }

    const ids = validItems.map((item) => item.videoId).join(",");
    const durationsMap = new Map();
    if (ids.length > 0) {
      const durationResponse = await youtube.videos.list({
        part: ["contentDetails"],
        id: ids,
      });
      durationResponse.data.items?.forEach((video) => {
        const seconds = isoDurationToSeconds(
          video.contentDetails?.duration || ""
        );
        durationsMap.set(video.id, seconds);
      });
    }

    return validItems.map((item) => ({
      ...item,
      durationSeconds: durationsMap.get(item.videoId) ?? null,
    }));
  } catch (error) {
    logStage(
      "YOUTUBE-ERROR",
      "Detalles",
      trimForLog(
        error.response?.data?.error?.message || error.message || "sin mensaje"
      )
    );
    throw new Error(
      error.response?.data?.error?.message ||
        error.message ||
        "youtube search failed"
    );
  }
}

/**
 * Descarga el audio de un video de YouTube usando yt-dlp.
 * @param {string} videoId ID del video de YouTube.
 * @param {string} title Título del video para el nombre de archivo.
 * @returns {Promise<string | null>} Ruta al archivo descargado o null si falla.
 */
async function downloadVideoAudio(videoId, title, callbacks = {}) {
  const { onMessage, onProgress } = callbacks;
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  // Nombre de archivo seguro: reemplazar caracteres inválidos
  const safeTitle = title
    .replace(/[\u0000-\u001F\\/?*:|"<>]/g, "_")
    .substring(0, 100); // Limitar longitud y caracteres inválidos
  const outputPath = path.join(DOWNLOADS_DIR, `${safeTitle}.mp3`);

  logStage("DOWNLOAD", `Iniciando descarga de "${title}" (${videoId})`);
  logStage("DOWNLOAD", "videoUrl", videoUrl);
  logStage("DOWNLOAD", "Salida esperada", outputPath);
  logDebug(`URL: ${videoUrl}`);
  logDebug(`Guardando en: ${outputPath}`);

  // Comando yt-dlp simplificado para extraer audio en mp3
  // Asegúrate de que 'yt-dlp' esté en tu PATH o proporciona la ruta completa
  const command = `yt-dlp -x --audio-format mp3 --output "${outputPath}" --no-check-certificates --no-warnings --force-ipv4 "${videoUrl}"`;
  logDebug(`Ejecutando comando: ${command}\n`);

  const stdoutChunks = [];
  const stderrChunks = [];

  return new Promise((resolve, reject) => {
    const downloadProcess = exec(command);

    onMessage?.("pulling audio…");

    downloadProcess.stdout?.on("data", (data) => {
      const chunk = data.toString();
      stdoutChunks.push(chunk);
      if (debugMode) {
        process.stdout.write(chalk.gray(chunk));
        return;
      }

      const percentMatch = chunk.match(/(\d+(?:\.\d+)?)%/);
      if (percentMatch) {
        onProgress?.(parseFloat(percentMatch[1]));
      }
    });

    downloadProcess.stderr?.on("data", (data) => {
      const stderrText = data.toString();
      stderrChunks.push(stderrText);
      if (debugMode) {
        process.stderr.write(chalk.redBright(stderrText));
        logStage("DOWNLOAD-STDERR", trimForLog(stderrText));
      }
    });

    downloadProcess.on("close", (code) => {
      logStage("DOWNLOAD", `yt-dlp finalizó con código ${code}`);
      logStage(
        "DOWNLOAD-TRACE",
        "Stdout acumulado",
        trimForLog(stdoutChunks.join("").trim())
      );
      logStage(
        "DOWNLOAD-TRACE",
        "Stderr acumulado",
        trimForLog(stderrChunks.join("").trim())
      );
      if (code === 0) {
        logStage("DOWNLOAD", "Archivo final", outputPath);
        resolve(outputPath);
      } else {
        reject(
          new Error(
            `yt-dlp exited with code ${code}. run with --debug for details.`
          )
        );
      }
    });

    downloadProcess.on("error", (err) => {
      logStage("DOWNLOAD", "Error lanzando yt-dlp", err.message);
      reject(
        new Error(
          "couldn't start yt-dlp. is it installed and on your path?"
        )
      );
    });
  });
}

// --- Funciones de Music AI (Moises) ---

/**
 * Procesa un archivo de audio con Moises para extraer la batería.
 * @param {string} filePath Ruta al archivo de audio local.
 * @param {string} jobName Nombre para identificar el job en Moises.
 * @returns {Promise<void>}
 */
async function processAudioWithMoises(filePath, jobName, callbacks = {}) {
  const { onPhase } = callbacks;
  const safeJobName = jobName
    .replace(/[\u0000-\u001F\\/?*:|"<>]/g, "_")
    .substring(0, 120);

  try {
    onPhase?.("sending to the studio…");
    logStage("MOISES", "Subiendo archivo", filePath);
    const downloadUrl = await moises.uploadFile(filePath);
    logDebug(`URL temporal: ${downloadUrl}`);

    onPhase?.("setting up the session…");
    logStage("MOISES", "Creando job", safeJobName);
    const jobId = await moises.addJob(safeJobName, MOISES_WORKFLOW_DRUMS, {
      inputUrl: downloadUrl,
    });
    logStage("MOISES", "Job creado", jobId);

    onPhase?.("ai is isolating drums…");
    const job = await moises.waitForJobCompletion(jobId);
    logStage("MOISES", "Job completado", job.status);

    if (job.status !== "SUCCEEDED") {
      throw new Error(
        `moises job ended with status ${job.status.toLowerCase()}`
      );
    }

    onPhase?.("downloading stems…");
    const jobOutputDir = path.join(PROCESSED_DIR, safeJobName);
    if (!fs.existsSync(jobOutputDir)) {
      fs.mkdirSync(jobOutputDir, { recursive: true });
    }
    await moises.downloadJobResults(job, jobOutputDir);
    logStage("MOISES", "Resultados descargados en", jobOutputDir);

    const drumWavFiles = collectDrumStems(jobOutputDir);
    logStage("MOISES", "Stems de batería seleccionados", drumWavFiles);

    return { jobId, jobOutputDir, drumWavFiles };
  } catch (error) {
    logStage(
      "MOISES-ERROR",
      "Detalle",
      trimForLog(error?.message || error)
    );
    throw new Error(
      error?.message || "moises could not finish processing that take."
    );
  }
}

function collectDrumStems(jobOutputDir) {
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
        "[DEBUG] Archivos WAV encontrados en JSON (antes de filtrar):",
        potentialDrumFiles
      );
    } catch (jsonError) {
      logStage("MOISES", "failed parsing workflow.result.json", jsonError.message);
    }
  } else {
    logStage(
      "MOISES",
      "workflow.result.json no encontrado, escaneando carpeta",
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
          "[DEBUG] Archivos WAV encontrados por escaneo (antes de filtrar):",
          potentialDrumFiles
        );
      }
    } catch (readDirError) {
      logStage(
        "MOISES",
        "Error leyendo el directorio de resultados",
        readDirError.message
      );
    }
  }

  return potentialDrumFiles.filter((file) => {
    const fileNameLower = path.basename(file).toLowerCase();
    return fileNameLower !== "other.wav" && fileNameLower !== "combined_drums.wav";
  });
}


// --- Nueva Función ---
/**
 * Combines WAV stems with ffmpeg and returns the resulting path.
 * @param {string[]} wavFiles - Lista de rutas absolutas a los archivos WAV a combinar (ya filtrados).
 * @param {string} outputDir - Directorio donde guardar el archivo combinado.
 */
async function combineDrumStems(wavFiles, outputDir) {
  const combinedFileName = "combined_drums.wav";
  const combinedOutputPath = path.join(outputDir, combinedFileName);

  logStage(
    "FFMPEG",
    "Preparando combinación",
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
    logStage("FFMPEG", "Solo un stem, devolver directamente", wavFiles[0]);
    return wavFiles[0];
  }

  const inputArgs = wavFiles.map((file) => `-i "${file}"`).join(" ");
  const filterComplex = `amix=inputs=${wavFiles.length}:duration=longest`;
  // Usamos -y para sobrescribir el archivo combinado si ya existe
  const command = `ffmpeg ${inputArgs} -filter_complex "${filterComplex}" -y "${combinedOutputPath}"`;

  logStage(
    "FFMPEG",
    "Archivos a combinar",
    wavFiles.map((f) => path.basename(f))
  );
  logStage("FFMPEG", "Comando ffmpeg", command);

  try {
    await new Promise((resolve, reject) => {
      const ffmpegProcess = exec(command, (error, stdout, stderr) => {
        if (debugMode) {
          if (stderr) process.stdout.write(chalk.grey(stderr));
          if (stdout) process.stdout.write(chalk.grey(stdout));
        }
        if (error) {
          if (
            error.message.includes("ENOENT") ||
            error.message.toLowerCase().includes("not found")
          ) {
            return reject(
              new Error("ffmpeg is missing. install it and try again.")
            );
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
      "Fallo al combinar stems",
      trimForLog(error?.message || error)
    );
    throw error;
  }
}

// --- Nueva Función Auxiliar ---
/**
 * Reproduce un archivo de audio usando play-sound y muestra progreso simulado.
 * @param {string} audioFilePath - Ruta absoluta al archivo de audio.
 */
async function playAudioFile(audioFilePath) {
  if (!fs.existsSync(audioFilePath)) {
    voice.error("can't find that file to play.");
    return;
  }

  logStage("PLAY", "Reproduciendo archivo", audioFilePath);
  const baseName = path.basename(audioFilePath);
  let duration = null;
  let progressInterval = null; // Guardar la referencia al intervalo

  try {
    // Intentar obtener duración primero
    duration = await getAudioDuration(audioFilePath);
    const durationStr = duration ? formatTime(duration) : "??:??";

    // Mensaje inicial (será sobrescrito si hay progreso)
    process.stdout.write(
      wrapLine(
        `\nlistening to ${baseName} [00:00 / ${durationStr}] · ctrl+c to stop`
      )
    );

    // Iniciar reproducción
    const playPromise = new Promise((resolve, reject) => {
      const startTime = Date.now();

      // Iniciar intervalo de progreso si tenemos duración
      if (duration) {
        progressInterval = setInterval(() => {
          const elapsedSeconds = (Date.now() - startTime) / 1000;
          // No exceder la duración total en el display
          const currentSeconds = Math.min(elapsedSeconds, duration);
          const currentTimeStr = formatTime(currentSeconds);
          // Usar \r para volver al inicio de la línea y sobrescribir
          process.stdout.write(
            wrapLine(
              `\rlistening to ${baseName} [${currentTimeStr} / ${durationStr}] · ctrl+c to stop `
            )
          ); // Espacio extra al final
        }, 1000); // Actualizar cada segundo
      }

      const audioProcess = audioPlayer.play(audioFilePath, (err) => {
        clearInterval(progressInterval); // Detener intervalo al terminar/error
        // Limpiar la línea de progreso antes de mostrar el mensaje final o error
        process.stdout.write("\r" + " ".repeat(termWidth) + "\r");

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
          logDebug(`Proceso de audio terminado con código: ${code}`);
          // Ya manejamos la finalización en el callback de play()
          // resolve(); No resolver aquí para evitar doble mensaje
        });
        audioProcess.on("error", (error) => {
          clearInterval(progressInterval); // Detener intervalo en error del proceso
          process.stdout.write("\r" + " ".repeat(termWidth) + "\r"); // Limpiar línea
          logDebug(`Error en proceso de audio: ${error}`);
          reject(
            new Error(`Error en el reproductor de audio: ${error.message}`)
          );
        });
      } else {
        clearInterval(progressInterval); // Detener si no hay proceso
        process.stdout.write("\r" + " ".repeat(termWidth) + "\r"); // Limpiar línea
        logDebug("play-sound no devolvió un proceso hijo.");
        reject(new Error("couldn't start the playback process."));
      }
    });

    await playPromise;
  } catch (playError) {
    if (progressInterval) clearInterval(progressInterval); // Asegurarse de limpiar el intervalo en cualquier error
    process.stdout.write("\r" + " ".repeat(termWidth) + "\r"); // Limpiar línea en caso de error
    logStage(
      "PLAY-ERROR",
      "Detalle",
      trimForLog(playError?.message || playError)
    );
    if (!debugMode) {
      voice.warn(playError.message);
    } else {
      console.error(playError);
    }
  }
}

/**
 * Función principal del CLI.
 */
async function main() {
  logStage("MAIN", "Inicio del flujo", { debugMode });

  const query = await promptSearchTerm();

  const searchSpinner = createStatus("looking for it…");
  let videos = [];
  try {
    videos = await searchVideos(query);
    logStage("MAIN", "Resultados obtenidos", videos.length);
    if (videos.length === 0) {
      searchSpinner.error({
        text: wrapLine("couldn't find anything. try another idea."),
      });
      return;
    }
    searchSpinner.success({
      text: wrapLine(`found ${videos.length} takes.`),
    });
  } catch (error) {
    searchSpinner.error({
      text: wrapLine("youtube isn't answering right now."),
    });
    voice.error(error.message);
    return;
  }

  const selectedVideo = await promptVideoSelection(videos);
  if (!selectedVideo) {
    voice.error("couldn't find that take anymore.");
    return;
  }
  logStage(
    "MAIN",
    "Video elegido",
    trimForLog(`${selectedVideo.title} (${selectedVideo.videoId})`)
  );

  voice.say(`pulling “${tidyTitle(selectedVideo.title)}”…`);

  const downloadProgress = createCalmProgress();
  let downloadedFilePath;
  try {
    downloadedFilePath = await downloadVideoAudio(
      selectedVideo.videoId,
      selectedVideo.title,
      {
        onMessage: (text) => downloadProgress.set(text),
        onProgress: (percent) =>
          downloadProgress.set(`pulling audio… ${percent.toFixed(1)}%`),
      }
    );
    downloadProgress.clear();
    voice.success("audio is ready.");
  } catch (error) {
    downloadProgress.clear();
    voice.error(error.message);
    return;
  }
  logStage("MAIN", "Ruta descargada", downloadedFilePath);

  const studioSpinner = createStatus("sending to the studio…");
  let studioResult;
  try {
    studioResult = await processAudioWithMoises(
      downloadedFilePath,
      selectedVideo.title,
      {
        onPhase: (text) =>
          studioSpinner.update({
            text: wrapLine(text),
          }),
      }
    );
    studioSpinner.success({
      text: wrapLine("stems are ready."),
    });
  } catch (error) {
    studioSpinner.error({
      text: wrapLine("the studio couldn't finish that take."),
    });
    voice.error(error.message);
    return;
  }

  const { drumWavFiles, jobOutputDir } = studioResult;
  if (!drumWavFiles.length) {
    voice.warn("couldn't isolate clean drums from that take.");
    return;
  }

  const takeLabel = drumWavFiles.length === 1 ? "take" : "takes";
  voice.say(`${drumWavFiles.length} drum ${takeLabel} ready.`);

  let playbackPath = drumWavFiles[0];

  if (drumWavFiles.length > 1) {
    const shouldBlend = await promptConfirm("blend them into one take?", true);
    if (shouldBlend) {
      const blendSpinner = createStatus("blending the drums…");
      try {
        playbackPath = await combineDrumStems(drumWavFiles, jobOutputDir);
        blendSpinner.success({
          text: wrapLine("one clean drum take ready."),
        });
      } catch (error) {
        blendSpinner.error({
          text: wrapLine("couldn't blend them."),
        });
        voice.warn(error.message);
      }
    }
  }

  const listenNow = await promptConfirm("listen now?", true);
  if (listenNow) {
    await playAudioFile(playbackPath);
  }

  const displayPath = path.relative(__dirname, playbackPath);
  voice.success(`ready. saved to ${displayPath}.`);
  voice.hint("stems live inside downloads/processed_stems if you need them later.");
}

// Ejecutar la función principal
main().catch((err) => {
  if (debugMode) {
    console.error(err);
  } else {
    voice.error(err.message || "something went wrong.");
    voice.hint("run again with --debug for the full trace.");
  }
  process.exit(1);
});
