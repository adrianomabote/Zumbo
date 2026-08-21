import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ussdAgentRouter from "./ussd-agent";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ussdAgentRouter);

export default router;
