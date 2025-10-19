import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs-extra";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import ffmpeg from "fluent-ffmpeg";
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "changeme";
const UPLOADS_DIR = path.join(__dirname, "uploads");
await fs.ensureDir(UPLOADS_DIR);

// Multer setup
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// In-memory post and job storage (for now)
let posts = [];
let jobs = [];

// ==== Auth Middleware ====
function auth(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ==== Upload Endpoint ====
app.post("/api/upload", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const filename = req.file.filename;
  const post = {
    id: uuidv4(),
    filename,
    title: filename,
    type: "audio",
    createdAt: Date.now()
  };
  posts.unshift(post);
  res.json(post);
});

// ==== Get Posts ====
app.get("/api/posts", (_, res) => res.json(posts));

// ==== Delete Post ====
app.delete("/api/posts/:id", auth, (req, res) => {
  posts = posts.filter(p => p.id !== req.params.id);
  res.json({ success: true });
});

// ==== Generate Video from Audio ====
app.post("/api/generate-video", auth, async (req, res) => {
  const { filename, title } = req.body;
  const input = path.join(UPLOADS_DIR, filename);
  const output = path.join(UPLOADS_DIR, `${filename}.mp4`);

  if (!fs.existsSync(input))
    return res.status(404).json({ error: "File not found" });

  try {
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(input)
        .complexFilter([
          `showwaves=s=1280x720:mode=cline:colors=${process.env.VIDEO_TEXT_COLOR || "white"}`
        ])
        .outputOptions("-pix_fmt yuv420p")
        .save(output)
        .on("end", resolve)
        .on("error", reject);
    });

    const videoPost = {
      id: uuidv4(),
      filename: `${filename}.mp4`,
      title,
      type: "video",
      createdAt: Date.now()
    };
    posts.unshift(videoPost);
    res.json(videoPost);
  } catch (err) {
    console.error("ffmpeg error", err);
    res.status(500).json({ error: "ffmpeg failed" });
  }
});

// ==== AI Shorts Generation (queued job) ====
app.post("/api/generate-short", auth, (req, res) => {
  const { filename, maxSeconds = 45 } = req.body;
  const job = {
    id: uuidv4(),
    filename,
    status: "queued",
    maxSeconds,
    createdAt: Date.now()
  };
  jobs.push(job);
  res.json(job);
});

app.get("/api/shorts", auth, (_, res) => res.json(jobs));

// ==== Hybrid Worker Check ====
app.get("/api/worker/status", (_, res) => {
  res.json({
    mode: process.env.WORKER_MODE || "render",
    queued: jobs.filter(j => j.status === "queued").length
  });
});

// ==== Local Worker Logic (if running locally) ====
export async function processJobs() {
  const pending = jobs.filter(j => j.status === "queued");
  for (const job of pending) {
    job.status = "processing";
    try {
      const input = path.join(UPLOADS_DIR, job.filename);
      const shortOutput = path.join(UPLOADS_DIR, `short-${job.filename}.mp4`);

      await new Promise((resolve, reject) => {
        ffmpeg(input)
          .setStartTime(0)
          .setDuration(job.maxSeconds)
          .output(shortOutput)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });

      job.status = "done";
      job.output = shortOutput;
    } catch (e) {
      job.status = "failed";
      job.error = e.message;
    }
  }
}

// ==== Startup ====
app.listen(PORT, () =>
  console.log(`Backend running on port ${PORT} (mode=${process.env.WORKER_MODE})`)
);
