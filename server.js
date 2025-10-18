// server.js — The Gargantuan Backend v3
// Features:
//  - Upload to R2/S3
//  - Posts feed (videos + audios) from R2
//  - Spectral square video render (homepage embed)
//  - Shorts (9:16) with boxed captions
//  - Masthead + Title Card with auto-contrast vs solid background color
//  - Thumbnail generator (JPEG) with title overlay
//  - Admin token header (x-admin-token)
//  - Duplicate helper fix (readShortJobs vs readVideoJobs)

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
app.use(express.json({ limit:'10mb' }))

const ADMIN_TOKEN = process.env.ADMIN_TOKEN
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next()
  if (req.get('x-admin-token') !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' })
  next()
}

const FFMPEG_LOG = String(process.env.FFMPEG_LOG||'').trim()==='1'
function log(...a){ console.log('[garg]', ...a) }
function logErr(...a){ console.error('[garg]', ...a) }

// ---- R2 / S3 ----
const S3_ENDPOINT = process.env.S3_ENDPOINT
const S3_REGION = process.env.S3_REGION || 'auto'
const S3_BUCKET = process.env.S3_BUCKET
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY
const S3_PUBLIC_BASE = process.env.S3_PUBLIC_BASE || ''
const S3_FORCE_PATH_STYLE = String(process.env.S3_FORCE_PATH_STYLE).toLowerCase()==='true'

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

async function s3UploadBuffer(key, buf, type) {
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: buf, ContentType: type }))
}
async function s3GetToFile(key, outPath) {
  const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }))
  await new Promise((resolve, reject) => {
    Readable.from(resp.Body).pipe(fs.createWriteStream(outPath)).on('finish', resolve).on('error', reject)
  })
}
async function s3GetText(key){
  try{
    const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }))
    const chunks=[]; for await(const c of resp.Body) chunks.push(c)
    return Buffer.concat(chunks).toString('utf-8')
  }catch{ return null }
}
async function s3List(prefix){
  const out=[]; let ContinuationToken
  do{
    const resp = await s3.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix, ContinuationToken }))
    ;(resp.Contents||[]).forEach(o=>out.push(o))
    ContinuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined
  }while(ContinuationToken)
  return out
}

// ---- Meta (titles/taglines + soft delete) ----
const META_KEY = 'meta/_posts.json'
async function readMeta(){
  const t = await s3GetText(META_KEY); if(!t) return { items:{}, deleted:{} }
  try{ const m=JSON.parse(t); return { items:m.items||{}, deleted:m.deleted||{} } }catch{ return {items:{},deleted:{}} }
}
async function writeMeta(m){
  await s3UploadBuffer(META_KEY, Buffer.from(JSON.stringify(m,null,2)), 'application/json')
}

app.get('/api/health', (_req,res)=>res.json({ok:true}))

// ---- Upload ----
const upload = multer({ storage: multer.memoryStorage() })
app.post('/api/upload', requireAdmin, upload.single('audio'), async (req,res)=>{
  try{
    if(!req.file) return res.status(400).json({error:'No file'})
    const safe=(req.file.originalname||'file.bin').replace(/\s+/g,'-')
    const folder=(req.file.mimetype||'').startsWith('video/')?'video':'audio'
    const key=`${folder}/${Date.now()}-${safe}`
    await s3UploadBuffer(key, req.file.buffer, req.file.mimetype||'application/octet-stream')
    res.json({ key, url: publicUrlForKey(key) })
  }catch(e){ logErr('upload',e); res.status(500).json({error:'upload failed'}) }
})

