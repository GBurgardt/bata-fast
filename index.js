#!/usr/bin/env node

import { google } from "googleapis";
import inquirer from "inquirer";
import dotenv from "dotenv";
import { exec } from "child_process"; // Usaremos exec para llamar a yt-dlp directamente para mejor control
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk"; // Para mejorar la salida en consola
import Moises from "moises/sdk.js"; // <--- Importar SDK de Moises
import player from "play-sound"; // <--- Importar para reproducir audio

// Configuración inicial
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOWNLOADS_DIR = path.join(__dirname, "downloads");
const PROCESSED_DIR = path.join(DOWNLOADS_DIR, "processed_stems"); // Carpeta para resultados de Moises
const audioPlayer = player({}); // Inicializar play-sound una vez

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

// Asegurarse de que los directorios existan
if (!fs.existsSync(DOWNLOADS_DIR)) {
  console.log(
    chalk.yellow(`Creando directorio de descargas en: ${DOWNLOADS_DIR}`)
  );
  fs.mkdirSync(DOWNLOADS_DIR);
}
// No creamos PROCESSED_DIR aquí, moises.downloadJobResults lo hará si es necesario

// Validar API Keys
if (!process.env.YOUTUBE_API_KEY) {
  console.error(
    chalk.red(
      "Error: La variable de entorno YOUTUBE_API_KEY no está configurada."
    )
  );
  console.log(
    chalk.yellow(
      "Asegúrate de tener un archivo .env con YOUTUBE_API_KEY=TU_CLAVE_YOUTUBE"
    )
  );
  process.exit(1);
}
// ---> Validar API Key de Moises
if (!process.env.MOISES_API_KEY) {
  console.error(
    chalk.red(
      "Error: La variable de entorno MOISES_API_KEY no está configurada."
    )
  );
  console.log(
    chalk.yellow(
      "Asegúrate de tener un archivo .env con MOISES_API_KEY=TU_CLAVE_MOISES"
    )
  );
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
 * Busca videos en YouTube usando la API.
 * @param {string} query Término de búsqueda.
 * @param {number} maxResults Número máximo de resultados.
 * @returns {Promise<Array<{videoId: string, title: string}>>} Lista de videos encontrados.
 */
async function searchVideos(query, maxResults = 5) {
  console.log(chalk.blue(`\nBuscando videos para: "${query}"...`));
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

    if (items.length === 0) {
      console.log(chalk.yellow("No se encontraron videos para esa búsqueda."));
      return [];
    }

    // Filtrar resultados inválidos (sin videoId o title)
    return items.filter((item) => item.videoId && item.title);
  } catch (error) {
    console.error(chalk.red("\nError buscando videos en YouTube:"));
    if (debugMode) {
      if (error.response?.data?.error?.message) {
        console.error(
          chalk.red(`  Detalles: ${error.response.data.error.message}`)
        );
        if (error.response.data.error.message.includes("quotaExceeded")) {
          console.warn(
            chalk.yellow(
              "  Parece que has excedido la cuota de la API de YouTube."
            )
          );
        }
      } else {
        console.error(chalk.red(`  Detalles: ${error.message}`));
      }
    } else {
      console.error(
        chalk.yellow("  Ejecuta con --debug para ver más detalles.")
      );
    }
    return []; // Devuelve vacío en caso de error para no detener el flujo principal
  }
}

/**
 * Descarga el audio de un video de YouTube usando yt-dlp.
 * @param {string} videoId ID del video de YouTube.
 * @param {string} title Título del video para el nombre de archivo.
 * @returns {Promise<string | null>} Ruta al archivo descargado o null si falla.
 */
