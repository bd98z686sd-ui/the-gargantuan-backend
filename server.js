// server.js — Backend with burned-in captions for Shorts
// Adds caption burn-in (no libass required) using drawtext overlays per time window.
// If drawtext isn't available in your ffmpeg build, captions auto-disable gracefully.
//
// New env:
//   CAPTIONS_ENABLED=true          # enable caption burn-in for Shorts
//   CAPTION_MAX_LINE_CHARS=42      # wrap width per line
//   CAPTION_FONT_SIZE=48           # px
//   CAPTION_BOX_OPACITY=0.6        # 0..1
//   CAPTION_COLOR=white            # text color
//   CAPTION_BOXCOLOR=black         # box color behind text
//
// Existing env: see .env.example
//
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

const FFMPEG_LOG = String(process.env.FFMPEG_LOG || '').trim() === '1';
function log(...args){ console.log('[gargantuan]', ...args) }
function logErr(...args){ console.error('[gargantuan]', ...args) }

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

// -------- R2 / S3 --------
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

// -------- Meta --------
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

// -------- Health --------
app.get('/api/health', (_req, res) => res.json({ ok: true }))

// -------- Upload --------
const upload = multer({ storage: multer.memoryStorage() })
app.post('/api/upload', requireAdmin, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' })
    const safe = (req.file.originalname || 'audio.mp3').replace(/\s+/g, '-')
    const folder = (req.file.mimetype || '').startsWith('video/') ? 'video' : 'audio'
    const key = `${folder}/${Date.now()}-${safe}`
    await s3UploadBuffer(key, req.file.buffer, req.file.mimetype || 'application/octet-stream')
    res.json({ key, url: publicUrlForKey(key) })
  } catch (e) {
    logErr('upload error', e)
    res.status(500).json({ error: 'upload failed' })
  }
})

// -------- Meta edit/hide --------
app.post('/api/meta', requireAdmin, async (req, res) => {
  try {
    const { filename, title, tagline } = req.body || {}
    if (!filename) return res.status(400).json({ error: 'filename required' })
    const meta = await readMeta()
    meta.items[filename] = { title: title || '', tagline: tagline || '' }
    await writeMeta(meta)
    res.json({ ok: true })
  } catch (e) { logErr('meta error', e); res.status(500).json({ error: 'meta failed' }) }
})

app.post('/api/soft-delete', requireAdmin, async (req, res) => {
  try {
    const { filenames } = req.body || {}
    if (!Array.isArray(filenames)) return res.status(400).json({ error: 'filenames[] required' })
    const meta = await readMeta()
    filenames.forEach(fn => { meta.deleted[fn] = true })
    await writeMeta(meta)
    res.json({ ok: true, count: filenames.length })
  } catch (e) { logErr('soft-delete error', e); res.status(500).json({ error: 'soft-delete failed' }) }
})

app.post('/api/restore', requireAdmin, async (req, res) => {
  try {
    const { filenames } = req.body || {}
    if (!Array.isArray(filenames)) return res.status(400).json({ error: 'filenames[] required' })
    const meta = await readMeta()
    filenames.forEach(fn => { delete meta.deleted[fn] })
    await writeMeta(meta)
    res.json({ ok: true, count: filenames.length })
  } catch (e) { logErr('restore error', e); res.status(500).json({ error: 'restore failed' }) }
})

// -------- Posts feed --------
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
  } catch (e) { logErr('list error', e); res.status(500).json({ error: 'list failed' }) }
})

// -------- Square video render (unchanged) --------
const VIDEO_MAX_SECONDS = Number(process.env.VIDEO_MAX_SECONDS || 0) // 0 = full length
const CANVAS_W = Number(process.env.VIDEO_W || 720)
const CANVAS_H = Number(process.env.VIDEO_H || 720)
const SPECTRUM_H = Number(process.env.VIDEO_SPECTRUM_H || 540)
const TOPBAR_H  = Number(process.env.VIDEO_TOPBAR_H || 100)
const FPS = Number(process.env.VIDEO_FPS || 24)
const PRESET = String(process.env.VIDEO_PRESET || 'ultrafast')
const CRF = String(process.env.VIDEO_CRF || '28')

