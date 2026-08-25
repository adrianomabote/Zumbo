import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ussdAgentRouter from "./ussd-agent";
import pagarRouter from "./pagar";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ussdAgentRouter);
router.use(pagarRouter);

export default router;
