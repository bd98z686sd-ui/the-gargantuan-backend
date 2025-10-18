import express from 'express'
import cors from 'cors'
import multer from 'multer'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import mime from 'mime-types'
import ffmpeg from 'fluent-ffmpeg'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import OpenAI from 'openai'

const app = express()
const PORT = process.env.PORT || 10000

// ---- ENV ----
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme'
const DATA_DIR = process.env.DATA_DIR || '/app/data'
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads'
const USE_S3 = !!process.env.S3_BUCKET
const S3_BUCKET = process.env.S3_BUCKET
const S3_PUBLIC_BASE = process.env.S3_PUBLIC_BASE || ''
const S3_ENDPOINT = process.env.S3_ENDPOINT
const S3_REGION = process.env.S3_REGION || 'auto'
const VIDEO_MAX_SECONDS = Number(process.env.VIDEO_MAX_SECONDS || 120)
const SHORTS_MAX_SECONDS = Number(process.env.SHORTS_MAX_SECONDS || 45)
const CAPTIONS_ENABLED = String(process.env.CAPTIONS_ENABLED || 'true') === 'true'
const SHORTS_ENABLED = String(process.env.SHORTS_ENABLED || 'true') === 'true'
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''

const s3 = USE_S3 ? new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  credentials: (process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY) ? {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
  } : undefined,
}) : null

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null

// ---- APP ----
app.use(cors())
app.use(express.json())
await fsp.mkdir(DATA_DIR, { recursive: true })
await fsp.mkdir(UPLOAD_DIR, { recursive: true })

function requireAdmin(req,res,next){
  if((req.headers['x-admin-token']||'') !== ADMIN_TOKEN){
    return res.status(401).json({error:'unauthorized'})
  }
  next()
}

const POSTS_JSON = path.join(DATA_DIR,'posts.json')
async function readPosts(){ try{ return JSON.parse(await fsp.readFile(POSTS_JSON,'utf-8')) } catch{ return [] } }
async function writePosts(list){ await fsp.mkdir(DATA_DIR,{recursive:true}); await fsp.writeFile(POSTS_JSON, JSON.stringify(list,null,2)) }

function publicUrlFor(key){
  if(USE_S3) return (S3_PUBLIC_BASE ? (S3_PUBLIC_BASE.replace(/\/$/,'') + '/' + key) : '')
  return '/uploads/'+key
}
async function putFileLocal(buffer, key){
  const filePath = path.join(UPLOAD_DIR, key)
  await fsp.mkdir(path.dirname(filePath),{recursive:true})
  await fsp.writeFile(filePath, buffer)
  return '/uploads/'+key
}
async function putFileS3(buffer, key, contentType){
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: buffer, ContentType: contentType }))
  return publicUrlFor(key)
}

// static (local only)
app.use('/uploads', express.static(UPLOAD_DIR))

// ---- UPLOAD ----
const storage = multer.memoryStorage()
const upload = multer({ storage })

app.post('/api/upload', requireAdmin, upload.single('audio'), async (req,res)=>{
  if(!req.file) return res.status(400).json({error:'no file'})
  const stamp = Date.now()
  const safe = (req.file.originalname||'audio').replace(/[^A-Za-z0-9._-]+/g,'-')
  const key = `audio/${stamp}-${safe}`
  const contentType = req.file.mimetype || mime.lookup(safe) || 'application/octet-stream'
  const url = USE_S3 ? await putFileS3(req.file.buffer, key, contentType) : await putFileLocal(req.file.buffer, key)
  const posts = await readPosts()
  const post = { id:key, filename:key, title: safe.replace(/\.[^.]+$/,''), audioUrl: publicUrlFor(key), createdAt: Date.now() }
  posts.push(post); await writePosts(posts)
  res.json({ filename:key, title: post.title, audioUrl: post.audioUrl })
})

// ---- POSTS ----
app.get('/api/posts', async (req,res)=>{
  let list = await readPosts()
  const q = (req.query.q||'').toString().toLowerCase()
  const includeDeleted = 'includeDeleted' in req.query
  const onlyDeleted = 'deleted' in req.query
  if(!includeDeleted && !onlyDeleted) list = list.filter(p=>!p.deleted)
  if(onlyDeleted) list = list.filter(p=>!!p.deleted)
  if(q) list = list.filter(p => (p.title||'').toLowerCase().includes(q) || (p.filename||'').toLowerCase().includes(q))
  list.sort((a,b)=>(new Date(b.createdAt||0)) - (new Date(a.createdAt||0)))
  res.json(list)
})

