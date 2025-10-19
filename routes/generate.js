import express from "express";
import ffmpeg from "fluent-ffmpeg";
import path from "path";
import fs from "fs-extra";

const router = express.Router();
const UPLOADS_DIR = path.resolve("uploads");

router.post("/", async (req, res) => {
  const { filename } = req.body;
  const input = path.join(UPLOADS_DIR, filename);
  const output = path.join(UPLOADS_DIR, `${filename}.mp4`);
  if (!fs.existsSync(input)) return res.status(404).json({ error: "File not found" });

  try {
    await new Promise((resolve, reject) => {
      ffmpeg(input)
        .complexFilter(["showwaves=s=1280x720:mode=cline:colors=white"])
        .outputOptions("-pix_fmt yuv420p")
        .save(output)
        .on("end", resolve)
        .on("error", reject);
    });
    res.json({ output });
  } catch (err) {
    res.status(500).json({ error: "Video generation failed" });
  }
});

export default router;
