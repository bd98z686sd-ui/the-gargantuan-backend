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
import OpenAI from 'openai'

dotenv.config()
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
app.use(cors())
app.use(morgan('tiny'))
app.use(express.json({ limit: '15mb' }))

const PORT = process.env.PORT || 10000
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-strong'

// Data store
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

// Optional OpenAI for captions
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null

// Middleware
const auth = (req, res, next) => {
  const t = req.header('x-admin-token')
  if (!t || t !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' })
  next()
}

// Upload
const upload = multer({ storage: multer.memoryStorage() })

// Health
app.get('/api/health', (req,res)=> res.json({ ok: true }))

// Posts
app.get('/api/posts', (req,res)=>{
  const rows = readPosts().filter(p=>!p.deleted)
  rows.sort((a,b)=> new Date(b.date) - new Date(a.date))
  res.json(rows)
})

app.post('/api/posts', auth, (req,res)=>{
  const { title, text, tagline, imageUrl, audioUrl, videoUrl } = req.body || {}
  const post = {
    id: uuidv4().slice(0,12),
    title: title || 'Untitled',
    text: text || '',
    tagline: tagline || '',
    imageUrl: imageUrl || '',
    audioUrl: audioUrl || '',
    videoUrl: videoUrl || '',
    filename: '',
    date: new Date().toISOString(),
    deleted: false
  }
  const rows = readPosts(); rows.push(post); writePosts(rows)
  res.json(post)
})

app.patch('/api/posts/:id', auth, (req,res)=>{
  const rows = readPosts()
  const idx = rows.findIndex(p=>p.id===req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'not found' })
  rows[idx] = { ...rows[idx], ...req.body }
  writePosts(rows)
  res.json(rows[idx])
})

app.post('/api/posts/bulk-delete', auth, (req,res)=>{
  const { ids = [] } = req.body || {}
  const rows = readPosts()
  let count = 0
  for (const id of ids) {
    const i = rows.findIndex(p=>p.id===id)
    if (i !== -1 && !rows[i].deleted) { rows[i].deleted = true; count++ }
  }
  writePosts(rows)
  res.json({ ok:true, deleted: count })
})

app.post('/api/posts/bulk-restore', auth, (req,res)=>{
  const { ids = [] } = req.body || {}
  const rows = readPosts()
  let count = 0
  for (const id of ids) {
    const i = rows.findIndex(p=>p.id===id)
    if (i !== -1 && rows[i].deleted) { rows[i].deleted = false; count++ }
  }
  writePosts(rows)
  res.json({ ok:true, restored: count })
})

app.delete('/api/posts/:id', auth, (req,res)=>{
  const rows = readPosts()
  const idx = rows.findIndex(p=>p.id===req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'not found' })
  rows[idx].deleted = true
  writePosts(rows)
  res.json({ ok:true })
})

app.post('/api/posts/:id/restore', auth, (req,res)=>{
  const rows = readPosts()
  const idx = rows.findIndex(p=>p.id===req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'not found' })
  rows[idx].deleted = false
  writePosts(rows)
  res.json({ ok:true })
})

// Upload audio/image → R2 + create post
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
    tagline: '',
    text: '',
    date: new Date().toISOString(),
    deleted: false
  }
  const rows = readPosts(); rows.push(post); writePosts(rows)
  res.json(post)
}

