import { Router } from 'express';
import { carpoolRouter } from './carpoolRoutes.js';

export const carpoolModuleRouter = Router();

carpoolModuleRouter.use(carpoolRouter);
