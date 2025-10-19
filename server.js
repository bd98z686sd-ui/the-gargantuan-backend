import express from 'express'
import cors from 'cors'
import morgan from 'morgan'
import multer from 'multer'
import dotenv from 'dotenv'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { v4 as uuidv4 } from 'uuid'
import fs from 'fs'
import path from 'path'

dotenv.config()

const app = express()
app.use(cors())
app.use(morgan('tiny'))
app.use(express.json({ limit: '10mb' }))

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'change-me-strong'
const PORT = process.env.PORT || 10000

// Simple file JSON "DB"
const DB_PATH = path.join(process.cwd(), 'data', 'posts.json')
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, '[]')
const readPosts = () => JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))
const writePosts = (rows) => fs.writeFileSync(DB_PATH, JSON.stringify(rows, null, 2))

// R2 client
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

const auth = (req, res, next) => {
  const t = req.header('x-admin-token')
  if (!t || t !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' })
  next()
}

const upload = multer({ storage: multer.memoryStorage() })

// Health
app.get('/api/health', (req,res)=> res.json({ ok:true }))

// List posts
app.get('/api/posts', (req,res)=>{
  const rows = readPosts().filter(p=>!p.deleted)
  rows.sort((a,b)=> new Date(b.date) - new Date(a.date))
  res.json(rows)
})

// Create text/image/audio post metadata
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
  const rows = readPosts()
  rows.push(post); writePosts(rows)
  res.json(post)
})

// Update post
app.patch('/api/posts/:id', auth, (req,res)=>{
  const rows = readPosts()
  const idx = rows.findIndex(p=>p.id === req.params.id)
  if (idx === -1) return res.status(404).json({error:'not found'})
  rows[idx] = { ...rows[idx], ...req.body }
  writePosts(rows)
  res.json(rows[idx])
})

// Soft delete / restore
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
    const file = req.file || null
    let kind = 'audio'
    if (!file) {
      // try image field
      const up = upload.single('image')
      return up(req,res, async (err)=>{
        if (err) return res.status(400).json({error:'upload failed'})
        if (!req.file) return res.status(400).json({error:'no file'})
        return handleUpload(req, res, 'image')
      })
    }
    return handleUpload(req,res,kind)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'upload failed' })
  }
})

async function handleUpload(req,res, kind) {
  const file = req.file
  const ext = (file.originalname.split('.').pop() || '').toLowerCase()
  const key = `${kind}/${Date.now()}-${file.originalname.replace(/\s+/g,'-')}`

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype
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
  const rows = readPosts()
  rows.push(post); writePosts(rows)
  res.json(post)
}

// Generate "video" (stub: mark videoUrl derived from audio filename)
app.post('/api/generate-video', auth, (req,res)=>{
  const { filename, title } = req.body || {}
  if (!filename) return res.status(400).json({ error:'filename required' })
  const rows = readPosts()
  const idx = rows.findIndex(p=>p.filename === filename || p.audioUrl?.includes(filename))
  if (idx === -1) return res.status(404).json({error:'post not found'})
  const mp4Key = filename.replace(/^audio\//,'video/').replace(/\.[^.]+$/, '.mp4')
  rows[idx].videoUrl = `${process.env.S3_PUBLIC_BASE}/${mp4Key}`
  writePosts(rows)
  res.json({ ok:true, videoUrl: rows[idx].videoUrl })
})

// Shorts endpoints (stubs for now)
app.get('/api/shorts', (req,res)=> res.json([]))

app.listen(PORT, ()=> {
  console.log('Backend listening on', PORT)
})