// ---- Posts feed ----
app.get('/api/posts', async (_req,res)=>{
  try{
    const [vids,auds,meta]=await Promise.all([s3List('video/'), s3List('audio/'), readMeta()])
    const hidden=meta.deleted||{}
    const items=[]
    for(const v of vids){
      if(hidden[v.Key]) continue
      items.push({ type:'video', filename:v.Key, date:v.LastModified, title:meta.items[v.Key]?.title||v.Key.split('/').pop(), tagline:meta.items[v.Key]?.tagline||'', url: publicUrlForKey(v.Key) })
    }
    for(const a of auds){
      if(hidden[a.Key]) continue
      items.push({ type:'audio', filename:a.Key, date:a.LastModified, title:meta.items[a.Key]?.title||a.Key.split('/').pop(), tagline:meta.items[a.Key]?.tagline||'', url: publicUrlForKey(a.Key) })
    }
    items.sort((x,y)=> new Date(y.date||0) - new Date(x.date||0))
    res.json(items)
  }catch(e){ logErr('posts',e); res.status(500).json({error:'list failed'}) }
})

// ---- Styling / brand ----
const BRAND_NAME = process.env.BRAND_NAME || 'The Gargantuan'
const MASTHEAD_COLOR = process.env.MASTHEAD_COLOR || '#052962' // Guardian blue
const MASTHEAD_HEIGHT = Number(process.env.MASTHEAD_HEIGHT || 180)
const MASTHEAD_FONT_SIZE = Number(process.env.MASTHEAD_FONT_SIZE || 72)
const MASTHEAD_X = Number(process.env.MASTHEAD_X || 40)
// Simple auto-contrast: choose white/black text based on masthead color luminance
function hexToRgb(hex){ const m = /^#?([0-9a-f]{6})$/i.exec(hex||''); if(!m) return {r:5,g:41,b:98}; const n=parseInt(m[1],16); return {r:(n>>16)&255,g:(n>>8)&255,b:n&255} }
function luminance({r,g,b}){ return 0.2126*r + 0.7152*g + 0.0722*b }
function contrastTextFor(bgHex){ const Y=luminance(hexToRgb(bgHex)); return Y>140 ? 'black' : 'white' }
const MASTHEAD_TEXT_COLOR = contrastTextFor(MASTHEAD_COLOR)

// ---- Video tuning ----
const VIDEO_MAX_SECONDS = Number(process.env.VIDEO_MAX_SECONDS || 0)
const CANVAS_W = Number(process.env.VIDEO_W || 720)
const CANVAS_H = Number(process.env.VIDEO_H || 720)
const SPECTRUM_H = Number(process.env.VIDEO_SPECTRUM_H || 540)
const TOPBAR_H = Number(process.env.VIDEO_TOPBAR_H || 100)
const FPS = Number(process.env.VIDEO_FPS || 24)
const PRESET = String(process.env.VIDEO_PRESET || 'ultrafast')
const CRF = String(process.env.VIDEO_CRF || '28')

// ---- Captions config (boxed) ----
const CAPTIONS_ENABLED = String(process.env.CAPTIONS_ENABLED||'true').toLowerCase()==='true'
const CAPTION_FONT_SIZE = Number(process.env.CAPTION_FONT_SIZE || 48)
const CAPTION_COLOR = process.env.CAPTION_COLOR || 'white'
const CAPTION_BOXCOLOR = process.env.CAPTION_BOXCOLOR || 'black'
const CAPTION_BOX_OPACITY = Number(process.env.CAPTION_BOX_OPACITY || 0.7)
const CAPTION_SAFE_Y = Number(process.env.CAPTION_SAFE_Y || 1500)
const CAPTION_FONT_FILE = process.env.CAPTION_FONT_FILE || '' // optional; otherwise system fallback

// ---- Shorts & Whisper ----
const SHORTS_ENABLED = String(process.env.SHORTS_ENABLED||'true').toLowerCase()==='true'
const SHORTS_MAX_SECONDS = Number(process.env.SHORTS_MAX_SECONDS || 45)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null

function ff(){ ffmpeg.setFfmpegPath(ffmpegStatic || undefined); return ffmpeg }

// ---- Title card & thumbnail helpers ----
function drawTitleTextChain(chain, title, w, h, bgHex) {
  const text = title.replace(/[:\\']/g, m => ({':':'\\\\:','\\\\':'\\\\\\\\','\\'':"\\\\'"}[m]))
  const color = contrastTextFor(bgHex)
  const fontfile = CAPTION_FONT_FILE ? `:fontfile='${CAPTION_FONT_FILE}'` : ''
  const y = Math.floor(h*0.4)
  const fs = Math.max(48, Math.floor(h*0.065))
  return `${chain};drawtext=text='${text}':fontsize=${fs}:fontcolor=${color}${fontfile}:x=(w-text_w)/2:y=${y}[${chain}t]`
}

