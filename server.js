import express from 'express'
import cors from 'cors'
import multer from 'multer'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import mime from 'mime-types'
import ffmpeg from 'fluent-ffmpeg'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'

const app = express()
const PORT = process.env.PORT || 10000

// ---- ENV ----
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'changeme'
const DATA_DIR = process.env.DATA_DIR || '/app/data'
const UPLOAD_DIR = process.env.UPLOAD_DIR || '/app/uploads'
const USE_S3 = !!process.env.S3_BUCKET
const S3_BUCKET = process.env.S3_BUCKET
const S3_PUBLIC_BASE = process.env.S3_PUBLIC_BASE || '' // e.g. https://your-bucket.r2.dev
const s3 = USE_S3 ? new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT, // e.g. https://<accountid>.r2.cloudflarestorage.com
  credentials: process.env.S3_ACCESS_KEY_ID ? {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
  } : undefined,
}) : null

// ---- MISC ----
app.use(cors())
app.use(express.json())
await fsp.mkdir(DATA_DIR, { recursive: true })
await fsp.mkdir(UPLOAD_DIR, { recursive: true })

// ---- AUTH ----
function requireAdmin(req,res,next){
  if((req.headers['x-admin-token']||'') !== ADMIN_TOKEN){
    return res.status(401).json({error:'unauthorized'})
  }
  next()
}

// ---- STORAGE HELPERS ----
const POSTS_JSON = path.join(DATA_DIR,'posts.json')
async function readPosts(){
  try{
    return JSON.parse(await fsp.readFile(POSTS_JSON,'utf-8'))
  }catch{ return [] }
}
async function writePosts(list){
  await fsp.mkdir(DATA_DIR,{recursive:true})
  await fsp.writeFile(POSTS_JSON, JSON.stringify(list,null,2))
}

async function putFileLocal(buffer, key){
  const filePath = path.join(UPLOAD_DIR, key)
  await fsp.mkdir(path.dirname(filePath),{recursive:true})
  await fsp.writeFile(filePath, buffer)
  return '/uploads/'+key
}
async function putFileS3(buffer, key, contentType){
  const Key = key
  await s3.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key, Body: buffer, ContentType: contentType }))
  return (S3_PUBLIC_BASE ? (S3_PUBLIC_BASE.replace(/\/$/,'') + '/' + Key) : '') || ('s3://'+S3_BUCKET+'/'+Key)
}
function publicUrlFor(key){
  if(USE_S3) return (S3_PUBLIC_BASE ? (S3_PUBLIC_BASE.replace(/\/$/,'') + '/' + key) : '')
  return '/uploads/'+key
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
  const post = {
    id: key, filename: key,
    title: safe.replace(/\.[^.]+$/,''),
    audioUrl: publicUrlFor(key),
    createdAt: Date.now()
  }
  posts.push(post); await writePosts(posts)
  res.json({ filename:key, title: post.title, audioUrl: post.audioUrl })
})

// ---- POSTS LIST ----
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

// ---- EDIT / DELETE ----
app.patch('/api/posts/:id', requireAdmin, async (req,res)=>{
  const id = req.params.id
  const { title } = req.body||{}
  const posts = await readPosts()
  const i = posts.findIndex(p => (p.id||p.filename) === id)
  if(i<0) return res.status(404).json({error:'not found'})
  if(title) posts[i].title = title
  posts[i].updatedAt = Date.now()
  await writePosts(posts)
  res.json({ ok:true })
})
app.post('/api/posts/:id/title', requireAdmin, async (req,res)=>{
  const id = req.params.id
  const { title } = req.body||{}
  const posts = await readPosts()
  const i = posts.findIndex(p => (p.id||p.filename) === id)
  if(i<0) return res.status(404).json({error:'not found'})
  if(title) posts[i].title = title
  posts[i].updatedAt = Date.now()
  await writePosts(posts)
  res.json({ ok:true })
})

