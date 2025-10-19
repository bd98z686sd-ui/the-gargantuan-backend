import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import multer from 'multer'
import dotenv from 'dotenv'
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import fetch from 'node-fetch'
import OpenAI from 'openai'

dotenv.config()
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(cors())
app.use(morgan('tiny'))
app.use(express.json({ limit: '10mb' }))

const PORT = process.env.PORT || 10000
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-strong'

// Data store (JSON file for simplicity)
const DB_PATH = path.join(__dirname, 'data', 'posts.json')
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '[]')
const readPosts = () => JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))
const writePosts = (rows) => fs.writeFileSync(DB_PATH, JSON.stringify(rows, null, 2))

// S3/R2
const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || ''
  }
})
const BUCKET = process.env.S3_BUCKET
const PUBLIC_BASE = process.env.S3_PUBLIC_BASE

// Optional OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null

// Middleware
const auth = (req,res,next)=>{
  const t = req.header('x-admin-token')
  if (!t || t !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' })
  next()
}

// Uploads (memory)
const upload = multer({ storage: multer.memoryStorage() })

// Health
app.get('/api/health', (req,res)=> res.json({ ok:true }))

// Posts
app.get('/api/posts', (req,res)=>{
  const rows = readPosts().filter(p=>!p.deleted)
  rows.sort((a,b)=> new Date(b.date) - new Date(a.date))
  res.json(rows)
})
app.post('/api/posts', auth, (req,res)=>{
  const { title, text, imageUrl, audioUrl, videoUrl } = req.body || {}
  const post = {
    id: uuidv4().slice(0,12),
    title: title || 'Untitled',
    text: text || '',
    imageUrl: imageUrl || '',
    audioUrl: audioUrl || '',
    videoUrl: videoUrl || '',
    date: new Date().toISOString(),
    deleted: false
  }
  const rows = readPosts(); rows.push(post); writePosts(rows)
  res.json(post)
})
app.patch('/api/posts/:id', auth, (req,res)=>{
  const rows = readPosts()
  const idx = rows.findIndex(p=>p.id === req.params.id)
  if (idx === -1) return res.status(404).json({error:'not found'})
  rows[idx] = { ...rows[idx], ...req.body }
  writePosts(rows)
  res.json(rows[idx])
})
app.delete('/api/posts/:id', auth, (req,res)=>{
  const rows = readPosts()
  const idx = rows.findIndex(p=>p.id === req.params.id)
  if (idx === -1) return res.status(404).json({error:'not found'})
  rows[idx].deleted = true
  writePosts(rows)
  res.json({ ok:true })
})
app.post('/api/posts/:id/restore', auth, (req,res)=>{
  const rows = readPosts()
  const idx = rows.findIndex(p=>p.id === req.params.id)
  if (idx === -1) return res.status(404).json({error:'not found'})
  rows[idx].deleted = false
  writePosts(rows)
  res.json({ ok:true })
})

// Upload audio/image to R2
app.post('/api/upload', auth, upload.single('audio'), async (req,res)=>{
  try {
    if (!req.file) {
      const up = upload.single('image')
      return up(req,res, async (err)=>{
        if (err || !req.file) return res.status(400).json({error:'no file'})
        return handleUpload(req,res,'image')
      })
    }
    return handleUpload(req,res,'audio')
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'upload failed' })
  }
})

async function handleUpload(req,res, kind){
  const file = req.file
  const key = `${kind}/${Date.now()}-${file.originalname.replace(/\s+/g,'-')}`
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: key, Body: file.buffer, ContentType: file.mimetype
  }))
  const url = `${PUBLIC_BASE}/${key}`
  const post = {
    id: uuidv4().slice(0,12),
    title: file.originalname.replace(/\.[^.]+$/, ''),
    filename: key,
    audioUrl: kind==='audio'? url : '',
    imageUrl: kind==='image'? url : '',
    videoUrl: '',
    date: new Date().toISOString(),
    deleted: false
  }
  const rows = readPosts(); rows.push(post); writePosts(rows)
  res.json(post)
}

