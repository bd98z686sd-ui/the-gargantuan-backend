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

// --- Static uploads directory ---
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
app.use('/uploads', express.static(UPLOAD_DIR))

// --- Multer storage (sanitize filename) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, '-')
    cb(null, Date.now() + '-' + safe)
  }
})
const upload = multer({ storage })

// --- Admin token middleware ---
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN
  if (!expected) return next() // if no token set, allow
  const provided = req.get('x-admin-token')
  if (provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
}

// --- Health ---
app.get('/', (_req, res) => res.send('The Gargantuan backend is live.'))
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// --- List posts (mp3 + mp4), newest first ---
app.get('/api/posts', (req, res) => {
  try {
    const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`
    const items = fs.readdirSync(UPLOAD_DIR)
      .filter(f => f.endsWith('.mp3') || f.endsWith('.mp4'))
      .map(filename => {
        const full = path.join(UPLOAD_DIR, filename)
        const stat = fs.statSync(full)
        return {
          filename,
          title: filename.replace(/\.[^/.]+$/, ''),
          url: `/uploads/${filename}`,
          absoluteUrl: `${base}/uploads/${filename}`,
          type: filename.endsWith('.mp4') ? 'video' : 'audio',
          date: stat.mtime.toISOString()
        }
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date))

    res.json(items)
  } catch (e) {
    console.error('posts error', e)
    res.status(500).json({ error: 'Could not list uploads' })
  }
})

// --- Upload audio (protected if ADMIN_TOKEN is set) ---
app.post('/api/upload', requireAdmin, upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name must be audio)' })
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`
  res.json({
    filename: req.file.filename,
    title: req.body?.title || req.file.originalname,
    url: `/uploads/${req.file.filename}`,
    absoluteUrl: `${base}/uploads/${req.file.filename}`
  })
})

// --- Generate spectrum video from audio (protected if ADMIN_TOKEN is set) ---
app.post('/api/generate-video', requireAdmin, async (req, res) => {
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
        '-threads', '1',
        '-preset', 'ultrafast',
        '-r', '24'
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

// --- Optional debug ---
app.get('/api/list', (_req, res) => {
  try {
    const files = fs.readdirSync(UPLOAD_DIR)
    res.json(files)
  } catch (e) {
    res.status(500).json({ error: 'list failed' })
  }
})

const PORT = process.env.PORT || 10000
app.listen(PORT, () => console.log('Backend listening on', PORT))
