import { Router } from 'express';
import { studentRideRouter } from './studentRideRoutes.js';

export const studentRideModuleRouter = Router();

studentRideModuleRouter.use(studentRideRouter);
