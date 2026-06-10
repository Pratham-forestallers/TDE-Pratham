const express = require('express');
const objectConfig = require('../config/objectConfig');
const { listDestinations } = require('../services/destinationService');
const {
  previewTransfer,
  executeTransfer,
  rollbackRun,
  listRunHistory,
  generateSyntheticCsv
} = require('../services/transferService');


const router = express.Router();
const PINNED_OBJECT_KEYS = [878, 822];

function getObjectSortRank(objectKey) {
  const index = PINNED_OBJECT_KEYS.indexOf(objectKey);
  return index === -1 ? PINNED_OBJECT_KEYS.length : index;
}

function getObjectIdLabel(definition) {
  return definition.objectIdLabel || `${definition.description} ID`;
}

function getObjectIdPlaceholder(definition) {
  return definition.objectIdPlaceholder || `Enter ${definition.description} ID`;
}

router.get('/systems', async (req, res, next) => {
  try {
    const systems = await listDestinations();

    res.json({
      success: true,
      systems
    });
  } catch (error) {
    next(error);
  }
});

router.get('/object-types', (req, res) => {
  const objectTypes = Object.values(objectConfig)
    .filter((definition) => !/^Object \d+$/.test(definition.description || ''))
    .map((definition) => ({
      objectKey: definition.objectKey,
      description: definition.description,
      objectIdLabel: getObjectIdLabel(definition),
      objectIdPlaceholder: getObjectIdPlaceholder(definition)
    }))
    .sort((left, right) => (
      getObjectSortRank(left.objectKey) - getObjectSortRank(right.objectKey) ||
      left.description.localeCompare(right.description)
    ));

  res.json({
    success: true,
    objectTypes
  });
});

router.get('/runs', (req, res) => {
  res.json({
    success: true,
    runs: listRunHistory()
  });
});

router.post('/preview', async (req, res, next) => {
  try {
    const result = await previewTransfer(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/run', async (req, res, next) => {
  try {
    const result = await executeTransfer(req.body);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/download-synthetic', async (req, res, next) => {
  try {
    const { zipBuffer, filename } = await generateSyntheticCsv(req.body);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zipBuffer);
  } catch (error) {
    next(error);
  }
});


router.post('/runs/:traceId/rollback', async (req, res, next) => {
  try {
    const result = await rollbackRun(req.params.traceId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
