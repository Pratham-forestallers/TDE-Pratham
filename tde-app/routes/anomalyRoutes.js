const express = require('express');
const { generateAnomalies } = require('../services/anomalyService');

const router = express.Router();

router.post('/run', async (req, res, next) => {
  try {
    const result = await generateAnomalies(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
