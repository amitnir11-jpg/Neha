const router = require('express').Router();
const auth = require('./auth');
const { suggestionsHandler } = require('../services/PartSuggestionService');

router.get('/suggestions', auth.requireAuth, suggestionsHandler);
module.exports = router;