app.delete('/api/posts/:id', requireAdmin, async (req,res)=>{
  const id = req.params.id
  const posts = await readPosts()
  const i = posts.findIndex(p => (p.id||p.filename) === id)
  if(i<0) return res.status(404).json({error:'not found'})
  posts[i].deleted = true; posts[i].updatedAt = Date.now()
  await writePosts(posts); res.json({ ok:true })
})
app.post('/api/posts/:id/delete', requireAdmin, async (req,res)=>{
  const id = req.params.id
  const posts = await readPosts()
  const i = posts.findIndex(p => (p.id||p.filename) === id)
  if(i<0) return res.status(404).json({error:'not found'})
  posts[i].deleted = true; posts[i].updatedAt = Date.now()
  await writePosts(posts); res.json({ ok:true })
})
app.post('/api/posts/:id/restore', requireAdmin, async (req,res)=>{
  const id = req.params.id
  const posts = await readPosts()
  const i = posts.findIndex(p => (p.id||p.filename) === id)
  if(i<0) return res.status(404).json({error:'not found'})
  posts[i].deleted = false; posts[i].updatedAt = Date.now()
  await writePosts(posts); res.json({ ok:true })
})

// ---- VIDEO GENERATION (basic waveform on solid bg) ----
async function ensureDir(p){ await fsp.mkdir(p,{recursive:true}) }
function ffOutPathFor(key, kind='video'){
  const base = key.replace(/^audio\//,'').replace(/\.[^.]+$/,'')
  const name = `${base}-${kind}.mp4`
  return path.join(UPLOAD_DIR, 'video', name)
}
function publicVideoUrlFor(key, kind='video'){
  const base = key.replace(/^audio\//,'').replace(/\.[^.]+$/,'')
  const vkey = `video/${base}-${kind}.mp4`
  return publicUrlFor(vkey)
}

app.post('/api/generate-video', requireAdmin, async (req,res)=>{
  const { filename } = req.body||{}
  if(!filename) return res.status(400).json({error:'filename required'})
  // read audio from local or S3
  let audioPath = path.join(UPLOAD_DIR, filename)
  let audioBuffer = null
  if(USE_S3){
    // Prefer streaming from S3 to local temp
    const { Body } = await s3.send(new GetObjectCommand({ Bucket:S3_BUCKET, Key:filename }))
    audioBuffer = Buffer.from(await Body.transformToByteArray())
    await ensureDir(path.dirname(audioPath))
    await fsp.writeFile(audioPath, audioBuffer)
  } else {
    if(!fs.existsSync(audioPath)) return res.status(404).json({error:'audio not found'})
  }
  const outPath = ffOutPathFor(filename,'video')
  await ensureDir(path.dirname(outPath))

  // Simple background + waveform
  await new Promise((resolve, reject)=>{
    ffmpeg()
      .input(audioPath)
      .inputOptions(['-thread_queue_size 512'])
      .complexFilter([
        // create colored bg
        "color=c=0x052962:s=1080x1080:d=30[bg]",
        // waveform
        "[0:a]showwaves=s=1080x400:mode=line:rate=25:colors=0xc70000@1.0[w]",
        // stack
        "[bg][w]overlay=(W-w)/2:(H-h)/2"
      ])
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-shortest',
        '-preset', 'veryfast',
        '-crf', '23',
        '-pix_fmt','yuv420p'
      ])
      .save(outPath)
      .on('end', resolve)
      .on('error', reject)
  })

  // upload result to S3 if enabled
  let videoUrl = publicVideoUrlFor(filename,'video')
  if(USE_S3){
    const vkey = videoUrl.replace(S3_PUBLIC_BASE.replace(/\/$/, '') + '/', '')
    const buf = await fsp.readFile(outPath)
    await s3.send(new PutObjectCommand({ Bucket:S3_BUCKET, Key:vkey, Body:buf, ContentType:'video/mp4' }))
  }

  // record on post
  const posts = await readPosts()
  const i = posts.findIndex(p => (p.id||p.filename) === filename)
  if(i>=0){ posts[i].videoUrl = videoUrl; posts[i].updatedAt = Date.now(); await writePosts(posts) }

  res.json({ ok:true, videoUrl })
})

// very simple placeholder for shorts
app.post('/api/generate-short', requireAdmin, async (req,res)=>{
  const { filename, maxSeconds=45 } = req.body||{}
  if(!filename) return res.status(400).json({error:'filename required'})
  // reuse generate-video but just shorter target name
  const posts = await readPosts()
  const i = posts.findIndex(p => (p.id||p.filename) === filename)
  if(i<0) return res.status(404).json({error:'post not found'})
  // for brevity, point shortUrl to same generated video in this sample
  posts[i].shortUrl = posts[i].videoUrl || ''
  posts[i].updatedAt = Date.now()
  await writePosts(posts)
  res.json({ ok:true, shortUrl: posts[i].shortUrl, maxSeconds })
})

app.get('/', (_req,res)=>res.send('OK'))
app.listen(PORT, ()=>console.log('Backend listening on', PORT))
