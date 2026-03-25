const express = require('express');
const config = require('../config/stellar');
const donationRoutes = require('./donation');
const statsRoutes = require('./stats');

const app = express();

// Middleware
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Routes
app.use('/donations', donationRoutes);
app.use('/stats', statsRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    network: config.network
  });
});

// 404 handler — must come after all routes
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

/**
 * Hardened catch-all error handler.
 * Always returns JSON regardless of error type.
 * Sets Content-Type: application/json before writing the response so that
 * even if res.json() itself throws, the fallback write still carries the
 * correct header.
 *
 * @param {Error} err - The error object passed via next(err)
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next - Required 4-arg signature for Express error middleware
 */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('Error:', err);

  const status = (typeof err.status === 'number' && err.status >= 100 && err.status < 600)
    ? err.status
    : (typeof err.statusCode === 'number' && err.statusCode >= 100 && err.statusCode < 600)
      ? err.statusCode
      : 500;

  const body = {
    success: false,
    error: err.message || 'Internal server error',
    status,
  };

  // Set header first so it is present even if res.json() throws
  res.setHeader('Content-Type', 'application/json');

  try {
    res.status(status).json(body);
  } catch (_jsonErr) {
    // Last-resort fallback: res.json() itself failed — write raw JSON string
    if (!res.headersSent) {
      res.status(status).end(JSON.stringify(body));
    }
  }
});

const PORT = config.port;
app.listen(PORT, () => {
  console.log(`Stellar Micro-Donation API running on port ${PORT}`);
  console.log(`Network: ${config.network}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

module.exports = app;
