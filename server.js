import express from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import cors from 'cors'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'

const app = express()
app.use(cors())
app.use(express.json())

const uploadDir = path.join(process.cwd(), 'uploads')
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })
app.use('/uploads', express.static(uploadDir))

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
})
const upload = multer({ storage })

app.post('/api/upload', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' })
  res.json({ filename: path.basename(req.file.path), title: req.body.title || req.file.originalname })
})

app.post('/api/generate-video', async (req, res) => {
  try {
    const { filename, title = 'The Gargantuan' } = req.body || {}
    if (!filename) return res.status(400).json({ error: 'no filename' })
    const inPath = path.join(uploadDir, filename)
    const outName = filename.replace(/\.[^.]+$/, '') + '.mp4'
    const outPath = path.join(uploadDir, outName)

    ffmpeg.setFfmpegPath(ffmpegStatic);

ffmpeg(inPath)
  // Limit FFmpeg resource use
  .outputOptions([
    '-y',
    '-threads 1',
    '-preset ultrafast',
    '-r 24',          // 24 fps
    '-t 60',          // cap video length for test (60s)
  ])
  .complexFilter([
    "[0:a]aformat=channel_layouts=stereo," +
    "showspectrum=s=480x270:mode=combined:scale=log:color=intensity,format=yuv420p[v]"
  ])
  .outputOptions(['-map', '[v]', '-map', '0:a', '-shortest'])
  .videoCodec('libx264')
  .audioCodec('aac')
  .output(outPath)
  .on('end', () => res.json({ output: '/uploads/' + outName }))
  .on('error', err =>
    res.status(500).json({ error: 'ffmpeg failed', details: String(err) })
  )
  .run();
  } catch (err) {
    res.status(500).json({ error: 'server error', details: String(err) })
  }
})

const PORT = process.env.PORT || 10000
app.listen(PORT, () => console.log('Backend listening on', PORT))