async function renderSpectralVideo(sourceKey){
  const tmpIn = path.join(os.tmpdir(), `in-${Date.now()}.media`)
  const tmpOut = path.join(os.tmpdir(), `out-${Date.now()}.mp4`)
  await s3GetToFile(sourceKey, tmpIn)
  ffmpeg.setFfmpegPath(ffmpegStatic || undefined)
  await new Promise((resolve, reject) => {
    const opts = ['-y','-nostdin','-threads','1','-preset', PRESET, '-r', String(FPS)]
    if (VIDEO_MAX_SECONDS > 0) { opts.push('-t', String(VIDEO_MAX_SECONDS)) }
    const filter = [
      `color=c=white:size=${CANVAS_W}x${CANVAS_H}:rate=${FPS}[bg]`,
      `[0:a]aformat=channel_layouts=stereo,showspectrum=s=${CANVAS_W}x${SPECTRUM_H}:mode=combined:scale=log:color=intensity,format=yuv420p[v1]`,
      `[bg][v1]overlay=shortest=1:x=0:y=${CANVAS_H - SPECTRUM_H},drawbox=x=0:y=0:w=${CANVAS_W}:h=${TOPBAR_H}:color=#052962@1:t=fill[v]`
    ]
    const cmd = ffmpeg(tmpIn).inputOption('-nostdin').outputOptions(opts)
      .complexFilter(filter).outputOptions(['-map','[v]','-map','0:a','-shortest','-crf', CRF])
      .videoCodec('libx264').audioCodec('aac')
      .on('start', (cmdline)=>log('ffmpeg(sq) start:', cmdline))
      .on('stderr', (line)=>{ if(FFMPEG_LOG) log('ffmpeg(sq):', line) })
      .on('end', ()=>{ log('ffmpeg(sq) done'); resolve() })
      .on('error', (e)=>{ logErr('ffmpeg(sq) error', e); reject(e) })
      .save(tmpOut)
    if(FFMPEG_LOG) cmd.addOption('-loglevel','verbose')
  })
  const base = path.basename(sourceKey).replace(/\.[^/.]+$/, '')
  const outKey = `video/${base}.mp4`
  const outBuf = fs.readFileSync(tmpOut)
  await s3UploadBuffer(outKey, outBuf, 'video/mp4')
  try{ fs.unlinkSync(tmpIn) }catch{}; try{ fs.unlinkSync(tmpOut) }catch{}
  return outKey
}

// -------- Video queue --------
function uid(){ return Math.random().toString(36).slice(2) + Date.now().toString(36) }
const VIDEO_JOBS_KEY = 'meta/_video_jobs.json'
async function readVideoJobs(){ const t = await s3GetText(VIDEO_JOBS_KEY); if(!t) return {queue:[],items:{}}; try{ return JSON.parse(t)}catch{return{queue:[],items:{}}} }
async function writeVideoJobs(j){ await s3UploadBuffer(VIDEO_JOBS_KEY, Buffer.from(JSON.stringify(j,null,2)), 'application/json') }
const MAX_RETRIES = 3
function backoffMs(attempt){ return Math.min(60000, 2000 * Math.pow(2, attempt)) }

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
  }catch(e){ logErr('enqueue error', e); res.status(500).json({ error: 'enqueue failed' }) }
})

app.get('/api/video/:id/status', async (req, res) => {
  try{ const jobs = await readVideoJobs(); const j = jobs.items[req.params.id]; if(!j) return res.status(404).json({error:'not found'}); res.json(j) }
  catch{ res.status(500).json({ error: 'status failed' }) }
})

app.get('/api/video/jobs', async (_req, res) => {
  try { const jobs = await readVideoJobs(); res.json(jobs) } catch { res.status(500).json({ error: 'debug failed' }) }
})

