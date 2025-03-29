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

// Configuración inicial
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOWNLOADS_DIR = path.join(__dirname, "downloads");
const PROCESSED_DIR = path.join(DOWNLOADS_DIR, "processed_stems"); // Carpeta para resultados de Moises

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
    if (error.response?.data?.error?.message) {
      console.error(chalk.red(`  ${error.response.data.error.message}`));
      if (error.response.data.error.message.includes("quotaExceeded")) {
        console.warn(
          chalk.yellow(
            "  Parece que has excedido la cuota de la API de YouTube."
          )
        );
      }
    } else {
      console.error(chalk.red(`  ${error.message}`));
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

  console.log(chalk.blue(`\nIniciando descarga de audio para: "${title}"`));
  console.log(chalk.dim(`URL: ${videoUrl}`));
  console.log(chalk.dim(`Guardando en: ${outputPath}`));

  // Comando yt-dlp simplificado para extraer audio en mp3
  // Asegúrate de que 'yt-dlp' esté en tu PATH o proporciona la ruta completa
  const command = `yt-dlp -x --audio-format mp3 --output "${outputPath}" --no-check-certificates --no-warnings --force-ipv4 "${videoUrl}"`;

  console.log(chalk.dim(`Ejecutando comando: ${command}\n`));

  return new Promise((resolve) => {
    // Cambiado para resolver con outputPath o null
    const downloadProcess = exec(command);

    // Mostrar salida estándar (progreso de yt-dlp)
    downloadProcess.stdout?.on("data", (data) => {
      process.stdout.write(chalk.gray(data)); // Mostrar progreso en gris
    });

    // Mostrar errores
    downloadProcess.stderr?.on("data", (data) => {
      // Ignorar mensajes comunes que no son errores fatales
      if (
        !data.includes("Deleting original file") &&
        !data.includes("[ExtractAudio]") &&
        !data.includes("[download] Destination:") // Ignorar mensaje de destino
      ) {
        process.stderr.write(chalk.red(data));
      } else {
        process.stdout.write(chalk.gray(data)); // Mostrar mensajes informativos de stderr en gris
      }
    });

    downloadProcess.on("close", (code) => {
      if (code === 0) {
        console.log(
          chalk.green(
            `\n¡Descarga completada con éxito! Archivo guardado en ${outputPath}`
          )
        );
        resolve(outputPath); // <--- Resuelve con la ruta del archivo
      } else {
        console.error(
          chalk.red(`\nError durante la descarga (código de salida: ${code}).`)
        );
        console.error(
          chalk.red(
            "Asegúrate de tener yt-dlp instalado y accesible en tu PATH."
          )
        );
        console.error(
          chalk.red(
            "Puedes instalarlo con: pip install yt-dlp  o  brew install yt-dlp"
          )
        );
        resolve(null); // <--- Resuelve con null si falla
      }
    });

    downloadProcess.on("error", (err) => {
      console.error(
        chalk.red("\nError al ejecutar el comando de descarga:"),
        err
      );
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
    console.log(chalk.dim(`URL temporal: ${downloadUrl}`));

    // 2. Crear el Job
    console.log(chalk.blue(`Creando job en Moises para extraer batería...`));
    console.log(chalk.dim(`Workflow: ${MOISES_WORKFLOW_DRUMS}`));
    const jobId = await moises.addJob(jobName, MOISES_WORKFLOW_DRUMS, {
      inputUrl: downloadUrl,
    });
    console.log(chalk.green(`Job creado con ID: ${jobId}`));

    // 3. Esperar a que el Job se complete
    console.log(
      chalk.blue(
        "Esperando a que Moises procese el audio (esto puede tardar)..."
      )
    );
    // Podríamos implementar un polling manual con getJob para mostrar progreso,
    // pero waitForJobCompletion es más simple por ahora.
    const job = await moises.waitForJobCompletion(jobId);

    // 4. Revisar resultado y descargar
    if (job.status === "SUCCEEDED") {
      console.log(
        chalk.green("¡Procesamiento de Moises completado con éxito!")
      );
      console.log(chalk.blue("Descargando resultados..."));

      // Crear un directorio específico para los resultados de este job
      const jobOutputDir = path.join(
        PROCESSED_DIR,
        jobName.replace(/[\u0000-\u001F\\/?*:|"<>]/g, "_")
      ); // Nombre de carpeta seguro
      if (!fs.existsSync(jobOutputDir)) {
        fs.mkdirSync(jobOutputDir, { recursive: true });
      }

      const resultPaths = await moises.downloadJobResults(job, jobOutputDir);
      console.log(chalk.green(`Resultados descargados en: ${jobOutputDir}`));
      console.log(chalk.dim(`Archivos: ${resultPaths.join(", ")}`));

      // (Opcional) Limpiar el job del servidor de Moises
      try {
        await moises.deleteJob(jobId);
        console.log(
          chalk.dim(`Job ${jobId} eliminado del servidor de Moises.`)
        );
      } catch (deleteError) {
        console.warn(
          chalk.yellow(
            `No se pudo eliminar el job ${jobId} de Moises: ${deleteError.message}`
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
    if (error.message) {
      console.error(chalk.red(`  ${error.message}`));
    } else {
      console.error(chalk.red("  Ocurrió un error inesperado."), error);
    }
    console.error(
      chalk.yellow("  Verifica tu API Key de Moises y la conexión a internet.")
    );
    console.error(
      chalk.yellow(`  Workflow utilizado: ${MOISES_WORKFLOW_DRUMS}`)
    );
    // No relanzamos el error para que el script principal pueda continuar si es posible
  }
  console.log(chalk.cyan("--- Fin del procesamiento con Music AI ---"));
}

/**
 * Función principal del CLI.
 */
async function main() {
  console.log(
    chalk.bold.cyan(
      "--- CLI de Búsqueda, Descarga y Procesamiento de Batería ---"
    )
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
    console.log(
      chalk.magenta("\nNo se encontraron videos. Terminando ejecución.")
    );
    return; // Salir si no hay resultados o hubo error
  }

  // 3. Mostrar resultados y permitir selección
  const { selectedVideoId } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedVideoId",
      message:
        "Selecciona un video para descargar el audio y extraer la batería:",
      choices: videos.map((video, index) => ({
        name: `${index + 1}. ${video.title}`, // Mostrar título
        value: video.videoId, // El valor será el ID del video
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

  // 6. Si la descarga fue exitosa, procesar con Moises
  if (downloadedFilePath) {
    try {
      // Usar el título del video (sanitizado) como nombre del job
      const jobName = selectedVideo.title
        .replace(/[\u0000-\u001F\\/?*:|"<>]/g, "_")
        .substring(0, 100);
      await processAudioWithMoises(downloadedFilePath, jobName);
    } catch (moisesError) {
      // El error ya se maneja dentro de processAudioWithMoises
      console.log(
        chalk.magenta(
          "\nTerminando ejecución debido a error en el procesamiento de IA."
        )
      );
    }
  } else {
    console.log(
      chalk.magenta(
        "\nNo se pudo descargar el audio, omitiendo procesamiento de IA."
      )
    );
  }

  console.log(chalk.magenta("\n¡Proceso finalizado!"));
}

// Ejecutar la función principal
main();