app.patch('/api/posts/:id', requireAdmin, async (req,res)=>{
  const id = req.params.id; const { title } = req.body||{}
  const posts = await readPosts(); const i = posts.findIndex(p => (p.id||p.filename) === id)
  if(i<0) return res.status(404).json({error:'not found'})
  if(title) posts[i].title = title; posts[i].updatedAt = Date.now(); await writePosts(posts)
  res.json({ ok:true })
})
app.post('/api/posts/:id/title', requireAdmin, async (req,res)=>{
  const id = req.params.id; const { title } = req.body||{}
  const posts = await readPosts(); const i = posts.findIndex(p => (p.id||p.filename) === id)
  if(i<0) return res.status(404).json({error:'not found'})
  if(title) posts[i].title = title; posts[i].updatedAt = Date.now(); await writePosts(posts)
  res.json({ ok:true })
})
app.delete('/api/posts/:id', requireAdmin, async (req,res)=>{
  const id = req.params.id; const posts = await readPosts(); const i = posts.findIndex(p => (p.id||p.filename) === id)
  if(i<0) return res.status(404).json({error:'not found'})
  posts[i].deleted = true; posts[i].updatedAt = Date.now(); await writePosts(posts); res.json({ ok:true })
})
app.post('/api/posts/:id/delete', requireAdmin, async (req,res)=>{
  const id = req.params.id; const posts = await readPosts(); const i = posts.findIndex(p => (p.id||p.filename) === id)
  if(i<0) return res.status(404).json({error:'not found'})
  posts[i].deleted = true; posts[i].updatedAt = Date.now(); await writePosts(posts); res.json({ ok:true })
})
app.post('/api/posts/:id/restore', requireAdmin, async (req,res)=>{
  const id = req.params.id; const posts = await readPosts(); const i = posts.findIndex(p => (p.id||p.filename) === id)
  if(i<0) return res.status(404).json({error:'not found'})
  posts[i].deleted = false; posts[i].updatedAt = Date.now(); await writePosts(posts); res.json({ ok:true })
})

// ---- CAPTIONS (Whisper → SRT) ----
async function transcribeToSrt(localAudioPath){
  if(!openai || !CAPTIONS_ENABLED) return null
  try{
    const file = await fsp.readFile(localAudioPath)
    const resp = await openai.audio.transcriptions.create({
      file, model: "whisper-1", response_format: "srt", temperature: 0.2
    })
    // SDK returns text directly for srt
    return (typeof resp === 'string') ? resp : (resp.text || null)
  }catch(e){
    console.error('transcribe error', e)
    return null
  }
}

async function ensureLocalAudio(filename){
  const local = path.join(UPLOAD_DIR, filename)
  await fsp.mkdir(path.dirname(local), { recursive:true })
  if(USE_S3){
    const { Body } = await s3.send(new GetObjectCommand({ Bucket:S3_BUCKET, Key:filename }))
    const buf = Buffer.from(await Body.transformToByteArray())
    await fsp.writeFile(local, buf)
  } else {
    if(!fs.existsSync(local)) throw new Error('audio not found')
  }
  return local
}