async function makeTitleCardPng(title, bgHex, w=1080, h=1920){
  const tmp = path.join(os.tmpdir(), `title-${Date.now()}.png`)
  await new Promise((resolve,reject)=>{
    const filters = [
      `color=c=${bgHex}:size=${w}x${h}:rate=30[c]`
    ]
    let chain='c'
    const t = drawTitleTextChain(chain, `${BRAND_NAME} — ${title}`, w, h, bgHex)
    filters.push(t); chain=`${chain}t`
    ff()()
      .input('color=black:s=16x16') // dummy
      .complexFilter(filters)
      .frames(1)
      .outputOptions('-f','image2')
      .on('end', resolve).on('error', reject)
      .save(tmp)
  })
  return tmp
}

async function makeThumbnailJpg(title, bgHex='#052962', w=1080, h=1080){
  const tmp = path.join(os.tmpdir(), `thumb-${Date.now()}.jpg`)
  await new Promise((resolve,reject)=>{
    const filters = [
      `color=c=${bgHex}:size=${w}x${h}:rate=30[c]`
    ]
    let chain='c'
    const t = drawTitleTextChain(chain, title, w, h, bgHex)
    filters.push(t); chain=`${chain}t`
    ff()()
      .input('color=black:s=16x16')
      .complexFilter(filters)
      .frames(1)
      .outputOptions('-q:v','3','-f','image2')
      .on('end', resolve).on('error', reject)
      .save(tmp)
  })
  return tmp
}

// ---- Spectral Video (square) ----
async function renderSpectralVideo(sourceKey, titleOpt){
  const tin = path.join(os.tmpdir(), `sq-in-${Date.now()}.media`)
  const tout = path.join(os.tmpdir(), `sq-out-${Date.now()}.mp4`)
  await s3GetToFile(sourceKey, tin)

  await new Promise((resolve,reject)=>{
    const opts = ['-y','-nostdin','-threads','1','-preset',PRESET,'-r',String(FPS)]
    if (VIDEO_MAX_SECONDS>0) opts.push('-t', String(VIDEO_MAX_SECONDS))
    ff()(tin).inputOption('-nostdin').outputOptions(opts)
      .complexFilter([
        `color=c=white:size=${CANVAS_W}x${CANVAS_H}:rate=${FPS}[bg]`,
        `[0:a]aformat=channel_layouts=stereo,showspectrum=s=${CANVAS_W}x${SPECTRUM_H}:mode=combined:scale=log:color=intensity,format=yuv420p[v1]`,
        `[bg][v1]overlay=shortest=1:x=0:y=${CANVAS_H - SPECTRUM_H},drawbox=x=0:y=0:w=${CANVAS_W}:h=${TOPBAR_H}:color=${MASTHEAD_COLOR}@1:t=fill[v]`
      ])
      .outputOptions(['-map','[v]','-map','0:a','-shortest','-crf',CRF])
      .videoCodec('libx264').audioCodec('aac')
      .on('end', resolve).on('error', reject).save(tout)
  })

  const base = path.basename(sourceKey).replace(/\.[^/.]+$/, '')
  const outKey = `video/${base}.mp4`
  await s3UploadBuffer(outKey, fs.readFileSync(tout), 'video/mp4')
  try{ fs.unlinkSync(tin) }catch{}; try{ fs.unlinkSync(tout) }catch{}
  return outKey
}

