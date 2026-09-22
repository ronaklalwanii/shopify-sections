// Vercel serverless entry: the whole Express app runs from here.
// `stores/`, `data/` and `public/` are bundled via vercel.json includeFiles.
const app = require('../src/server');

module.exports = app;
