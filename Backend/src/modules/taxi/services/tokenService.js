import jwt from 'jsonwebtoken';
import { env } from '../../../config/env.js';
import { ApiError } from '../../../utils/ApiError.js';

export const signAccessToken = ({ sub, role }) =>
  jwt.sign({ role }, env.jwtSecret, {
    subject: sub,
    expiresIn: env.jwtExpiresIn,
  });

export const verifyAccessToken = (token) => {
  try {
    return jwt.verify(token, env.jwtSecret);
  } catch (error) {
    if (error?.name === 'TokenExpiredError') {
      throw new ApiError(401, 'jwt expired');
    }

    if (error?.name === 'JsonWebTokenError' || error?.name === 'NotBeforeError') {
      throw new ApiError(401, 'Invalid authorization token');
    }

    throw error;
  }
};
