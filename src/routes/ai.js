const { Router } = require('express');
const { z } = require('zod');
const { authenticate } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { generateDescription } = require('../services/ai');

const router = Router();
router.use(authenticate());

const schema = z.object({ prompt: z.string().trim().min(3).max(500) });

// Turns a short idea ("fix login bug on mobile") into a full task description.
router.post('/task-description', validate(schema), async (req, res) => {
  res.json(await generateDescription(req.valid.body.prompt));
});

module.exports = router;
