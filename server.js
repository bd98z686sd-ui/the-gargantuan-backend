import express from 'express'
import cors from 'cors'
import multer from 'multer'
import path from 'node:path'
import * as fs from 'node:fs'
import os from 'node:os'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'
import OpenAI from 'openai'
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'

const app = express()
app.use(cors())
app.use(express.json())

const ADMIN_TOKEN = process.env.ADMIN_TOKEN
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next()
  const provided = req.get('x-admin-token')
  if (provided !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' })
  next()
}

// ==== R2 / S3 CONFIG ====
const S3_ENDPOINT = process.env.S3_ENDPOINT
const S3_REGION = process.env.S3_REGION || 'auto'
const S3_BUCKET = process.env.S3_BUCKET
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY
const S3_PUBLIC_BASE = process.env.S3_PUBLIC_BASE || ''
const S3_FORCE_PATH_STYLE = String(process.env.S3_FORCE_PATH_STYLE).toLowerCase() === 'true'

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: S3_FORCE_PATH_STYLE,
  credentials: { accessKeyId: S3_ACCESS_KEY_ID || '', secretAccessKey: S3_SECRET_ACCESS_KEY || '' }
})

function publicUrlForKey(key) {
  if (S3_PUBLIC_BASE) return `${S3_PUBLIC_BASE}/${encodeURI(key)}`
  return `${S3_ENDPOINT}/${S3_BUCKET}/${encodeURI(key)}`
}

async function s3UploadBuffer(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: buffer, ContentType: contentType }))
}

async function s3GetToFile(key, outPath) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }))
  const stream = resp.Body
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(outPath)
    Readable.from(stream).pipe(w)
    w.on('finish', resolve); w.on('error', reject)
  })
}

async function s3GetText(key) {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }))
    const chunks = []
    for await (const chunk of resp.Body) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf-8')
  } catch {
    return null
  }
}

async function s3List(prefix) {
  const out = []
  let ContinuationToken = undefined
  do {
    const resp = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken }))
    ;(resp.Contents || []).forEach(o => out.push(o))
    ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined
  } while (ContinuationToken)
  return out
}

// ==== METADATA ====
const META_KEY = 'meta/_posts.json'
async function readMeta() {
  const txt = await s3GetText(META_KEY)
  if (!txt) return { items: {}, deleted: {} }
  try { const m = JSON.parse(txt); return { items: m.items||{}, deleted: m.deleted||{} } } catch { return { items: {}, deleted: {} } }
}
async function writeMeta(m) {
  const buf = Buffer.from(JSON.stringify(m, null, 2))
  await s3UploadBuffer(META_KEY, buf, 'application/json')
}

// ==== JOB STORAGE (durable) ====
function uid(){ return Math.random().toString(36).slice(2) + Date.now().toString(36) }
const VIDEO_JOBS_KEY = 'meta/_video_jobs.json'
async function readVideoJobs(){
  const txt = await s3GetText(VIDEO_JOBS_KEY)
  if(!txt) return { queue: [], items: {} }
  try { return JSON.parse(txt) } catch { return { queue: [], items: {} } }
}
async function writeVideoJobs(j){
  const buf = Buffer.from(JSON.stringify(j, null, 2))
  await s3UploadBuffer(VIDEO_JOBS_KEY, buf, 'application/json')
}

// ==== ROUTES ====
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// Upload
const upload = multer({ storage: multer.memoryStorage() })
app.post('/api/upload', requireAdmin, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const safe = (req.file.originalname || 'audio.mp3').replace(/\s+/g, '-')
    const key = `audio/${Date.now()}-${safe}`
    await s3UploadBuffer(key, req.file.buffer, req.file.mimetype || 'audio/mpeg')
    res.json({ key, url: publicUrlForKey(key) })
  } catch (e) {
    console.error('upload error', e)
    res.status(500).json({ error: 'upload failed' })
  }
})

// Meta
app.post('/api/meta', requireAdmin, async (req, res) => {
  try {
    const { filename, title, tagline } = req.body || {}
    if (!filename) return res.status(400).json({ error: 'filename required' })
    const meta = await readMeta()
    meta.items[filename] = { title: title || '', tagline: tagline || '' }
    await writeMeta(meta)
    res.json({ ok: true })
  } catch (e) {
    console.error('meta error', e); res.status(500).json({ error: 'meta failed' })
  }
})

