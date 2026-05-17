const logger = require('./logger');

class AppError extends Error {
  constructor(message, statusCode = 500, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function notFoundHandler(req, res, next) {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
}

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || err.response?.status || 500;
  const message = err.message || 'Unexpected server error';

  logger.error(message, {
    method: req.method,
    path: req.originalUrl,
    statusCode,
    details: err.details
  });

  res.status(statusCode).json({
    success: false,
    error: {
      message,
      details: err.details
    }
  });
}

module.exports = {
  AppError,
  notFoundHandler,
  errorHandler
};