// === Generate spectral video with optional burned captions ===
app.post('/api/generate-video', auth, async (req,res)=>{
  try {
    const { filename, title = 'The Gargantuan', whisper = false } = req.body || {}
    if (!filename) return res.status(400).json({error:'filename required'})
    const rows = readPosts()
    const idx = rows.findIndex(p => p.filename === filename || p.audioUrl?.includes(filename))
    if (idx === -1) return res.status(404).json({error:'post not found'})
    const audioKey = rows[idx].filename || filename

    // Download audio from R2 to /tmp
    const inPath = `/tmp/in-${Date.now()}.mp3`
    await downloadFromR2(audioKey, inPath)

    // Optional: transcribe with Whisper and create SRT
    let srtPath = ''
    if (whisper && openai) {
      const srt = await transcribeToSrt(inPath, title)
      srtPath = `/tmp/sub-${Date.now()}.srt`
      fs.writeFileSync(srtPath, srt, 'utf8')
    }

    const outKey = audioKey.replace(/^audio\//,'video/').replace(/\.[^.]+$/, '.mp4')
    const outPath = `/tmp/out-${Date.now()}.mp4`

    // Build filter_complex (no -vf/-af conflicts)
    // 1080x1920 portrait, blue bg, centered waveform, title at top.
    const font = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
    const blue = "052962"
    let drawTitle = `drawtext=fontfile=${font}:text='${escapeDrawText(title)}':x=(w-text_w)/2:y=80:fontsize=64:fontcolor=white:shadowcolor=black:shadowx=2:shadowy=2`
    let vis = "showwaves=s=1080x1080:mode=cline:colors=white,format=rgba"
    let base = f"color=size=1080x1920:rate=30:color=#{blue}"
    let filters = f"[0:a]{vis}[vis];{base}[bg];[bg][vis]overlay=(W-w)/2:(H-h)/2,{drawTitle}"
    if (srtPath) {
      filters = f"{filters},subtitles='{srtPath.replace(':','\\:')}'"
    }

    const args = [
      "-y",
      "-i", inPath,
      "-filter_complex", filters,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-tune", "stillimage",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-shortest",
      outPath
    ]

    await execFfmpeg(args)

    // Upload MP4 to R2
    const mp4 = fs.readFileSync(outPath)
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: outKey, Body: mp4, ContentType: "video/mp4"
    }))

    // Update post
    rows[idx].videoUrl = `${PUBLIC_BASE}/${outKey}`
    writePosts(rows)

    res.json({ ok:true, videoUrl: rows[idx].videoUrl })
  } catch (e) {
    console.error("generate-video error", e)
    res.status(500).json({ error: 'ffmpeg failed', details: String(e) })
  }
})

function escapeDrawText(s){
  // escape \ : ' for drawtext
  return s.replace(/([\\:'])/g, m => ({'\\':'\\\\',':':'\\:',"'":"\\'"}[m]))
}

// Helpers
async function downloadFromR2(key, outPath){
  // Prefer S3 SDK streaming
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  const stream = obj.Body
  await new Promise((resolve, reject)=>{
    const ws = fs.createWriteStream(outPath)
    stream.on('error', reject)
    ws.on('finish', resolve)
    stream.pipe(ws)
  })
}

function execFfmpeg(args){
  return new Promise((resolve, reject)=>{
    const proc = spawn('ffmpeg', args)
    proc.stderr.on('data', d => process.stdout.write(`[ffmpeg] ${d}`))
    proc.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg exited '+code)))
  })
}

async function transcribeToSrt(audioPath, title){
  // Convert local file to FormData for OpenAI Whisper
  if (!openai) return ''
  const stream = fs.createReadStream(audioPath)
  const transcript = await openai.audio.transcriptions.create({
    file: stream,
    model: "whisper-1",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"]
  })
  // Build simple SRT
  let n = 1
  const lines = []
  for (const seg of (transcript.segments || [])) {
    const start = toSrtTS(seg.start || 0)
    const end = toSrtTS(seg.end || (seg.start+2))
    lines.push(String(n++))
    lines.push(`${start} --> ${end}`)
    lines.push((seg.text || '').trim())
    lines.push('')
  }
  return lines.join('\n')
}

function toSrtTS(t){
  const h = Math.floor(t/3600).toString().padStart(2,'0')
  const m = Math.floor((t%3600)/60).toString().padStart(2,'0')
  const s = Math.floor(t%60).toString().padStart(2,'0')
  const ms = Math.floor((t - Math.floor(t)) * 1000).toString().padStart(3,'0')
  return `${h}:${m}:${s},${ms}`
}

// Shorts (placeholder)
app.get('/api/shorts', (req,res)=> res.json([]))

app.listen(PORT, ()=> console.log('Backend listening on', PORT))