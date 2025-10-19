import dotenv from "dotenv";
import fs from "fs-extra";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import { Configuration, OpenAI } from "openai";
import mime from "mime-types";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_BASE = process.env.API_BASE || "http://localhost:10000";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const UPLOADS_DIR = path.join(__dirname, "uploads");
await fs.ensureDir(UPLOADS_DIR);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ======== Cloudflare R2 Upload Helper ========
async function uploadToR2(filepath) {
  const filename = path.basename(filepath);
  const fileBuffer = await fs.readFile(filepath);
  const mimeType = mime.lookup(filename) || "application/octet-stream";

  const endpoint = `${process.env.R2_ENDPOINT}/${process.env.R2_BUCKET_NAME}/${filename}`;
  const res = await fetch(endpoint, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      "Authorization": `Bearer ${process.env.R2_SECRET_ACCESS_KEY}`
    },
    body: fileBuffer
  });

  if (!res.ok) throw new Error(`R2 upload failed: ${res.status}`);
  return `${process.env.R2_PUBLIC_BASE}/${filename}`;
}

// ======== Main Loop ========
async function processQueue() {
  console.log("Checking queue...");
  const res = await fetch(`${API_BASE}/api/shorts`, {
    headers: { "x-admin-token": ADMIN_TOKEN }
  });
  const jobs = await res.json();
  const queued = jobs.filter(j => j.status === "queued");
  console.log(`Found ${queued.length} jobs.`);

  for (const job of queued) {
    console.log(`Processing ${job.filename}...`);
    const input = path.join(UPLOADS_DIR, job.filename);
    const shortOutput = path.join(UPLOADS_DIR, `short-${job.filename}.mp4`);

    try {
      await new Promise((resolve, reject) => {
        ffmpeg(input)
          .setStartTime(0)
          .setDuration(job.maxSeconds)
          .outputOptions("-vf", "subtitles=auto,format=yuv420p")
          .save(shortOutput)
          .on("end", resolve)
          .on("error", reject);
      });

      // Generate short caption (using OpenAI)
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(input),
        model: "gpt-4o-mini-transcribe"
      });

      const captionText = transcription.text || "Untitled Short";

      // Upload result
      const r2Url = await uploadToR2(shortOutput);

      await fetch(`${API_BASE}/api/shorts/${job.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": ADMIN_TOKEN
        },
        body: JSON.stringify({
          status: "done",
          outputUrl: r2Url,
          caption: captionText
        })
      });

      console.log(`✅ Uploaded short: ${r2Url}`);
    } catch (err) {
      console.error(`❌ Error: ${err.message}`);
    }
  }
}

// ======== Loop Runner ========
(async function loop() {
  while (true) {
    await processQueue();
    await new Promise(r => setTimeout(r, 15000)); // 15s heartbeat
  }
})();