async function downloadVideoAudio(videoId, title) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  // Nombre de archivo seguro: reemplazar caracteres inválidos
  const safeTitle = title
    .replace(/[\u0000-\u001F\\/?*:|"<>]/g, "_")
    .substring(0, 100); // Limitar longitud y caracteres inválidos
  const outputPath = path.join(DOWNLOADS_DIR, `${safeTitle}.mp3`);

  console.log(chalk.blue(`\nDescargando audio para: "${title}"...`));
  logDebug(`URL: ${videoUrl}`);
  logDebug(`Guardando en: ${outputPath}`);

  // Comando yt-dlp simplificado para extraer audio en mp3
  // Asegúrate de que 'yt-dlp' esté en tu PATH o proporciona la ruta completa
  const command = `yt-dlp -x --audio-format mp3 --output "${outputPath}" --no-check-certificates --no-warnings --force-ipv4 "${videoUrl}"`;
  logDebug(`Ejecutando comando: ${command}\n`);

  return new Promise((resolve) => {
    // Cambiado para resolver con outputPath o null
    const downloadProcess = exec(command);

    // Mostrar progreso de yt-dlp (es bastante útil)
    downloadProcess.stdout?.on("data", (data) => {
      // Filtrar algunos mensajes menos útiles si no estamos en debug
      if (
        debugMode ||
        (!data.includes("Destination:") &&
          !data.includes("Deleting original file"))
      ) {
        process.stdout.write(chalk.gray(data));
      }
    });

    // Mostrar errores detallados solo en modo debug
    downloadProcess.stderr?.on("data", (data) => {
      if (debugMode) {
        // En modo debug, mostrar todo stderr (incluso mensajes informativos)
        process.stderr.write(chalk.redBright(data));
      } else {
        // En modo normal, intentar mostrar solo errores reales de stderr, no progreso
        if (
          !data.includes("Deleting original file") &&
          !data.includes("[ExtractAudio]") &&
          !data.includes("[download]") // Filtrar líneas de progreso que a veces van a stderr
        ) {
          process.stderr.write(chalk.red(data));
        }
      }
    });

    downloadProcess.on("close", (code) => {
      if (code === 0) {
        console.log(
          chalk.green(
            `\n¡Descarga completada! Archivo guardado en ${outputPath}`
          )
        );
        resolve(outputPath); // <--- Resuelve con la ruta del archivo
      } else {
        console.error(
          chalk.red(`\nError durante la descarga (código de salida: ${code}).`)
        );
        if (!debugMode) {
          console.error(
            chalk.yellow("  Asegúrate de tener yt-dlp instalado y accesible.")
          );
          console.error(
            chalk.yellow("  Ejecuta con --debug para ver detalles del error.")
          );
        }
        resolve(null); // <--- Resuelve con null si falla
      }
    });

    downloadProcess.on("error", (err) => {
      console.error(chalk.red("\nError al ejecutar el comando de descarga:"));
      if (debugMode) {
        console.error(chalk.red(err));
      }
      console.error(
        chalk.red("Asegúrate de tener yt-dlp instalado y accesible en tu PATH.")
      );
      resolve(null); // <--- Resuelve con null si falla
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
async function processAudioWithMoises(filePath, jobName) {
  console.log(
    chalk.cyan("\n--- Iniciando procesamiento con Music AI (Moises) ---")
  );

  try {
    // 1. Subir archivo a Moises
    console.log(chalk.blue(`Subiendo archivo: ${path.basename(filePath)}...`));
    const downloadUrl = await moises.uploadFile(filePath);
    console.log(chalk.green("Archivo subido con éxito."));
    logDebug(`URL temporal: ${downloadUrl}`);

    // 2. Crear el Job
    console.log(chalk.blue(`Creando job en Moises para extraer batería...`));
    logDebug(`Workflow: ${MOISES_WORKFLOW_DRUMS}`);
    const jobId = await moises.addJob(jobName, MOISES_WORKFLOW_DRUMS, {
      inputUrl: downloadUrl,
    });
    console.log(chalk.green(`Job creado con ID: ${jobId}`));

    // 3. Esperar a que el Job se complete
    console.log(chalk.blue("Procesando audio con IA (esto puede tardar)..."));
    const job = await moises.waitForJobCompletion(jobId);

    // 4. Revisar resultado y descargar
    if (job.status === "SUCCEEDED") {
      console.log(chalk.green("¡Procesamiento IA completado con éxito!"));
      console.log(chalk.blue("Descargando resultados..."));

      // Crear un directorio específico para los resultados de este job
      const jobOutputDir = path.join(
        PROCESSED_DIR,
        jobName.replace(/[\u0000-\u001F\\/?*:|"<>]/g, "_")
      ); // Nombre de carpeta seguro
      if (!fs.existsSync(jobOutputDir)) {
        fs.mkdirSync(jobOutputDir, { recursive: true });
      }

      await moises.downloadJobResults(job, jobOutputDir);
      console.log(chalk.green(`Resultados descargados en: ${jobOutputDir}`));

      const resultJsonPath = path.join(jobOutputDir, "workflow.result.json");
      let potentialDrumFiles = [];
      if (fs.existsSync(resultJsonPath)) {
        try {
          const resultJson = JSON.parse(
            fs.readFileSync(resultJsonPath, "utf-8")
          );
          // Asumir que todos los valores terminados en .wav son stems de batería relevantes
          potentialDrumFiles = Object.values(resultJson)
            .filter(
              (val) =>
                typeof val === "string" && val.toLowerCase().endsWith(".wav")
            )
            .map((relativePath) =>
              path.join(jobOutputDir, path.basename(relativePath))
            ); // Usar basename para asegurar que sea el archivo correcto en jobOutputDir
          logDebug(
            "[DEBUG] Archivos WAV encontrados en JSON (antes de filtrar):",
            potentialDrumFiles
          );
        } catch (jsonError) {
          console.warn(
            chalk.yellow(
              `Advertencia: No se pudo leer ${resultJsonPath}: ${jsonError.message}`
            )
          );
        }
      } else {
        logDebug(
          `No se encontró ${resultJsonPath}. Intentando escanear directorio.`
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
            ) // Excluir el combinado si ya existe
            .map((file) => path.join(jobOutputDir, file));
          if (potentialDrumFiles.length > 0) {
            logDebug(
              "[DEBUG] Archivos WAV encontrados por escaneo (antes de filtrar):",
              potentialDrumFiles
            );
          } else {
            logDebug("No se encontraron archivos .wav en el directorio.");
          }
        } catch (readDirError) {
          console.warn(
            chalk.yellow(
              `Advertencia: Error leyendo el directorio ${jobOutputDir}: ${readDirError.message}`
            )
          );
        }
      }

      const drumWavFiles = potentialDrumFiles.filter((file) => {
        const fileNameLower = path.basename(file).toLowerCase();
        return (
          fileNameLower !== "other.wav" &&
          fileNameLower !== "combined_drums.wav"
        );
      });

      logDebug("[DEBUG] Archivos WAV de batería filtrados:", drumWavFiles);

      // Preguntar al usuario si quiere escuchar
      if (drumWavFiles.length > 1) {
        const { shouldPlay } = await inquirer.prompt([
          {
            type: "confirm",
            name: "shouldPlay",
            message: `Se encontraron ${drumWavFiles.length} stems de batería relevantes. ¿Quieres combinarlos y escucharlos? (Necesitas ffmpeg)`,
            default: false,
          },
        ]);
        if (shouldPlay) {
          await combineAndPlayAudio(drumWavFiles, jobOutputDir);
        }
      } else if (drumWavFiles.length === 1) {
        const { shouldPlaySingle } = await inquirer.prompt([
          {
            type: "confirm",
            name: "shouldPlaySingle",
            message: `Se encontró 1 stem de batería (${path.basename(
              drumWavFiles[0]
            )}). ¿Quieres escucharlo?`,
            default: false,
          },
        ]);
        if (shouldPlaySingle) {
          await playAudioFile(drumWavFiles[0]);
        }
      } else {
        console.log(
          chalk.yellow(
            "No se encontraron archivos de batería (.wav) relevantes para reproducir."
          )
        );
      }

      // (Opcional) Limpiar el job del servidor de Moises
      try {
        await moises.deleteJob(jobId);
        logDebug(`Job ${jobId} eliminado del servidor de Moises.`);
      } catch (deleteError) {
        console.warn(
          chalk.yellow(
            `Advertencia: No se pudo eliminar el job ${jobId} de Moises: ${deleteError.message}`
          )
        );
      }
    } else {
      console.error(
        chalk.red(`El procesamiento de Moises falló con estado: ${job.status}`)
      );
      // Podríamos intentar obtener más detalles del error si la API los proporciona
    }
  } catch (error) {
    console.error(chalk.red("\nError durante el procesamiento con Moises:"));
    if (debugMode && error) {
      console.error(chalk.red(error.message || error));
    } else {
      console.error(
        chalk.yellow(
          "  Verifica tu API Key de Moises, conexión a internet o ejecuta con --debug para detalles."
        )
      );
    }
    logDebug(`Workflow utilizado: ${MOISES_WORKFLOW_DRUMS}`);
    // No relanzamos el error para que el script principal pueda continuar si es posible
  }
  console.log(chalk.cyan("--- Fin del procesamiento con Music AI ---"));
}

// --- Nueva Función ---
/**
 * Combina archivos WAV usando ffmpeg y los reproduce.
 * @param {string[]} wavFiles - Lista de rutas absolutas a los archivos WAV a combinar (ya filtrados).
 * @param {string} outputDir - Directorio donde guardar el archivo combinado.
 */
async function combineAndPlayAudio(wavFiles, outputDir) {
  const combinedFileName = "combined_drums.wav";
  const combinedOutputPath = path.join(outputDir, combinedFileName);

  // La lista wavFiles ya viene filtrada y verificada en la función llamadora
  if (wavFiles.length === 0) {
    console.error(
      chalk.red("Error: No hay archivos WAV válidos para combinar.")
    );
    return;
  }
  if (wavFiles.length === 1) {
    console.warn(
      chalk.yellow(
        "Solo hay 1 archivo WAV relevante. Reproduciendo directamente..."
      )
    );
    await playAudioFile(wavFiles[0]);
    return;
  }

  const inputArgs = wavFiles.map((file) => `-i "${file}"`).join(" ");
  const filterComplex = `amix=inputs=${wavFiles.length}:duration=longest`;
  // Usamos -y para sobrescribir el archivo combinado si ya existe
  const command = `ffmpeg ${inputArgs} -filter_complex "${filterComplex}" -y "${combinedOutputPath}"`;

  console.log(chalk.blue("\nCombinando archivos de batería con ffmpeg..."));
  logDebug(
    `Archivos a combinar: ${wavFiles.map((f) => path.basename(f)).join(", ")}`
  );
  logDebug(`Comando: ${command}`);

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
              new Error(
                `Comando ffmpeg no encontrado. Asegúrate de que ffmpeg esté instalado y en tu PATH.`
              )
            );
          }
          return reject(
            new Error(
              `ffmpeg falló (código ${error.code}). Ejecuta con --debug para ver salida de ffmpeg.`
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
          reject(
            new Error(
              `Comando ffmpeg no encontrado. Asegúrate de que ffmpeg esté instalado y en tu PATH.`
            )
          );
        } else {
          reject(
            new Error(
              `Error ejecutando ffmpeg: ${
                debugMode ? err.message : "Ejecuta con --debug para detalles."
              }`
            )
          );
        }
      });
    });

    console.log(
      chalk.green(`\n¡Archivos combinados con éxito en ${combinedOutputPath}!`)
    );

    // Si la combinación fue exitosa, reproducir
    await playAudioFile(combinedOutputPath);
  } catch (error) {
    console.error(chalk.red(`\nError combinando los archivos de batería:`));
    console.error(chalk.red(`  ${error.message}`));
    // Ya se incluye el mensaje sobre instalar ffmpeg en el propio error
  }
}

// --- Nueva Función Auxiliar ---
/**
 * Reproduce un archivo de audio usando play-sound.
 * @param {string} audioFilePath - Ruta absoluta al archivo de audio.
 */
async function playAudioFile(audioFilePath) {
  if (!fs.existsSync(audioFilePath)) {
    console.error(
      chalk.red(
        `Error: El archivo de audio a reproducir no existe: ${audioFilePath}`
      )
    );
    return;
  }
  console.log(
    chalk.blue(
      `\nReproduciendo: ${path.basename(
        audioFilePath
      )}... (Presiona Ctrl+C para detener)`
    )
  );

  try {
    await new Promise((resolve, reject) => {
      const audioProcess = audioPlayer.play(audioFilePath, (err) => {
        if (err) {
          // Simplificar error si no estamos en debug
          let errorMsg = err.message;
          if (
            !debugMode &&
            (err.message.includes("Couldn't find a suitable audio player") ||
              err.message.toLowerCase().includes("no such file") ||
              err.code === "ENOENT")
          ) {
            errorMsg =
              "No se encontró un reproductor de audio compatible (afplay, mplayer, etc.)";
          }
          reject(new Error(errorMsg));
        } else {
          // La reproducción puede terminar inmediatamente si se lanza en segundo plano
          // No marcamos como finalizada aquí, el usuario debe detenerla o esperar
          resolve();
        }
      });

      // Loguear si el proceso de audio termina o da error (útil en debug)
      if (audioProcess) {
        audioProcess.on("close", (code) => {
          logDebug(`Proceso de audio terminado con código: ${code}`);
          console.log(chalk.green("Reproducción finalizada."));
        });
        audioProcess.on("error", (error) => {
          logDebug(`Error en proceso de audio: ${error}`);
          reject(
            new Error(`Error en el reproductor de audio: ${error.message}`)
          );
        });
      } else {
        // Si play() no devuelve un proceso (raro), resolver para no bloquear
        logDebug("play-sound no devolvió un proceso hijo.");
        resolve();
      }
    });
  } catch (playError) {
    console.error(chalk.red(`\nError reproduciendo el archivo de audio:`));
    console.error(chalk.red(`  ${playError.message}`));
    if (!debugMode && playError.message.includes("compatible")) {
      console.error(
        chalk.yellow(
          "  Asegúrate de tener un reproductor como 'afplay' (macOS) o 'mplayer'/'aplay' (Linux) instalado."
        )
      );
    }
  }
}

/**
 * Función principal del CLI.
 */
async function main() {
  console.log(
    chalk.bold.cyan("--- Buscador y Extractor de Baterías de YouTube ---")
  );

  // 1. Obtener término de búsqueda
  const { query } = await inquirer.prompt([
    {
      type: "input",
      name: "query",
      message: "Ingresa tu búsqueda en YouTube:",
      validate: (input) =>
        input.trim() !== "" || "Por favor, ingresa algo para buscar.",
    },
  ]);

  // 2. Buscar videos
  const videos = await searchVideos(query.trim());

  if (!videos || videos.length === 0) {
    console.log(chalk.magenta("\nTerminando ejecución."));
    return;
  }

  // 3. Mostrar resultados y permitir selección
  const { selectedVideoId } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedVideoId",
      message: "Selecciona un video:",
      choices: videos.map((video, index) => ({
        name: `${index + 1}. ${video.title}`,
        value: video.videoId,
      })),
    },
  ]);

  // 4. Obtener el título del video seleccionado
  const selectedVideo = videos.find((v) => v.videoId === selectedVideoId);
  if (!selectedVideo) {
    console.error(
      chalk.red("Error: No se pudo encontrar el video seleccionado.")
    );
    return;
  }

  // 5. Descargar el audio del video seleccionado
  const downloadedFilePath = await downloadVideoAudio(
    selectedVideo.videoId,
    selectedVideo.title
  );

  // 6. Procesar con Moises si la descarga fue exitosa
  if (downloadedFilePath) {
    const jobName = selectedVideo.title
      .replace(/[\u0000-\u001F\\/?*:|"<>]/g, "_")
      .substring(0, 100);
    await processAudioWithMoises(downloadedFilePath, jobName);
  } else {
    console.log(
      chalk.magenta("\nDescarga fallida, no se puede procesar con IA.")
    );
  }

  console.log(chalk.magenta("\n¡Proceso finalizado!"));
}

// Ejecutar la función principal
main().catch((err) => {
  console.error(chalk.red("\nError inesperado en la ejecución principal:"));
  console.error(chalk.red(debugMode ? err : err.message)); // Mostrar stack trace solo en debug
  if (!debugMode) {
    console.error(
      chalk.yellow("Ejecuta con --debug para ver el stack trace completo.")
    );
  }
  process.exit(1);
});
