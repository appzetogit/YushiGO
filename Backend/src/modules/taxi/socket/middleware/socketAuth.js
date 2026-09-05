import { ApiError } from '../../../../utils/ApiError.js';
import { User } from '../../user/models/User.js';
import { verifyAccessToken } from '../../services/tokenService.js';
import { authorizeShareViewer } from '../../studentRide/socket/studentRideSocketHandler.js';

export const getIdentityFromSocket = (socket) => {
  const token = socket.handshake.auth?.token;

  if (!token) {
    throw new ApiError(401, 'Socket token is required');
  }

  return verifyAccessToken(token);
};

export const attachSocketAuth = (io) => {
  io.use(async (socket, next) => {
    try {
      /**
       * A guardian opening a forwarded student-ride link has no account, so the
       * share token stands in for a JWT. It is resolved to exactly one ride and
       * grants nothing else — connection.js registers only the watch-only
       * handlers for this role.
       */
      const shareToken = socket.handshake.auth?.shareToken;

      if (shareToken) {
        socket.auth = await authorizeShareViewer(shareToken);
        next();
        return;
      }

      socket.auth = getIdentityFromSocket(socket);

      if (socket.auth.role === 'user') {
        const user = await User.findById(socket.auth.sub).select('active isActive deletedAt').lean();

        if (!user || user.deletedAt || user.isActive === false || user.active === false) {
          throw new ApiError(401, 'User account is not active');
        }
      }

      next();
    } catch (error) {
      next(error);
    }
  });
};