// ===== ffmpeg spectral video with optional Whisper captions =====
app.post('/api/generate-video', auth, async (req,res)=>{
  try {
    const { filename, title = 'The Gargantuan', whisper = false } = req.body || {}
    if (!filename) return res.status(400).json({error:'filename required'})
    const rows = readPosts()
    const idx = rows.findIndex(p => p.filename === filename || p.audioUrl?.includes(filename))
    if (idx === -1) return res.status(404).json({error:'post not found'})
    const audioKey = rows[idx].filename || filename

    // Download audio
    const inPath = `/tmp/in-${Date.now()}.mp3`
    await downloadFromR2(audioKey, inPath)

    // Optional captions
    let srtPath = ''
    if (whisper && openai) {
      const srt = await transcribeToSrt(inPath)
      srtPath = `/tmp/sub-${Date.now()}.srt`
      fs.writeFileSync(srtPath, srt, 'utf8')
    }

    const outKey = audioKey.replace(/^audio\//,'video/').replace(/\.[^.]+$/, '.mp4')
    const outPath = `/tmp/out-${Date.now()}.mp4`

    const font = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
    const blue = "052962"
    function esc(s){return s.replace(/([\\:'])/g, m => ({'\\':'\\\\',':':'\\:',"'":"\\'"}[m]))}

    const drawTitle = `drawtext=fontfile=${font}:text='${esc(title)}':x=(w-text_w)/2:y=80:fontsize=64:fontcolor=white:shadowcolor=black:shadowx=2:shadowy=2`
    const vis = "showwaves=s=1080x1080:mode=cline:colors=white,format=rgba"
    const base = "color=size=1080x1920:rate=30:color=#" + blue

    let filters = `[0:a]${vis}[vis];${base}[bg];[bg][vis]overlay=(W-w)/2:(H-h)/2,${drawTitle}`
    if (srtPath) filters += `,subtitles='${srtPath.replace(':','\\:')}'`

    const args = ["-y","-i",inPath,"-filter_complex",filters,"-c:v","libx264","-preset","veryfast","-tune","stillimage","-pix_fmt","yuv420p","-c:a","aac","-shortest",outPath]
    await execFfmpeg(args)

    const mp4 = fs.readFileSync(outPath)
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: outKey, Body: mp4, ContentType: "video/mp4" }))

    rows[idx].videoUrl = `${PUBLIC_BASE}/${outKey}`
    writePosts(rows)
    res.json({ ok:true, videoUrl: rows[idx].videoUrl })
  } catch (e) {
    console.error("generate-video error", e)
    res.status(500).json({ error: 'ffmpeg failed', details: String(e) })
  }
})

import { GetObjectCommand } from '@aws-sdk/client-s3'
async function downloadFromR2(key, outPath){
  const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
  await new Promise((resolve, reject)=>{
    const ws = fs.createWriteStream(outPath)
    obj.Body.on('error', reject)
    ws.on('finish', resolve)
    obj.Body.pipe(ws)
  })
}
function execFfmpeg(args){
  return new Promise((resolve, reject)=>{
    const p = spawn('ffmpeg', args)
    p.stderr.on('data', d => process.stdout.write(`[ffmpeg] ${d}`))
    p.on('close', code => code===0 ? resolve() : reject(new Error('ffmpeg exited '+code)))
  })
}
async function transcribeToSrt(audioPath){
  if (!openai) return ''
  const f = fs.createReadStream(audioPath)
  const resp = await openai.audio.transcriptions.create({ file: f, model: "whisper-1", response_format: "verbose_json", timestamp_granularities: ["segment"] })
  let i=1, out=[]
  for (const seg of (resp.segments||[])){
    const start = toTS(seg.start||0), end = toTS(seg.end|| (seg.start+2))
    out.push(String(i++)); out.push(`${start} --> ${end}`); out.push((seg.text||'').trim()); out.push('')
  }
  return out.join('\n')
}
function toTS(t){ const h=String(Math.floor(t/3600)).padStart(2,'0'); const m=String(Math.floor((t%3600)/60)).padStart(2,'0'); const s=String(Math.floor(t%60)).padStart(2,'0'); const ms=String(Math.floor((t-Math.floor(t))*1000)).padStart(3,'0'); return `${h}:${m}:${s},${ms}` }

// Shorts placeholder
app.get('/api/shorts', (req,res)=> res.json([]))
// Export helper suggestions
app.post('/api/export/suggest', express.json(), (req,res)=>{
  const { text='' } = req.body||{}
  const first = String(text).trim().split(/[.!?\n]/).find(Boolean) || 'New Short: Thoughts & Audio'
  const title = first.slice(0,80)
  const words = (text||'').toLowerCase().match(/[a-z0-9]{3,}/g) || []
  const freq = {}
  for (const w of words) freq[w]=(freq[w]||0)+1
  const top = Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([w])=>`#${w}`)
  const base = ['#shorts','#ai','#music','#spokenword'].filter(h=>!top.includes(h))
  const hashtags = [...top, ...base].slice(0,10)
  res.json({ title, hashtags })
})


app.listen(PORT, ()=> console.log('Backend listening on', PORT))