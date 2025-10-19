import express from "express";
const router = express.Router();

let jobs = [];

router.get("/", (_, res) => res.json(jobs));
router.post("/", (req, res) => {
  const { filename, maxSeconds = 45 } = req.body;
  const job = { id: Date.now().toString(), filename, maxSeconds, status: "queued" };
  jobs.push(job);
  res.json(job);
});
router.patch("/:id", (req, res) => {
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: "Not found" });
  Object.assign(job, req.body);
  res.json(job);
});

export default router;