// Soft delete / restore
app.post('/api/soft-delete', requireAdmin, async (req, res) => {
  try {
    const { filenames } = req.body || {}
    if (!Array.isArray(filenames)) return res.status(400).json({ error: 'filenames[] required' })
    const meta = await readMeta()
    filenames.forEach(fn => { meta.deleted[fn] = true })
    await writeMeta(meta)
    res.json({ ok: true, count: filenames.length })
  } catch (e) {
    console.error('soft-delete error', e); res.status(500).json({ error: 'soft-delete failed' })
  }
})

app.post('/api/restore', requireAdmin, async (req, res) => {
  try {
    const { filenames } = req.body || {}
    if (!Array.isArray(filenames)) return res.status(400).json({ error: 'filenames[] required' })
    const meta = await readMeta()
    filenames.forEach(fn => { delete meta.deleted[fn] })
    await writeMeta(meta)
    res.json({ ok: true, count: filenames.length })
  } catch (e) {
    console.error('restore error', e); res.status(500).json({ error: 'restore failed' })
  }
})

// Posts
app.get('/api/posts', async (_req, res) => {
  try {
    const [vids, auds, meta] = await Promise.all([ s3List('video/'), s3List('audio/'), readMeta() ])
    const hidden = meta.deleted || {}
    const items = []
    for (const v of vids) {
      if (hidden[v.Key]) continue
      items.push({
        filename: v.Key,
        title: (meta.items[v.Key]?.title) || v.Key.split('/').pop(),
        tagline: meta.items[v.Key]?.tagline || '',
        type: 'video',
        date: v.LastModified ? new Date(v.LastModified).toISOString() : null,
        url: publicUrlForKey(v.Key),
        absoluteUrl: publicUrlForKey(v.Key)
      })
    }
    for (const a of auds) {
      if (hidden[a.Key]) continue
      items.push({
        filename: a.Key,
        title: (meta.items[a.Key]?.title) || a.Key.split('/').pop(),
        tagline: meta.items[a.Key]?.tagline || '',
        type: 'audio',
        date: a.LastModified ? new Date(a.LastModified).toISOString() : null,
        url: publicUrlForKey(a.Key),
        absoluteUrl: publicUrlForKey(a.Key)
      })
    }
    items.sort((x,y) => new Date(y.date||0) - new Date(x.date||0))
    res.json(items)
  } catch (e) {
    console.error('list error', e); res.status(500).json({ error: 'list failed' })
  }
})

// ==== VIDEO GENERATION w/ RETRY QUEUE ====
async function renderSpectralVideo(sourceKey){
  const tmpIn = path.join(os.tmpdir(), `in-${Date.now()}.mp3`)
  const tmpOut = path.join(os.tmpdir(), `out-${Date.now()}.mp4`)
  await s3GetToFile(sourceKey, tmpIn)
  ffmpeg.setFfmpegPath(ffmpegStatic || undefined)
  await new Promise((resolve, reject) => {
    ffmpeg(tmpIn)
      .outputOptions(['-y','-threads','1','-preset','veryfast','-r','24'])
      .complexFilter([
        'color=c=white:size=1080x1080:rate=30[bg]',
        '[0:a]aformat=channel_layouts=stereo,showspectrum=s=1080x800:mode=combined:scale=log:color=intensity,format=yuv420p[v1]',
        '[bg][v1]overlay=shortest=1:x=0:y=280,drawbox=x=0:y=0:w=1080:h=160:color=#052962@1:t=fill[v]'
      ])
      .outputOptions(['-map','[v]','-map','0:a','-shortest'])
      .videoCodec('libx264').audioCodec('aac')
      .on('end', resolve).on('error', reject).save(tmpOut)
  })
  const base = path.basename(sourceKey).replace(/\.[^/.]+$/, '')
  const outKey = `video/${base}.mp4`
  const outBuf = fs.readFileSync(tmpOut)
  await s3UploadBuffer(outKey, outBuf, 'video/mp4')
  try{ fs.unlinkSync(tmpIn) }catch{}; try{ fs.unlinkSync(tmpOut) }catch{}
  return outKey
}

