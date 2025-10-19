import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs-extra";

const router = express.Router();
const UPLOADS_DIR = path.resolve("uploads");
await fs.ensureDir(UPLOADS_DIR);

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

router.post("/", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  res.json({ filename: req.file.filename, type: req.file.mimetype });
});

export default router;