// ---- Whisper transcription (segments) ----
async function transcribeToSegments(tmpAudioPath){
  if (!openai) {
    // Fallback mock (keeps pipeline working if key missing)
    return [{ start:0, end:Math.min(10, Number(process.env.SHORTS_MAX_SECONDS||45)), text:'(mock caption)' }]
  }
  const resp = await openai.audio.transcriptions.create({
    file: fs.createReadStream(tmpAudioPath),
    model: 'whisper-1',
    response_format: 'verbose_json',
    temperature: 0
  })
  const segs = (resp.segments||[]).map(s=>({ start:Math.max(0,s.start||0), end:Math.max(s.end||((s.start||0)+1)), text:String(s.text||'').trim() }))
  return segs.length?segs:[{ start:0, end:Math.min(8, SHORTS_MAX_SECONDS), text: (resp.text||'').trim()||'(no speech detected)' }]
}

// Wrap to 2 lines (approx by chars)
function wrapTwoLines(text, maxChars){
  const m = Number(process.env.CAPTION_MAX_LINE_CHARS||42)
  const limit = maxChars||m
  const words = String(text||'').split(/\s+/)
  let l1='', l2=''
  for(const w of words){
    if((l1+' '+w).trim().length <= limit) l1=(l1+' '+w).trim()
    else if((l2+' '+w).trim().length <= limit) l2=(l2+' '+w).trim()
    else l2=(l2+' '+w).trim()
  }
  return (l2? `${l1}\\n${l2}` : l1) || ''
}