const MAX_RETRIES = 3
function backoffMs(attempt){ return Math.min(60000, 2000 * Math.pow(2, attempt)) } // 2s, 4s, 8s, 16s, ... capped

// Enqueue generate-video (durable)
app.post('/api/generate-video', requireAdmin, async (req, res) => {
  try{
    const { filename } = req.body || {}
    if (!filename) return res.status(400).json({ error: 'filename (S3 key) required' })
    const jobs = await readVideoJobs()
    const id = uid()
    jobs.items[id] = { id, filename, status: 'queued', attempts: 0, nextTryAt: Date.now(), createdAt: Date.now() }
    jobs.queue.push(id)
    await writeVideoJobs(jobs)
    res.json({ ok:true, id, status:'queued' })
  }catch(e){
    console.error('generate enqueue error', e)
    res.status(500).json({ error: 'enqueue failed' })
  }
})

app.get('/api/video/:id/status', async (req, res) => {
  try{
    const jobs = await readVideoJobs()
    const j = jobs.items[req.params.id]
    if(!j) return res.status(404).json({ error: 'not found' })
    res.json(j)
  }catch(e){
    res.status(500).json({ error: 'status failed' })
  }
})

// Worker
async function processVideoOnce(){
  const jobs = await readVideoJobs()
  // pick first eligible job
  const now = Date.now()
  const idx = jobs.queue.findIndex(id => {
    const j = jobs.items[id]; return j && (j.status==='queued' || j.status==='retry') && (j.nextTryAt||0) <= now
  })
  if (idx === -1) return
  const id = jobs.queue[idx]
  const job = jobs.items[id]
  // mark processing
  job.status = 'processing'; await writeVideoJobs(jobs)
  try{
    const outKey = await renderSpectralVideo(job.filename)
    job.status = 'done'; job.output = outKey; await writeVideoJobs(jobs)
  }catch(e){
    console.error('video worker error', e)
    job.attempts = (job.attempts||0) + 1
    if (job.attempts >= MAX_RETRIES){
      job.status = 'error'; job.error = String(e)
      // remove from active queue
      jobs.queue.splice(idx,1)
    } else {
      job.status = 'retry'
      job.nextTryAt = Date.now() + backoffMs(job.attempts)
    }
    await writeVideoJobs(jobs)
    return
  }
  // success: remove from queue
  jobs.queue.splice(idx,1); await writeVideoJobs(jobs)
}
setInterval(processVideoOnce, 5000)

// ==== SHORTS (unchanged from your previous package) ====
const openaiKey = process.env.OPENAI_API_KEY
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null
const JOBS_KEY = 'meta/_shorts_jobs.json'

async function readJobs() {
  const txt = await s3GetText(JOBS_KEY)
  if (!txt) return { queue: [], items: {} }
  try { return JSON.parse(txt) } catch { return { queue: [], items: {} } }
}
async function writeJobs(j) {
  const buf = Buffer.from(JSON.stringify(j, null, 2))
  await s3UploadBuffer(JOBS_KEY, buf, 'application/json')
}

app.post('/api/shorts/request', requireAdmin, async (req, res) => {
  try{
    if (String(process.env.SHORTS_ENABLED).toLowerCase() !== 'true') {
      return res.status(400).json({ error: 'Shorts disabled (set SHORTS_ENABLED=true)' })
    }
    const { filename, maxSeconds } = req.body || {}
    if (!filename) return res.status(400).json({ error: 'filename (S3 key) required' })
    const id = uid()
    const jobs = await readJobs()
    jobs.items[id] = { id, filename, maxSeconds: Number(maxSeconds)||Number(process.env.SHORTS_MAX_SECONDS||45), status: 'queued', createdAt: Date.now() }
    jobs.queue.push(id)
    await writeJobs(jobs)
    res.json({ ok:true, id, status:'queued' })
  }catch(e){
    console.error('shorts request error', e)
    res.status(500).json({ error: 'request failed' })
  }
})