app.post('/api/video/process-now', requireAdmin, async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' })
    const jobs = await readVideoJobs(); const job = jobs.items[id]; if (!job) return res.status(404).json({ error: 'job not found' })
    job.status = 'processing'; await writeVideoJobs(jobs)
    try {
      const outKey = await renderSpectralVideo(job.filename);
      job.status = 'done'; job.output = outKey; await writeVideoJobs(jobs);
      return res.json({ ok: true, id, output: outKey, url: publicUrlForKey(outKey) });
    } catch (e) {
      job.attempts = (job.attempts || 0) + 1;
      if (job.attempts >= MAX_RETRIES) { job.status = 'error'; job.error = String(e); jobs.queue = jobs.queue.filter(x=>x!==id) }
      else { job.status = 'retry'; job.error = String(e); job.nextTryAt = Date.now() + backoffMs(job.attempts) }
      await writeVideoJobs(jobs);
      return res.status(500).json({ error: 'ffmpeg failed', details: String(e) });
    }
  } catch (e) { res.status(500).json({ error: 'process-now failed' }) }
})

async function processVideoOnce(){
  const jobs = await readVideoJobs()
  const now = Date.now()
  const idx = jobs.queue.findIndex(id => {
    const j = jobs.items[id]; return j && (j.status==='queued' || j.status==='retry') && (j.nextTryAt||0) <= now
  })
  if (idx === -1) return
  const id = jobs.queue[idx]; const job = jobs.items[id]
  job.status = 'processing'; await writeVideoJobs(jobs)
  try{ const outKey = await renderSpectralVideo(job.filename); job.status='done'; job.output=outKey; jobs.queue.splice(idx,1); await writeVideoJobs(jobs) }
  catch(e){ job.attempts=(job.attempts||0)+1; if(job.attempts>=MAX_RETRIES){job.status='error'; jobs.queue.splice(idx,1)}else{job.status='retry'; job.nextTryAt=Date.now()+backoffMs(job.attempts)} job.error=String(e); await writeVideoJobs(jobs) }
}
setInterval(processVideoOnce, 5000)

// -------- Shorts + Captions --------
const openaiKey = process.env.OPENAI_API_KEY
const openai = openaiKey ? new OpenAI({ apiKey: openaiKey }) : null
const JOBS_KEY = 'meta/_shorts_jobs.json'
const CAPTIONS_ENABLED = String(process.env.CAPTIONS_ENABLED || 'true').toLowerCase() === 'true'
const CAPTION_MAX_LINE_CHARS = Number(process.env.CAPTION_MAX_LINE_CHARS || 42)
const CAPTION_FONT_SIZE = Number(process.env.CAPTION_FONT_SIZE || 48)
const CAPTION_BOX_OPACITY = Number(process.env.CAPTION_BOX_OPACITY || 0.6)
const CAPTION_COLOR = String(process.env.CAPTION_COLOR || 'white')
const CAPTION_BOXCOLOR = String(process.env.CAPTION_BOXCOLOR || 'black')

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
    logErr('shorts request error', e)
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

async function transcribeWhisperOrMock(tmpAudioPath){
  if (!openai) {
    log('[shorts] OPENAI_API_KEY missing → mock transcription mode')
    return { text: '(mock) transcription disabled', segments: [{ start: 0, end: 30, text: '(mock)'}] }
  }
  const resp = await openai.audio.transcriptions.create({
    file: fs.createReadStream(tmpAudioPath),
    model: 'whisper-1',
    response_format: 'verbose_json',
    temperature: 0
  })
  return resp
}

// Merge short Whisper segments into readable lines
function mergeSegments(segments, maxChars) {
  const out = []
  let buf = ''
  let start = segments.length ? segments[0].start : 0
  for (const s of segments) {
    const chunk = (s.text || '').trim()
    if (!chunk) continue
    const tryAdd = (buf ? buf + ' ' : '') + chunk
    if (tryAdd.length > maxChars && buf) {
      out.push({ start, end: s.start, text: buf.trim() })
      buf = chunk
      start = s.start
    } else {
      buf = tryAdd
    }
  }
  if (buf) out.push({ start, end: segments.length ? segments[segments.length-1].end : start + 3, text: buf.trim() })
  return out
}

