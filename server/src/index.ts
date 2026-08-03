import "dotenv/config";
import express, { type Request, type Response } from "express";
import { accountsRouter } from "./routes/accounts.js";
import { peopleRouter } from "./routes/people.js";
import { recordingsRouter } from "./routes/recordings.js";
import { transcriptRouter } from "./routes/transcript.js";
import { momentsRouter } from "./routes/moments.js";
import { errorHandler } from "./lib/http.js";

const app = express();

app.use(express.json({ limit: "16mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.use("/accounts", accountsRouter);
app.use("/accounts/:accountId/people", peopleRouter);
app.use("/accounts/:accountId/recordings", recordingsRouter);
app.use("/accounts/:accountId/moments", momentsRouter);
app.use("/", transcriptRouter);

app.use(errorHandler);

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`Clipwise server listening on port ${port}`);
});