app.get('/api/shorts/:id/status', async (req, res) => {
  const jobs = await readJobs()
  const job = jobs.items[req.params.id]
  if (!job) return res.status(404).json({ error: 'not found' })
  res.json(job)
})

app.get('/api/shorts', async (_req, res) => {
  const jobs = await readJobs()
  const done = Object.values(jobs.items).filter(j => j.status === 'done').sort((a,b)=>b.createdAt-a.createdAt)
  res.json(done.map(j => ({ id:j.id, source:j.filename, output:j.output, url: j.output ? publicUrlForKey(j.output) : null, createdAt:j.createdAt })))
})

async function transcribeWhisper(tmpAudioPath){
  if (!openai) throw new Error('OPENAI_API_KEY not set')
  const resp = await openai.audio.transcriptions.create({
    file: fs.createReadStream(tmpAudioPath),
    model: 'whisper-1',
    response_format: 'verbose_json',
    temperature: 0
  })
  return resp
}

function pickSegment(tr, maxSeconds){
  try{
    const segs = tr.segments || []
    if (segs.length){
      const start = Math.max(0, Math.floor(segs[0].start||0))
      const end = Math.min(Math.ceil(segs[0].start + maxSeconds), Math.ceil(segs[segs.length-1].end || (start+maxSeconds)))
      return { start, duration: Math.max(5, Math.min(maxSeconds, end-start)) }
    }
  }catch{}
  return { start: 0, duration: Math.max(5, maxSeconds) }
}

async function renderShortFromS3(sourceKey, maxSeconds){
  const tmpIn = path.join(os.tmpdir(), `short-in-${Date.now()}.mp3`)
  const tmpOut = path.join(os.tmpdir(), `short-out-${Date.now()}.mp4`)
  await s3GetToFile(sourceKey, tmpIn)
  const tr = await transcribeWhisper(tmpIn)
  const seg = pickSegment(tr, maxSeconds||45)
  await new Promise((resolve, reject) => {
    ffmpeg.setFfmpegPath(ffmpegStatic || undefined)
    const filter = [
      `color=c=white:size=1080x1920:rate=30[bg]`,
      `[0:a]atrim=${seg.start}:${seg.start+seg.duration},asetpts=N/SR/TB,asplit=2[a1][a2]`,
      `[a1]showspectrum=s=1080x1200:mode=combined:color=intensity:scale=log,format=yuv420p[v1]`,
      `[bg][v1]overlay=shortest=1:x=0:y=360,drawbox=x=0:y=0:w=1080:h=180:color=#052962@1:t=fill[v]`
    ]
    ffmpeg(tmpIn).outputOptions(['-y','-threads','1','-preset','veryfast','-t', String(seg.duration),'-r','30'])
      .complexFilter(filter).outputOptions(['-map','[v]','-map','0:a','-shortest']).videoCodec('libx264').audioCodec('aac')
      .on('end', resolve).on('error', reject).save(tmpOut)
  })
  const base = path.basename(sourceKey).replace(/\.[^/.]+$/, '')
  const outKey = `shorts/${base}-9x16.mp4`
  const outBuf = fs.readFileSync(tmpOut)
  await s3UploadBuffer(outKey, outBuf, 'video/mp4')
  try{ fs.unlinkSync(tmpIn) }catch{}; try{ fs.unlinkSync(tmpOut) }catch{}
  return outKey
}

async function workerOnce(){
  const jobs = await readJobs()
  const next = jobs.queue.shift()
  if (!next) return
  await writeJobs(jobs)
  try{
    jobs.items[next].status = 'processing'; await writeJobs(jobs)
    const outKey = await renderShortFromS3(jobs.items[next].filename, jobs.items[next].maxSeconds)
    jobs.items[next].status = 'done'; jobs.items[next].output = outKey; await writeJobs(jobs)
  }catch(e){
    console.error('worker error', e)
    jobs.items[next].status = 'error'; jobs.items[next].error = String(e); await writeJobs(jobs)
  }
}
setInterval(workerOnce, 8000)

// Process video queue every 5s
setInterval(processVideoOnce, 5000)

const PORT = process.env.PORT || 10000
app.listen(PORT, () => console.log('Backend listening on', PORT))