function outKeyFor(baseKey, kind){
  const base = baseKey.replace(/^audio\//,'').replace(/\.[^.]+$/,'')
  return `video/${base}-${kind}.mp4`
}

async function burnWaveformWithCaptions({ localAudio, canvas="1080x1080", kind="video", maxSeconds=0, srtPath=null }){
  const outLocal = path.join(UPLOAD_DIR, outKeyFor(path.basename(localAudio).startsWith('audio/')?path.basename(localAudio):localAudio.replace(UPLOAD_DIR+'/','audio/'), kind))
  await fsp.mkdir(path.dirname(outLocal), { recursive:true })
  const filters = [
    `color=c=0x052962:s=${canvas}:d=30[bg]`,
    `[0:a]showwaves=s=${canvas.split('x')[0]}x${Math.min(400, Number(canvas.split('x')[1]) - 680)}:mode=line:rate=25:colors=0xc70000@1.0[w]`,
    `[bg][w]overlay=(W-w)/2:(H-h)/2[base]`,
  ]
  if(srtPath){
    // burn in subtitles on the composed video
    const esc = srtPath.replace(/\\/g,'\\\\').replace(/:/g,'\\:').replace(/'/g,"\\'")
    filters.push(`[base]subtitles='${esc}':force_style='Fontname=Inter,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,Outline=1,Shadow=0,Fontsize=36'[v]`)
  } else {
    filters.push(`[base]copy[v]`)
  }

  await new Promise((resolve,reject)=>{
    const cmd = ffmpeg().input(localAudio).inputOptions(['-thread_queue_size 512'])
    cmd.complexFilter(filters, ['v'])
    if(maxSeconds>0){ cmd.outputOptions(['-t', String(maxSeconds)]) }
    cmd
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions(['-shortest','-preset','veryfast','-crf','23','-pix_fmt','yuv420p'])
      .output(outLocal)
      .on('end', resolve)
      .on('error', reject)
      .run()
  })
  return outLocal
}

// ---- Generate full video with captions ----
app.post('/api/generate-video', requireAdmin, async (req,res)=>{
  try{
    const { filename } = req.body||{}
    if(!filename) return res.status(400).json({error:'filename required'})
    const localAudio = await ensureLocalAudio(filename)
    let srtPath = null
    if(CAPTIONS_ENABLED){
      const srt = await transcribeToSrt(localAudio)
      if(srt){
        srtPath = path.join(UPLOAD_DIR, 'captions', filename.replace(/^audio\//,'').replace(/\.[^.]+$/,'') + '.srt')
        await fsp.mkdir(path.dirname(srtPath), { recursive:true })
        await fsp.writeFile(srtPath, srt)
      }
    }
    const outLocal = await burnWaveformWithCaptions({ localAudio, canvas:"1080x1080", kind:"video", maxSeconds: VIDEO_MAX_SECONDS, srtPath })
    // Upload result if S3
    let videoKey = outLocal.replace(UPLOAD_DIR + '/', '')
    let videoUrl = publicUrlFor(videoKey)
    if(USE_S3){
      const buf = await fsp.readFile(outLocal)
      await s3.send(new PutObjectCommand({ Bucket:S3_BUCKET, Key:videoKey, Body:buf, ContentType:'video/mp4' }))
      videoUrl = publicUrlFor(videoKey)
    }
    const posts = await readPosts(); const i = posts.findIndex(p => (p.id||p.filename) === filename)
    if(i>=0){ posts[i].videoUrl = videoUrl; posts[i].updatedAt = Date.now(); await writePosts(posts) }
    res.json({ ok:true, videoUrl })
  }catch(e){
    console.error('generate error', e)
    res.status(500).json({ error:'ffmpeg or captions failed', details: String(e) })
  }
})

// ---- Generate short (vertical) with captions ----
app.post('/api/generate-short', requireAdmin, async (req,res)=>{
  try{
    if(!SHORTS_ENABLED) return res.status(400).json({error:'shorts disabled'})
    const { filename, maxSeconds } = req.body||{}
    if(!filename) return res.status(400).json({error:'filename required'})
    const localAudio = await ensureLocalAudio(filename)
    let srtPath = null
    if(CAPTIONS_ENABLED){
      const srt = await transcribeToSrt(localAudio)
      if(srt){
        srtPath = path.join(UPLOAD_DIR, 'captions', filename.replace(/^audio\//,'').replace(/\.[^.]+$/,'') + '.srt')
        await fsp.mkdir(path.dirname(srtPath), { recursive:true })
        await fsp.writeFile(srtPath, srt)
      }
    }
    const outLocal = await burnWaveformWithCaptions({ localAudio, canvas:"1080x1920", kind:"short", maxSeconds: Number(maxSeconds||SHORTS_MAX_SECONDS), srtPath })
    let shortKey = outLocal.replace(UPLOAD_DIR + '/', '')
    let shortUrl = publicUrlFor(shortKey)
    if(USE_S3){
      const buf = await fsp.readFile(outLocal)
      await s3.send(new PutObjectCommand({ Bucket:S3_BUCKET, Key:shortKey, Body:buf, ContentType:'video/mp4' }))
      shortUrl = publicUrlFor(shortKey)
    }
    const posts = await readPosts(); const i = posts.findIndex(p => (p.id||p.filename) === filename)
    if(i>=0){ posts[i].shortUrl = shortUrl; posts[i].updatedAt = Date.now(); await writePosts(posts) }
    res.json({ ok:true, shortUrl })
  }catch(e){
    console.error('short error', e)
    res.status(500).json({ error:'ffmpeg or captions failed', details: String(e) })
  }
})

app.get('/', (_req,res)=>res.send('OK'))
app.listen(PORT, ()=>console.log('Backend listening on', PORT))
