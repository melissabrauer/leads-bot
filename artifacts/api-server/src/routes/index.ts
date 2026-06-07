import { Router, type IRouter } from "express";
import healthRouter from "./health";
import cryptoWebhookRouter from "./cryptoWebhook";

const router: IRouter = Router();

router.use(healthRouter);
router.use(cryptoWebhookRouter);

export default router;
