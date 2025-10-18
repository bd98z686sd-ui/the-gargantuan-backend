import express from 'express'
import cors from 'cors'
import multer from 'multer'
import * as fs from 'node:fs'
import path from 'node:path'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'

const app = express()
app.use(cors())
app.use(express.json())

// --- Paths & static ---
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
app.use('/uploads', express.static(UPLOAD_DIR))

// --- Multer storage for audio uploads ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // sanitize: replace spaces with dashes
    const safe = file.originalname.replace(/\s+/g, '-')
    cb(null, Date.now() + '-' + safe)
  }
})
const upload = multer({ storage })

// --- Health root ---
app.get('/', (req, res) => {
  res.send('The Gargantuan backend is live.')
})

// --- List posts (audio/video) newest first ---
app.get('/api/posts', (req, res) => {
  try {
    const items = fs.readdirSync(UPLOAD_DIR)
      .filter(f => f.endsWith('.mp3') || f.endsWith('.mp4'))
      .map(filename => {
        const full = path.join(UPLOAD_DIR, filename)
        const stat = fs.statSync(full)
        const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`
        return {
          filename,
          title: filename.replace(/\.[^/.]+$/, ''),
          url: `/uploads/${filename}`,
          absoluteUrl: `${base}/uploads/${filename}`,
          type: filename.endsWith('.mp4') ? 'video' : 'audio',
          date: stat.mtime.toISOString()
        }
      })
      .sort((a,b) => new Date(b.date) - new Date(a.date))

    res.json(items)
  } catch (err) {
    console.error('posts error', err)
    res.status(500).json({ error: 'Could not list uploads' })
  }
})

// --- Upload audio ---
app.post('/api/upload', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be audio)' })
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`
  res.json({
    filename: req.file.filename,
    title: req.body?.title || req.file.originalname,
    url: `/uploads/${req.file.filename}`,
    absoluteUrl: `${base}/uploads/${req.file.filename}`
  })
})

// --- Generate lightweight spectrum video from uploaded audio ---
app.post('/api/generate-video', async (req, res) => {
  try {
    const { filename, title = 'The Gargantuan' } = req.body || {}
    if (!filename) return res.status(400).json({ error: 'filename required' })

    const inPath = path.join(UPLOAD_DIR, filename)
    if (!fs.existsSync(inPath)) return res.status(404).json({ error: 'audio not found' })

    const outName = filename.replace(/\.[^/.]+$/, '') + '.mp4'
    const outPath = path.join(UPLOAD_DIR, outName)

    ffmpeg.setFfmpegPath(ffmpegStatic || undefined)

    ffmpeg(inPath)
      .outputOptions([
        '-y',
        '-threads 1',
        '-preset', 'ultrafast',
        '-r', '24',              // lower fps for speed
        // remove `-t 60` after testing if you want full length
      ])
      .complexFilter([
        "[0:a]aformat=channel_layouts=stereo," +
        "showspectrum=s=480x270:mode=combined:scale=log:color=intensity,format=yuv420p[v]"
      ])
      .outputOptions(['-map', '[v]', '-map', '0:a', '-shortest'])
      .videoCodec('libx264')
      .audioCodec('aac')
      .output(outPath)
      .on('end', () => {
        const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`
        res.json({ output: `/uploads/${outName}`, absoluteUrl: `${base}/uploads/${outName}` })
      })
      .on('error', (err) => {
        console.error('ffmpeg error', err)
        res.status(500).json({ error: 'ffmpeg failed', details: String(err) })
      })
      .run()

  } catch (err) {
    console.error('generate error', err)
    res.status(500).json({ error: 'server error', details: String(err) })
  }
})

// --- Optional debug: list files ---
app.get('/api/list', (req, res) => {
  try {
    const files = fs.readdirSync(UPLOAD_DIR)
    res.json(files)
  } catch (e) {
    res.status(500).json({ error: 'list failed' })
  }
})

const PORT = process.env.PORT || 10000
app.listen(PORT, () => console.log('Backend listening on', PORT))