function escDrawtext(s) {
  return (s || '')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\n/g, ' ')
}

async function renderShortFromS3(sourceKey, maxSeconds){
  const tmpIn = path.join(os.tmpdir(), `short-in-${Date.now()}.media`)
  const tmpOut = path.join(os.tmpdir(), `short-out-${Date.now()}.mp4`)
  await s3GetToFile(sourceKey, tmpIn)
  const tr = await transcribeWhisperOrMock(tmpIn)
  // Build caption lines
  const segs = (tr.segments || []).map(s => ({ start: Math.max(0, s.start||0), end: Math.max(s.end||((s.start||0)+1)), text: s.text||'' }))
  const lines = mergeSegments(segs, CAPTION_MAX_LINE_CHARS)

  // Choose time window
  const totalEnd = segs.length ? segs[segs.length-1].end : 60
  const clipDur = Math.min(maxSeconds||45, Math.max(5, Math.ceil(totalEnd)))
  const clipStart = Math.max(0, segs.length ? Math.floor(segs[0].start) : 0)

  ffmpeg.setFfmpegPath(ffmpegStatic || undefined)
  await new Promise((resolve, reject) => {
    const baseFilters = [
      `color=c=white:size=1080x1920:rate=30[bg]`,
      `[0:a]atrim=${clipStart}:${clipStart+clipDur},asetpts=N/SR/TB,asplit=2[a1][a2]`,
      `[a1]showspectrum=s=1080x1200:mode=combined:color=intensity:scale=log,format=yuv420p[v1]`,
      `[bg][v1]overlay=shortest=1:x=0:y=360,drawbox=x=0:y=0:w=1080:h=180:color=#052962@1:t=fill[vbase]`
    ]

    let chain = 'vbase'
    let filters = baseFilters.slice()

    if (CAPTIONS_ENABLED && lines.length) {
      for (const ln of lines) {
        const start = Math.max(clipStart, ln.start)
        const end   = Math.min(clipStart + clipDur, ln.end || (start+2))
        if (end <= clipStart || start >= clipStart + clipDur) continue
        const enable = `between(t\,${(start-clipStart).toFixed(2)}\,${(end-clipStart).toFixed(2)})`
        // Centered near bottom (above spectrum): y ~ 1500
        const draw = [
          `${chain}`,
          `drawtext=text='${escDrawtext(ln.text)}':fontsize=${CAPTION_FONT_SIZE}:fontcolor=${CAPTION_COLOR}:x=(w-text_w)/2:y=1500:box=1:boxcolor=${CAPTION_BOXCOLOR}@${CAPTION_BOX_OPACITY}:boxborderw=20:enable='${enable}'[${chain}c]`
        ].join(';')
        filters.push(draw)
        chain = `${chain}c`
      }
    }

    const cmd = ffmpeg(tmpIn)
      .inputOption('-nostdin')
      .outputOptions(['-y','-nostdin','-threads','1','-preset','veryfast','-t', String(clipDur),'-r','30','-crf','28'])
      .complexFilter(filters)
      .outputOptions(['-map',`[${chain}]`,'-map','0:a','-shortest'])
      .videoCodec('libx264').audioCodec('aac')
      .on('start', (cmdline)=>log('ffmpeg(short+captions) start:', cmdline))
      .on('stderr', (line)=>{ if(FFMPEG_LOG) log('ffmpeg(short+captions):', line) })
      .on('end', ()=>{ log('ffmpeg(short+captions) done'); resolve() })
      .on('error', (e)=>{
        logErr('ffmpeg(short+captions) error — proceeding without captions', e)
        // Fallback: re-run without captions
        const fallback = ffmpeg(tmpIn)
          .inputOption('-nostdin')
          .outputOptions(['-y','-nostdin','-threads','1','-preset','veryfast','-t', String(clipDur),'-r','30','-crf','28'])
          .complexFilter(baseFilters)
          .outputOptions(['-map','[vbase]','-map','0:a','-shortest'])
          .videoCodec('libx264').audioCodec('aac')
          .on('end', ()=>resolve())
          .on('error', (ee)=>reject(ee))
          .save(tmpOut)
        if(FFMPEG_LOG) fallback.addOption('-loglevel','verbose')
      })
      .save(tmpOut)
    if(FFMPEG_LOG) cmd.addOption('-loglevel','verbose')
  })

  const base = path.basename(sourceKey).replace(/\.[^/.]+$/, '')
  const outKey = `shorts/${base}-9x16.mp4`
  const outBuf = fs.readFileSync(tmpOut)
  await s3UploadBuffer(outKey, outBuf, 'video/mp4')
  try{ fs.unlinkSync(tmpIn) }catch{}; try{ fs.unlinkSync(tmpOut) }catch{}
  return outKey
}

