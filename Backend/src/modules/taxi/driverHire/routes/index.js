import { Router } from 'express';
import { driverHireRouter } from './driverHireRoutes.js';

export const driverHireModuleRouter = Router();

driverHireModuleRouter.use(driverHireRouter);
