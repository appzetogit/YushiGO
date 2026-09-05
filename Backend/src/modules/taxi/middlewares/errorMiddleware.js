import { ApiError } from '../../../utils/ApiError.js';

export const notFoundHandler = (req, _res, next) => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};

export const errorHandler = (error, _req, res, _next) => {
  const statusCode = error.statusCode || 500;

  if (error.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: Object.values(error.errors).map((entry) => entry.message),
    });
  }

  if (error.code === 11000) {
    return res.status(409).json({
      success: false,
      message: 'Duplicate value error',
      details: error.keyValue,
    });
  }

  return res.status(statusCode).json({
    success: false,
    // Only present when a thrower attached a stable string code (the Student Ride
    // module does). Numeric codes here come from the Mongo driver, not from us,
    // and must not be surfaced as an API contract.
    code: typeof error.code === 'string' ? error.code : undefined,
    message: error.message || 'Internal server error',
    details: error instanceof ApiError ? error.details : undefined,
  });
};