async function readJobs() {
  const txt = await s3GetText(JOBS_KEY)
  if (!txt) return { queue: [], items: {} }
  try { return JSON.parse(txt) } catch { return { queue: [], items: {} } }
}
async function writeJobs(j) {
  const buf = Buffer.from(JSON.stringify(j, null, 2))
  await s3UploadBuffer(JOBS_KEY, buf, 'application/json')
}

// request/status/list
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
  }catch(e){ logErr('shorts request error', e); res.status(500).json({ error: 'request failed' }) }
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

// worker loop
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
    logErr('shorts worker error', e)
    jobs.items[next].status = 'error'; jobs.items[next].error = String(e); await writeJobs(jobs)
  }
}
setInterval(workerOnce, 8000)

// whisper test
app.post('/api/whisper-test', requireAdmin, async (req, res) => {
  try {
    const { filename } = req.body || {}
    if (!filename) return res.status(400).json({ error: 'filename (S3 key) required' })
    const tmpIn = path.join(os.tmpdir(), `whisper-${Date.now()}.media`)
    await s3GetToFile(filename, tmpIn)
    if (!openai) return res.json({ ok: true, text: '(mock) transcription disabled', language: 'unknown' })
    const resp = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpIn),
      model: 'whisper-1',
      response_format: 'verbose_json',
      temperature: 0
    })
    try { fs.unlinkSync(tmpIn) } catch {}
    return res.json({ ok: true, text: resp.text, language: resp.language || 'unknown' })
  } catch (e) {
    logErr('whisper-test error', e)
    return res.status(500).json({ error: 'whisper failed', details: String(e) })
  }
})

// debug: jobs/process-now for shorts
app.get('/api/shorts/jobs', async (_req, res) => {
  try { const jobs = await readJobs(); res.json(jobs) }
  catch(e){ res.status(500).json({ error: 'debug failed' }) }
})

app.post('/api/shorts/process-now', requireAdmin, async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' })
    const jobs = await readJobs(); const job = jobs.items[id]; if (!job) return res.status(404).json({ error: 'job not found' })
    job.status='processing'; await writeJobs(jobs)
    try {
      const outKey = await renderShortFromS3(job.filename, job.maxSeconds)
      job.status='done'; job.output=outKey; await writeJobs(jobs)
      res.json({ ok:true, id, output: outKey, url: publicUrlForKey(outKey) })
    } catch (e) {
      job.status='error'; job.error=String(e); await writeJobs(jobs)
      res.status(500).json({ error: 'ffmpeg/whisper failed', details: String(e) })
    }
  } catch { res.status(500).json({ error: 'process-now failed' }) }
})

// util
function uid(){ return Math.random().toString(36).slice(2) + Date.now().toString(36) }

const PORT = process.env.PORT || 10000
app.listen(PORT, () => console.log('Backend listening on', PORT))
