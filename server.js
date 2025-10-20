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

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads')
const TRASH_DIR = path.join(UPLOAD_DIR, '.trash')
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
if (!fs.existsSync(TRASH_DIR)) fs.mkdirSync(TRASH_DIR, { recursive: true })
app.use('/uploads', express.static(UPLOAD_DIR))

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, '-')
    cb(null, Date.now() + '-' + safe)
  }
})
const upload = multer({ storage })

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN
  if (!expected) return next()
  const provided = req.get('x-admin-token')
  if (provided !== expected) return res.status(401).json({ error: 'unauthorized' })
  next()
}

// --- Metadata helpers ---
const META_PATH = path.join(UPLOAD_DIR, "_meta.json")
function readMeta() {
  try { return JSON.parse(fs.readFileSync(META_PATH, "utf-8")) } catch { return {} }
}
function writeMeta(meta) {
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2))
}

function baseUrl(req){
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`
}

function listFromDir(dir, req){
  const meta = readMeta()
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.mp3') || f.endsWith('.mp4'))
    .map(filename => {
      const full = path.join(dir, filename)
      const stat = fs.statSync(full)
      const baseName = filename.replace(/\.[^/.]+$/, '')
      const title = meta[baseName]?.title || baseName
      const isTrash = dir === TRASH_DIR
      return {
        filename,
        title,
        url: `/uploads/${isTrash ? '.trash/' : ''}${filename}`,
        absoluteUrl: `${baseUrl(req)}/uploads/${isTrash ? '.trash/' : ''}${filename}`,
        type: filename.endsWith('.mp4') ? 'video' : 'audio',
        date: stat.mtime.toISOString()
      }
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date))
}

function moveFile(from, to){
  fs.renameSync(from, to)
}

// --- Health ---
app.get('/', (_req, res) => res.send('The Gargantuan backend is live.'))
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// --- Lists ---
app.get('/api/posts', (req, res) => {
  try { res.json(listFromDir(UPLOAD_DIR, req)) }
  catch (e) { console.error(e); res.status(500).json({ error: 'Could not list uploads' }) }
})
app.get('/api/trash', requireAdmin, (req, res) => {
  try { res.json(listFromDir(TRASH_DIR, req)) }
  catch (e) { console.error(e); res.status(500).json({ error: 'Could not list trash' }) }
})

// --- Upload & generate ---
app.post('/api/upload', requireAdmin, upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
  res.json({ filename: req.file.filename, title: req.file.originalname, url: `/uploads/${req.file.filename}`, absoluteUrl: `${baseUrl(req)}/uploads/${req.file.filename}` })
})

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
      .outputOptions(['-y', '-threads', '1', '-preset', 'ultrafast', '-r', '24'])
      .complexFilter(["[0:a]aformat=channel_layouts=stereo,showspectrum=s=480x270:mode=combined:scale=log:color=intensity,format=yuv420p[v]"])
      .outputOptions(['-map', '[v]', '-map', '0:a', '-shortest'])
      .videoCodec('libx264')
      .audioCodec('aac')
      .output(outPath)
      .on('end', () => res.json({ output: `/uploads/${outName}`, absoluteUrl: `${baseUrl(req)}/uploads/${outName}` }))
      .on('error', (err) => { console.error('ffmpeg error', err); res.status(500).json({ error: 'ffmpeg failed', details: String(err) }) })
      .run()
  } catch (err) {
    console.error('generate error', err)
    res.status(500).json({ error: 'server error', details: String(err) })
  }
})

// --- Edit title ---
app.patch('/api/posts/:id', requireAdmin, (req, res) => {
  try {
    const id = req.params.id
    const baseName = id.replace(/\.[^/.]+$/, '')
    const body = req.body || {}
    const meta = readMeta()
    if (body.title && typeof body.title === 'string') {
      meta[baseName] = { ...(meta[baseName] || {}), title: body.title }
      writeMeta(meta)
      return res.json({ ok: true, id: baseName, title: body.title })
    }
    res.status(400).json({ error: 'Nothing to update' })
  } catch (e) {
    console.error('patch error', e)
    res.status(500).json({ error: 'update failed' })
  }
})

// --- Soft delete to .trash ---
app.delete('/api/posts/:id', requireAdmin, (req, res) => {
  try {
    const id = req.params.id
    const baseName = id.replace(/\.[^/.]+$/, '')
    const candidates = [`${baseName}.mp3`, `${baseName}.mp4`]
    let moved = []
    for (const f of candidates) {
      const src = path.join(UPLOAD_DIR, f)
      const dst = path.join(TRASH_DIR, f)
      if (fs.existsSync(src)) { moveFile(src, dst); moved.push(f) }
    }
    if (moved.length === 0) return res.status(404).json({ error: 'not found' })
    res.json({ ok: true, moved })
  } catch (e) {
    console.error('soft delete error', e)
    res.status(500).json({ error: 'delete failed' })
  }
})

// --- Restore from trash ---
app.post('/api/posts/:id/restore', requireAdmin, (req, res) => {
  try {
    const id = req.params.id
    const baseName = id.replace(/\.[^/.]+$/, '')
    const candidates = [`${baseName}.mp3`, `${baseName}.mp4`]
    let restored = []
    for (const f of candidates) {
      const src = path.join(TRASH_DIR, f)
      const dst = path.join(UPLOAD_DIR, f)
      if (fs.existsSync(src)) { moveFile(src, dst); restored.push(f) }
    }
    if (restored.length === 0) return res.status(404).json({ error: 'not found in trash' })
    res.json({ ok: true, restored })
  } catch (e) {
    console.error('restore error', e)
    res.status(500).json({ error: 'restore failed' })
  }
})

// --- Hard delete from trash ---
app.delete('/api/trash/:id', requireAdmin, (req, res) => {
  try {
    const id = req.params.id
    const baseName = id.replace(/\.[^/.]+$/, '')
    const candidates = [`${baseName}.mp3`, `${baseName}.mp4`]
    let removed = []
    for (const f of candidates) {
      const p = path.join(TRASH_DIR, f)
      if (fs.existsSync(p)) { fs.unlinkSync(p); removed.push(f) }
    }
    // optionally also remove metadata
    const meta = readMeta()
    if (meta[baseName]) { delete meta[baseName]; writeMeta(meta) }
    if (removed.length === 0) return res.status(404).json({ error: 'not found in trash' })
    res.json({ ok: true, removed })
  } catch (e) {
    console.error('hard delete error', e)
    res.status(500).json({ error: 'hard delete failed' })
  }
})

// --- Bulk operations ---
app.post('/api/posts/bulk-delete', requireAdmin, (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return res.status(400).json({ error: 'ids required' })
    let results = []
    for (const id of ids) {
      const baseName = id.replace(/\.[^/.]+$/, '')
      const candidates = [`${baseName}.mp3`, `${baseName}.mp4`]
      let moved = []
      for (const f of candidates) {
        const src = path.join(UPLOAD_DIR, f)
        const dst = path.join(TRASH_DIR, f)
        if (fs.existsSync(src)) { moveFile(src, dst); moved.push(f) }
      }
      results.push({ id: baseName, moved })
    }
    res.json({ ok: true, results })
  } catch (e) {
    console.error('bulk delete error', e)
    res.status(500).json({ error: 'bulk delete failed' })
  }
})

app.post('/api/trash/bulk-restore', requireAdmin, (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : []
    if (!ids.length) return res.status(400).json({ error: 'ids required' })
    let results = []
    for (const id of ids) {
      const baseName = id.replace(/\.[^/.]+$/, '')
      const candidates = [`${baseName}.mp3`, `${baseName}.mp4`]
      let restored = []
      for (const f of candidates) {
        const src = path.join(TRASH_DIR, f)
        const dst = path.join(UPLOAD_DIR, f)
        if (fs.existsSync(src)) { moveFile(src, dst); restored.push(f) }
      }
      results.push({ id: baseName, restored })
    }
    res.json({ ok: true, results })
  } catch (e) {
    console.error('bulk restore error', e)
    res.status(500).json({ error: 'bulk restore failed' })
  }
})

const PORT = process.env.PORT || 10000
app.listen(PORT, () => console.log('Backend listening on', PORT))
