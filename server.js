import express from 'express'
import cors from 'cors'
import multer from 'multer'
import * as fs from 'node:fs'
import path from 'node:path'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import { S3Client, PutObjectCommand, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import crypto from 'node:crypto'

const app = express()
app.use(cors())
app.use(express.json())

const S3_ENABLED = !!process.env.S3_ENDPOINT
const s3 = S3_ENABLED ? new S3Client({
  region: 'auto',
  endpoint: process.env.S3_ENDPOINT,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
  forcePathStyle: true
}) : null
const S3_BUCKET = process.env.S3_BUCKET
const S3_PUBLIC_BASE = process.env.S3_PUBLIC_BASE

function keyPosts(filename){ return `posts/${filename}` }
function keyTrash(filename){ return `posts/.trash/${filename}` }
const META_KEY = 'posts/_meta.json'

async function r2PutStream(stream, key, contentType){
  if (!S3_ENABLED) return null
  await s3.send(new PutObjectCommand({ Bucket:S3_BUCKET, Key:key, Body:stream, ContentType:contentType }))
  return S3_PUBLIC_BASE ? `${S3_PUBLIC_BASE}/${key}` : null
}
async function r2PutFile(localPath, key, contentType){
  const rs = fs.createReadStream(localPath)
  return r2PutStream(rs, key, contentType)
}
async function r2List(prefix='posts/'){
  const out = await s3.send(new ListObjectsV2Command({ Bucket:S3_BUCKET, Prefix:prefix }))
  return (out.Contents||[]).map(o=>o.Key)
}
async function r2Copy(srcKey, dstKey){
  await s3.send(new CopyObjectCommand({ Bucket:S3_BUCKET, CopySource:`${S3_BUCKET}/${srcKey}`, Key:dstKey }))
}
async function r2Delete(key){
  await s3.send(new DeleteObjectCommand({ Bucket:S3_BUCKET, Key:key }))
}
async function r2GetText(key){
  const obj = await s3.send(new GetObjectCommand({ Bucket:S3_BUCKET, Key:key }))
  return await obj.Body.transformToString()
}
async function r2PutText(key, text){
  await s3.send(new PutObjectCommand({ Bucket:S3_BUCKET, Key:key, Body:text, ContentType:'application/json' }))
}


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
// --- Metadata helpers (stored in R2) ---
async function readMeta() {
  if (!S3_ENABLED) return {}
  try { return JSON.parse(await r2GetText(META_KEY)) } catch { return {} }
}
async function writeMeta(meta) {
  await r2PutText(META_KEY, JSON.stringify(meta, null, 2))
}

function baseUrl(req){
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`
}

async function listFromDir(isTrash, req){
  const prefix = isTrash ? 'posts/.trash/' : 'posts/'
  const keys = await r2List(prefix)
  const meta = await readMeta()
  const items = []
  for (const key of keys){
    if (!key.endsWith('.mp3') && !key.endsWith('.mp4')) continue
    const filename = key.split('/').pop()
    const baseName = filename.replace(/\.[^/.]+$/, '')
    const title = meta[baseName]?.title || baseName
    items.push({
      filename,
      title,
      url: `${S3_PUBLIC_BASE}/${key}`,
      absoluteUrl: `${S3_PUBLIC_BASE}/${key}`,
      r2Url: `${S3_PUBLIC_BASE}/${key}`,
      type: filename.endsWith('.mp4') ? 'video' : 'audio',
      date: new Date().toISOString()
    })
  }
  items.sort((a,b)=> new Date(b.date)-new Date(a.date))
  return items
}
function moveFile(from, to){
  fs.renameSync(from, to)
}

// --- Health ---
app.get('/', (_req, res) => res.send('The Gargantuan backend is live.'))
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// --- Lists
app.get('/api/posts', async (req, res) => {
  try { res.json(await listFromDir(false, req)) } catch(e){ console.error(e); res.status(500).json({ error: 'list failed' }) }
})
app.get('/api/trash', async (req, res) => {
  try { res.json(await listFromDir(true, req)) } catch(e){ console.error(e); res.status(500).json({ error: 'list failed' }) }
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

// --- Image upload to R2 ---
app.post('/api/images/upload', requireAdmin, multer({ dest: UPLOAD_DIR }).single('image'), async (req, res) => {
  try{
    if (!req.file) return res.status(400).json({ error: 'missing image' })
    const ext = (req.file.originalname.split('.').pop()||'png').toLowerCase()
    const safe = ext.replace(/[^a-z0-9]/g,'') || 'png'
    const key = `images/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${safe}`
    const ct = req.file.mimetype || 'application/octet-stream'
    const url = await r2PutFile(req.file.path, key, ct)
    fs.existsSync(req.file.path) && fs.unlinkSync(req.file.path)
    res.json({ ok:true, url, key })
  }catch(e){ console.error('image upload error', e); res.status(500).json({ error: 'image upload failed' }) }
})