function esc(s){ return String(s||'').replace(/\\/g,'\\\\').replace(/:/g,'\\:').replace(/'/g,"\\'").replace(/\\n/g,'\\\\n') }

// ---- Shorts render (9:16) ----
async function renderShort(sourceKey, title){
  const tin = path.join(os.tmpdir(), `sh-in-${Date.now()}.media`)
  const tout = path.join(os.tmpdir(), `sh-out-${Date.now()}.mp4`)
  await s3GetToFile(sourceKey, tin)
  const segs = await transcribeToSegments(tin)

  const clipDur = Math.min(SHORTS_MAX_SECONDS, Math.max(5, Math.ceil((segs.at(-1)?.end)||15)))
  const filters = [
    `color=c=white:size=1080x1920:rate=30[bg]`,
    `[0:a]aformat=channel_layouts=stereo,atrim=0:${clipDur},asetpts=N/SR/TB,showspectrum=s=1080x1200:mode=combined:color=intensity:scale=log,format=yuv420p[v1]`,
    `[bg][v1]overlay=shortest=1:x=0:y=360,drawbox=x=0:y=0:w=1080:h=${MASTHEAD_HEIGHT}:color=${MASTHEAD_COLOR}@1:t=fill[vbase]`
  ]
  let chain='vbase'

  // Masthead brand text (auto-contrast vs MASTHEAD_COLOR)
  const brandEsc = esc(BRAND_NAME)
  const mastFont = CAPTION_FONT_FILE ? `:fontfile='${CAPTION_FONT_FILE}'` : ''
  const my = Math.max(20, (MASTHEAD_HEIGHT - MASTHEAD_FONT_SIZE - 24))
  filters.push(`${chain};drawtext=text='${brandEsc}':fontsize=${MASTHEAD_FONT_SIZE}:fontcolor=${MASTHEAD_TEXT_COLOR}${mastFont}:x=${MASTHEAD_X}:y=${my}[${chain}m]`)
  chain=`${chain}m`

  // Title card at start (first 1 sec)
  if (title && title.trim().length){
    const titleEsc = esc(`${title}`)
    const tfs = Math.max(52, Math.floor(1080*0.055))
    filters.push(`${chain};drawtext=text='${titleEsc}':fontsize=${tfs}:fontcolor=${MASTHEAD_TEXT_COLOR}${mastFont}:x=(w-text_w)/2:y=${MASTHEAD_HEIGHT+40}:enable='between(t,0,1.2)'[${chain}t]`)
    chain=`${chain}t`
  }

  // Captions (boxed, robust readability)
  if (CAPTIONS_ENABLED && segs.length){
    for (const s of segs){
      const t1 = Math.max(0, s.start)
      const t2 = Math.min(clipDur, Math.max(t1+0.4, s.end))
      if (t1>=clipDur) break
      const txt = wrapTwoLines(s.text)
      const escTxt = esc(txt)
      const fontSpec = CAPTION_FONT_FILE ? `:fontfile='${CAPTION_FONT_FILE}'` : ''
      filters.push(`${chain};drawtext=text='${escTxt}':fontsize=${CAPTION_FONT_SIZE}:fontcolor=${CAPTION_COLOR}${fontSpec}:x=(w-text_w)/2:y=${CAPTION_SAFE_Y}:box=1:boxcolor=${CAPTION_BOXCOLOR}@${CAPTION_BOX_OPACITY}:boxborderw=24:line_spacing=10:enable='between(t,${t1.toFixed(2)},${t2.toFixed(2)})'[${chain}c]`)
      chain=`${chain}c`
    }
  }

  await new Promise((resolve,reject)=>{
    ff()(tin).inputOption('-nostdin')
      .outputOptions(['-y','-nostdin','-threads','1','-preset','veryfast','-t', String(clipDur),'-r','30','-crf','28'])
      .complexFilter(filters)
      .outputOptions(['-map',`[${chain}]`,'-map','0:a','-shortest'])
      .videoCodec('libx264').audioCodec('aac')
      .on('start', c=>log('ffmpeg(shorts) start', c))
      .on('stderr', l=>{ if(FFMPEG_LOG) log('ffmpeg:', l)})
      .on('end', resolve).on('error', reject).save(tout)
  })

  const base = path.basename(sourceKey).replace(/\.[^/.]+$/, '')
  const outKey = `shorts/${base}-9x16.mp4`
  await s3UploadBuffer(outKey, fs.readFileSync(tout), 'video/mp4')
  try{ fs.unlinkSync(tin) }catch{}; try{ fs.unlinkSync(tout) }catch{}
  return outKey
}

// ---- Jobs storage ----
const SHORT_JOBS_KEY = 'meta/_shorts_jobs.json'
async function readShortJobs(){ const t = await s3GetText(SHORT_JOBS_KEY); if(!t) return {queue:[],items:{}}; try{return JSON.parse(t)}catch{return{queue:[],items:{}}} }
async function writeShortJobs(j){ await s3UploadBuffer(SHORT_JOBS_KEY, Buffer.from(JSON.stringify(j,null,2)), 'application/json') }

const VIDEO_JOBS_KEY = 'meta/_video_jobs.json'
async function readVideoJobs(){ const t = await s3GetText(VIDEO_JOBS_KEY); if(!t) return {queue:[],items:{}}; try{return JSON.parse(t)}catch{return{queue:[],items:{}}} }
async function writeVideoJobs(j){ await s3UploadBuffer(VIDEO_JOBS_KEY, Buffer.from(JSON.stringify(j,null,2)), 'application/json') }

// ---- API: Spectral video queue ----
app.post('/api/generate-video', requireAdmin, async (req,res)=>{
  const { filename, title } = req.body||{}
  if(!filename) return res.status(400).json({error:'filename required'})
  const id=Math.random().toString(36).slice(2)+Date.now().toString(36)
  const jobs=await readVideoJobs()
  jobs.items[id]={ id, filename, title, status:'queued', attempts:0, nextTryAt:Date.now(), createdAt:Date.now() }
  jobs.queue.push(id); await writeVideoJobs(jobs)
  return res.json({ ok:true, id, status:'queued' })
})

app.get('/api/video/:id/status', async (req,res)=>{
  const jobs = await readVideoJobs(); const j = jobs.items[req.params.id]; if(!j) return res.status(404).json({error:'not found'})
  res.json(j)
})

app.post('/api/video/process-now', requireAdmin, async (req,res)=>{
  const { id } = req.query; if(!id) return res.status(400).json({error:'id required'})
  const jobs = await readVideoJobs(); const job = jobs.items[id]; if(!job) return res.status(404).json({error:'job not found'})
  job.status='processing'; await writeVideoJobs(jobs)
  try{
    const outKey = await renderSpectralVideo(job.filename, job.title)
    job.status='done'; job.output=outKey; await writeVideoJobs(jobs)
    res.json({ ok:true, id, output: outKey, url: publicUrlForKey(outKey) })
  }catch(e){
    job.status='error'; job.error=String(e); await writeVideoJobs(jobs)
    res.status(500).json({error:'ffmpeg failed', details:String(e)})
  }
})

// ---- API: Shorts queue ----
app.post('/api/shorts/request', requireAdmin, async (req,res)=>{
  if(!SHORTS_ENABLED) return res.status(400).json({error:'Shorts disabled'})
  const { filename, title, maxSeconds } = req.body||{}
  if(!filename) return res.status(400).json({error:'filename required'})
  const id=Math.random().toString(36).slice(2)+Date.now().toString(36)
  const jobs = await readShortJobs()
  jobs.items[id] = { id, filename, title: title||'', maxSeconds: Number(maxSeconds)||SHORTS_MAX_SECONDS, status:'queued', createdAt:Date.now() }
  jobs.queue.push(id); await writeShortJobs(jobs)
  res.json({ ok:true, id, status:'queued' })
})

app.get('/api/shorts/:id/status', async (req,res)=>{
  const jobs = await readShortJobs(); const j = jobs.items[req.params.id]; if(!j) return res.status(404).json({error:'not found'})
  res.json(j)
})

app.get('/api/shorts', async (_req,res)=>{
  const jobs = await readShortJobs()
  const done = Object.values(jobs.items).filter(j=>j.status==='done').sort((a,b)=>b.createdAt-a.createdAt)
  res.json(done.map(j=>({ id:j.id, source:j.filename, output:j.output, url: j.output?publicUrlForKey(j.output):null, createdAt:j.createdAt })))
})

app.post('/api/shorts/process-now', requireAdmin, async (req,res)=>{
  const { id } = req.query; if(!id) return res.status(400).json({error:'id required'})
  const jobs = await readShortJobs(); const job = jobs.items[id]; if(!job) return res.status(404).json({error:'job not found'})
  job.status='processing'; await writeShortJobs(jobs)
  try{
    const outKey = await renderShort(job.filename, job.title||'')
    job.status='done'; job.output=outKey; await writeShortJobs(jobs)
    res.json({ ok:true, id, output: outKey, url: publicUrlForKey(outKey) })
  }catch(e){
    job.status='error'; job.error=String(e); await writeShortJobs(jobs)
    res.status(500).json({error:'ffmpeg failed', details:String(e)})
  }
})

// ---- API: Thumbnail ----
app.post('/api/thumbnail', requireAdmin, async (req,res)=>{
  const { title, bg } = req.body||{}
  const tmp = await makeThumbnailJpg(title||BRAND_NAME, bg||MASTHEAD_COLOR, 1080, 1080)
  const key = `thumbs/${Date.now()}-thumb.jpg`
  await s3UploadBuffer(key, fs.readFileSync(tmp), 'image/jpeg')
  try{ fs.unlinkSync(tmp) }catch{}
  res.json({ key, url: publicUrlForKey(key) })
})

// ---- Boot ----
const PORT = process.env.PORT || 10000
app.listen(PORT, ()=> console.log('Backend listening on', PORT))
